import Constants from "expo-constants";
import { redigiere } from "./lib";

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
 * Origin, an die das Geräte-Token gehen darf. `serverUrl` kommt aus `detectBase()` und kann
 * über `Constants.expoConfig.hostUri` auf einen Expo-/ngrok-Tunnel zeigen — dorthin darf
 * das Token NICHT (Review-Fund 23.11.2026).
 */
const TOKEN_ORIGIN = "https://hashtagweinboehla.de";

/** Header für Telemetrie — Token nur mitsenden, wenn die App eins hat UND der Origin passt. */
function telemetrieHeaders(base: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const token = getTokenFn ? getTokenFn() : "";
    let originPasst = false;
    try {
      originPasst = new URL(base).origin === TOKEN_ORIGIN;
    } catch {
      originPasst = false;
    }
    if (token && originPasst) headers["X-API-Token"] = token;
  } catch {
    /* ohne Token senden ist besser als gar nicht melden */
  }
  return headers;
}

/**
 * Einmal-Guard: dieselbe Meldung (Bereich + Text) nur EINMAL pro App-Lauf senden.
 * Ohne das postet jedes „Erneut versuchen" und jedes FlatList-Remount denselben Fehler erneut.
 *
 * Der Schlüssel wird erst NACH einer erfolgreichen Antwort gemerkt — sonst gilt eine
 * offline/401/500 verschluckte Meldung als gesendet und geht endgültig verloren.
 * Zusätzlich harter Deckel pro App-Lauf gegen Fehlerstürme.
 */
const bereitsGemeldet = new Set<string>();
/** Gerade unterwegs — verhindert doppelte POSTs für denselben Fehler im selben Flug. */
const unterwegs = new Set<string>();
const MAX_SENDS = 20;
let sends = 0;

/**
 * Zählt nur ERFOLGREICH gesendete Meldungen. Vorher zählte der Zähler Versuche: 20
 * fehlgeschlagene POSTs (App startet offline) erschöpften das Budget für den ganzen Lauf,
 * ein echter fataler Crash danach ging verloren (Review-Fund 23.11.2026).
 */
function darfSenden(schluessel: string): boolean {
  if (bereitsGemeldet.has(schluessel) || unterwegs.has(schluessel) || sends >= MAX_SENDS) return false;
  unterwegs.add(schluessel);
  return true;
}

function alsGesendetMerken(schluessel: string): void {
  unterwegs.delete(schluessel);
  sends += 1;
  // LRU statt clear(): bei vielen verschiedenen Texten würde ein clear() die Dedup komplett
  // verlieren und jeden Fehler erneut posten. Schwelle = MAX_SENDS, weil mehr Schlüssel
  // ohnehin nie gemerkt werden können.
  if (bereitsGemeldet.size >= MAX_SENDS) {
    const aeltester = bereitsGemeldet.values().next().value;
    if (aeltester) bereitsGemeldet.delete(aeltester);
  }
  bereitsGemeldet.add(schluessel);
}

/** Fehlversuch: Schlüssel wieder freigeben, damit ein späterer Versuch es noch schafft. */
function alsFehlgeschlagenMerken(schluessel: string): void {
  unterwegs.delete(schluessel);
}

function starteMeldung(base: string, koerper: Record<string, unknown>, schluessel: string): void {
  fetch(`${base}/api/client-error`, {
    method: "POST",
    headers: telemetrieHeaders(base),
    body: JSON.stringify(koerper),
  })
    .then((res) => {
      if (res && res.ok) alsGesendetMerken(schluessel);
      else alsFehlgeschlagenMerken(schluessel);
    })
    .catch(() => {
      /* Telemetrie darf nie stören — aber der Schlüssel bleibt nicht als "unterwegs" hängen */
      alsFehlgeschlagenMerken(schluessel);
    });
}

function report(detail: string, fatal: boolean): void {
  try {
    const base = (getBaseFn ? getBaseFn() : "https://hashtagweinboehla.de/kittyai").replace(/\/+$/, "");
    if (!base) return;
    const text = `${fatal ? "fatal " : ""}${redigiere(detail)}`.slice(0, 160);
    const schluessel = `js|${text}`;
    if (!darfSenden(schluessel)) return;
    starteMeldung(
      base,
      {
        kind: "js_crash",
        source: "global",
        phase: "app",
        chatId: "",
        appVersion: APP_VERSION,
        detail: text,
      },
      schluessel,
    );
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
    const schluessel = `render|${ort}|${text}`;
    if (!darfSenden(schluessel)) return;
    starteMeldung(
      base,
      {
        kind: "render_crash",
        source: "boundary",
        phase: ort,
        chatId: "",
        appVersion: APP_VERSION,
        detail: text,
      },
      schluessel,
    );
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
    // Erst NACH erfolgreicher Installation markieren: fehlt ErrorUtils beim ersten Aufruf
    // (z. B. sehr früher Start), darf ein späterer Aufruf es erneut versuchen.
    installed = true;
  }
}
