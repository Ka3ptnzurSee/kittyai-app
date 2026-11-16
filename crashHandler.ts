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
let prevHandler: ((error: unknown, isFatal?: boolean) => void) | null = null;

function report(detail: string, fatal: boolean): void {
  try {
    const base = (getBaseFn ? getBaseFn() : "https://hashtagweinboehla.de/kittyai").replace(/\/+$/, "");
    if (!base) return;
    fetch(`${base}/api/client-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "js_crash",
        source: "global",
        phase: "app",
        chatId: "",
        appVersion: APP_VERSION,
        detail: `${fatal ? "fatal " : ""}${detail}`.slice(0, 160),
      }),
    }).catch(() => {
      /* Telemetrie darf nie stören */
    });
  } catch {
    /* ignorieren */
  }
}

function handler(error: unknown, isFatal?: boolean): void {
  try {
    const e = error as { message?: string; stack?: string };
    const msg = e && typeof e.message === "string" ? e.message : String(error);
    const stack = e && typeof e.stack === "string" ? e.stack : "";
    // Meldung + kurzer Stack-Ausschnitt (erste Zeile = Ort des Fehlers).
    const line = stack.split("\n").filter(Boolean)[1] || "";
    report(`${msg} | ${line}`.slice(0, 160), Boolean(isFatal));
  } catch {
    /* ignorieren */
  }
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
export function installGlobalErrorHandlers(getBase?: () => string): void {
  if (getBase) getBaseFn = getBase;
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
