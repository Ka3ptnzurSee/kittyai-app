import Constants from "expo-constants";

/**
 * Globaler Crash-Handler (Telemetrie).
 *
 * Der bisherige Weg (reportClientError in App.tsx) meldet NUR Fehlerkarten,
 * die das UI bewusst anzeigt ("Netzwerk unterbrochen", "Nicht gesendet", …).
 * Echte Prozess-Crashes — unbehandelte JS-Exceptions, die die App zum Absturz
 * bringen — kamen nie an, weil dafür kein globaler Handler installiert war.
 *
 * Dieser Handler fängt unbehandelte JS-Fehler über ErrorUtils.setGlobalHandler
 * und meldet sie an /api/client-error mit kind="js_crash". Es gehen NUR
 * Kategorie, App-Version und die Fehlermeldung raus — kein Nachrichtentext,
 * keine Chat-Inhalte. (Native NSException-Crashes bräuchten zusätzlich ein
 * natives Modul wie Sentry — bewusst nicht eingebunden, um den Build nicht
 * mit einer veralteten Native-Dependency zu gefährden.)
 */

const APP_VERSION = `${Constants.expoConfig?.version || "?"}+${Constants.expoConfig?.ios?.buildNumber || "?"}`;

let installed = false;
let getBaseFn: (() => string) | null = null;
let getTokenFn: (() => string) | null = null;
let prevHandler: ((error: unknown, isFatal?: boolean) => void) | null = null;

/**
 * Secrets/PII aus Fehlertexten entfernen, bevor sie das Gerät verlassen.
 * Review-Fund 23.11.2026: Fehlermeldungen enthalten teils Server-Antworten mit URLs
 * (inkl. Query-Parametern) oder langen Tokens — die haben in der Telemetrie nichts zu suchen.
 */
function redigiere(text: string): string {
  return String(text || "")
    .replace(/https?:\/\/\S+/gi, "#url")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "#tok");
}

/** Header für Telemetrie — Token nur mitsenden, wenn die App eins hat. */
function telemetrieHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const token = getTokenFn ? getTokenFn() : "";
    if (token) headers["X-API-Token"] = token;
  } catch {
    /* ohne Token senden ist besser als gar nicht melden */
  }
  return headers;
}

/**
 * Einmal-Guard: dieselbe Meldung (Bereich + Text) nur EINMAL pro App-Lauf senden.
 * Ohne das postet jedes „Erneut versuchen" und jedes FlatList-Remount denselben Fehler erneut.
 */
const bereitsGemeldet = new Set<string>();
function einmalig(schluessel: string): boolean {
  if (bereitsGemeldet.has(schluessel)) return false;
  if (bereitsGemeldet.size > 200) bereitsGemeldet.clear();
  bereitsGemeldet.add(schluessel);
  return true;
}

function report(detail: string, fatal: boolean): void {
  try {
    const base = (getBaseFn ? getBaseFn() : "https://hashtagweinboehla.de/kittyai").replace(/\/+$/, "");
    if (!base) return;
    const text = `${fatal ? "fatal " : ""}${redigiere(detail)}`.slice(0, 160);
    if (!einmalig(`js|${text}`)) return;
    fetch(`${base}/api/client-error`, {
      method: "POST",
      headers: telemetrieHeaders(),
      body: JSON.stringify({
        kind: "js_crash",
        source: "global",
        phase: "app",
        chatId: "",
        appVersion: APP_VERSION,
        detail: text,
      }),
    }).catch(() => {
      /* Telemetrie darf nie stören */
    });
  } catch {
    /* ignorieren */
  }
}

/**
 * Fehler kompakt für die Telemetrie beschreiben (max. 160 Zeichen):
 * Meldung + erster Stack-Frame (der Ort) — bewusst ohne Nachrichtentexte.
 */
export function beschreibeFehler(error: unknown): string {
  try {
    const e = error as { message?: string; stack?: string };
    const msg = e && typeof e.message === "string" ? e.message : String(error);
    const stack = e && typeof e.stack === "string" ? e.stack : "";
    const line = stack.split("\n").filter(Boolean)[1] || "";
    return redigiere(`${msg} | ${line}`).slice(0, 160);
  } catch {
    return "unbekannter Fehler";
  }
}

/** Beliebigen Render-Fehler melden (ErrorBoundary) — Kategorie + Ort, kein Inhalt. */
export function meldeRenderFehler(detail: string, bereich: string): void {
  try {
    const base = (getBaseFn ? getBaseFn() : "https://hashtagweinboehla.de/kittyai").replace(/\/+$/, "");
    if (!base) return;
    const ort = String(bereich || "unbekannt").slice(0, 40);
    const text = redigiere(detail).slice(0, 160);
    if (!einmalig(`render|${ort}|${text}`)) return;
    fetch(`${base}/api/client-error`, {
      method: "POST",
      headers: telemetrieHeaders(),
      body: JSON.stringify({
        kind: "render_crash",
        source: "boundary",
        phase: ort,
        chatId: "",
        appVersion: APP_VERSION,
        detail: text,
      }),
    }).catch(() => {
      /* Telemetrie darf nie stören */
    });
  } catch {
    /* ignorieren */
  }
}

function handler(error: unknown, isFatal?: boolean): void {
  report(beschreibeFehler(error), Boolean(isFatal));
  // Original-Verhalten (RedBox im Dev, Absturz in Prod) NICHT unterdrücken.
  if (prevHandler) {
    try {
      prevHandler(error, isFatal);
    } catch {
      /* ignorieren */
    }
  }
}

/**
 * Einmal beim App-Start aufrufen (bevor UI gerendert wird). getBase liefert die
 * aktuelle Server-Basis-URL (detectBase), damit der Crash auch bei geändertem
 * Server-Ziel ankommt.
 */
export function installGlobalErrorHandlers(getBase?: () => string, getToken?: () => string): void {
  if (getBase) getBaseFn = getBase;
  if (getToken) getTokenFn = getToken;
  if (installed) return;
  installed = true;

  const g = globalThis as unknown as {
    ErrorUtils?: {
      setGlobalHandler?: (h: (error: unknown, isFatal?: boolean) => void) => void;
      getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | null;
    };
  };
  const ErrorUtils = g.ErrorUtils;
  if (ErrorUtils && typeof ErrorUtils.setGlobalHandler === "function") {
    prevHandler = ErrorUtils.getGlobalHandler ? ErrorUtils.getGlobalHandler() : null;
    ErrorUtils.setGlobalHandler(handler);
  }
}
