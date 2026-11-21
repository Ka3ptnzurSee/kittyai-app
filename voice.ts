/**
 * voice.ts - Kleine Helfer fuer den Sprache-zu-Sprache-Modus (Freisprechen).
 *
 * Enthaelt bewusst KEINE UI: nur den Satz-Splitter (damit die Sprachausgabe
 * schon startet, waehrend die Antwort noch streamt) und einen Mini-Event-Bus,
 * ueber den App.tsx die Text-Deltas des Chats an den Sprachmodus weiterreicht.
 */

/**
 * iOS-Sprachstack: Codes, die eine Session BEENDEN (Limit/Teardown), keine
 * Nutzerfehler. expo-speech-recognition 57.1.1 mappt diese Codes nicht und
 * schickt sie als generisches "audio-capture" mit roher NSError-Beschreibung
 * durch -> im Chat stand dann z. B.
 *   "The operation couldn't be completed. (kAFAssistantErrorDomain error 216.)"
 * 209/216 = Session-Ende/Teardown (nach stop(), bei ~60-s-Limit oder wenn eine
 * neue Session zu frueh startet), 1100 = alte Instanz noch aktiv, 1101/1107 =
 * Verbindung zum Sprachprozess weg, 203 = Retry, 1110 = keine Sprache.
 */
const SPEECH_LIFECYCLE_ERRORS = new Set([
  "no-speech",
  "aborted",
  "busy",
  "interrupted",
  "language-not-supported",
]);
const SPEECH_LIFECYCLE_CODE_RE = /kAFAssistantErrorDomain error (203|209|216|1100|1101|1107|1110)\b/;
const SPEECH_LIFECYCLE_TEXT_RE = /(recognition request was canceled|request was canceled|retry)/i;

/**
 * Ist das ein normales Session-Ende (kein anzuzeigender Fehler)?
 * Robust gegen fehlende/kaputte Event-Objekte (Fehlerobjekt kann null sein).
 */
export function isSpeechSessionEnd(event: { error?: string; message?: string } | null | undefined): boolean {
  if (!event || typeof event !== "object") return true; // nichts Brauchbares -> nicht anzeigen
  const code = String(event.error ?? "").toLowerCase();
  const message = String(event.message ?? "");
  if (SPEECH_LIFECYCLE_ERRORS.has(code)) return true;
  if (SPEECH_LIFECYCLE_CODE_RE.test(message)) return true;
  if (SPEECH_LIFECYCLE_TEXT_RE.test(message)) return true;
  return false;
}

/**
 * Anzeigetext fuer einen ECHTEN Fehler (Berechtigung, Netz, Mikrofon) — oder
 * null, wenn es nur ein Session-Ende war und nichts angezeigt werden soll.
 */
export function speechErrorText(event: { error?: string; message?: string } | null | undefined): string | null {
  if (isSpeechSessionEnd(event)) return null;
  const msg = String(event?.message ?? "").trim();
  const code = String(event?.error ?? "").trim();
  if (msg) return msg;
  if (code) return code;
  // Leeres/kaputtes Event: nichts Erkennbares -> keinen "unbekannt"-Text zeigen
  return null;
}

/**
 * Pause vor dem naechsten start(): der AFAssistant-Prozess braucht nach stop()
 * rund eine Sekunde. Bei 350 ms kam regelnmaessig 216/1100 zurueck.
 */
export const SPEECH_RESTART_MS = 900;

/** iOS beendet Dauer-Sessions nach ~60 s — vorher selbst abschliessen. */
export const SPEECH_SESSION_CAP_MS = 50000;

/** Erkennungssprache des Diktats (KittyAI-Oberflaeche ist deutsch). */
export const SPEECH_LANG = "de-DE";

/** Kuerzere Sprech-Einheiten werden mit der naechsten verschmolzen. */
export const SPEECH_MIN_UNIT = 48;
/** Deckel, damit eine Einheit nicht beliebig waechst. */
export const SPEECH_MAX_UNIT = 200;

/**
 * Verschmilzt aufeinanderfolgende Sprech-Einheiten, solange sie kuerzer als
 * SPEECH_MIN_UNIT sind (Edge-TTS hat ~0,53 s Festkosten pro Request: TCP/TLS +
 * WebSocket-Handshake). Leere Einheiten fallen weg, MAX_UNIT wird nie
 * ueberschritten.
 */
export function coalesceForSpeech(units: string[]): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (const raw of units || []) {
    const next = String(raw == null ? "" : raw).trim();
    if (!next) continue; // leere Einheiten weg (nie Inhalt verwerfen)
    if (cur === null) {
      cur = next;
      continue;
    }
    if (cur.length < SPEECH_MIN_UNIT && cur.length + 1 + next.length <= SPEECH_MAX_UNIT) {
      cur = cur + " " + next;
    } else {
      out.push(cur);
      cur = next;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Wird von App.tsx gefuettert, vom Sprachmodus gelesen. */
export const voiceHooks: {
  delta?: (text: string) => void;
  done?: (full: string) => void;
  /** Turn fehlgeschlagen / kein Text -> Sprachmodus darf nicht stumm bleiben. */
  error?: (msg: string) => void;
} = {};

/** Markdown/Rauschen entfernen - vorgelesen wird nur sprechbarer Text. */
export function cleanForSpeech(input: string): string {
  return String(input || "")
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // nackte URLs/Dateipfade werden sonst Buchstabe fuer Buchstabe vorgelesen
    .replace(/\bhttps?:\/\/\S+/gi, " Link ")
    .replace(/\bwww\.\S+/gi, " Link ")
    // Emoji/Symbole: die Stimme liest sie als Namen vor ("Smiling Face")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^\s*[-*+>]\s+/gm, " ")
    .replace(/[*_~#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const ABBREV = /(?:\b(?:z\.\s?B|u\.\s?a|d\.\s?h|bzw|ca|etc|Dr|Prof|Nr|vgl|inkl|max|min|Abb|Str|Tel|evtl|ggf|sog|usw)\.)$/i;

/** Monatsnamen: nach "21." folgt oft ein Datum, kein neuer Satz. */
const MONTH = /^(?:Januar|Februar|M\u00e4rz|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\b/i;
/** "21." / "1." = Ordnungszahl (Datum, Platzierung), kein Satzende. */
const ORDINAL_END = /\b\d{1,2}\.$/;
/** Ein Buchstabe + Punkt = Initiale ("P. Heinemann"). */
const INITIAL_END = /(?:^|\s)[A-Za-z\u00c4\u00d6\u00dc\u00e4\u00f6\u00fc]\.$/;

/** Lange Saetze an Wortgrenzen aufteilen - kurze Stuecke sprechen frueher los.
 *  Bewusst ohne Lookbehind: Hermes (React Native) unterstuetzt das nicht. */
function splitLong(sentence: string, limit = 180): string[] {
  if (sentence.length <= limit) return [sentence];
  const words = sentence.split(" ");
  const parts: string[] = [];
  let current = "";
  for (const w of words) {
    if (current && current.length + 1 + w.length > limit) {
      parts.push(current);
      current = w;
    } else {
      current = current ? current + " " + w : w;
    }
  }
  if (current) parts.push(current);
  return parts.length ? parts : [sentence];
}

/**
 * Holt fertige Saetze aus dem Stream-Puffer.
 * force=true gibt am Ende auch den Rest aus (Turn beendet).
 */
export function takeSentences(buffer: string, force = false): { sentences: string[]; rest: string } {
  const raw = String(buffer || "");
  const sentences: string[] = [];
  let rest = raw;
  const re = /[.!?…]+["')\]»]*\s+/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = re.exec(raw))) {
    const end = match.index + match[0].length;
    const candidate = cleanForSpeech(raw.slice(lastEnd, end));
    if (candidate.length < 2) continue;
    const after = raw.slice(end);
    // Abkürzungen ("z. B.", "bzw.", "Dr.") sind kein Satzende -> Puffer weiterlaufen
    // lassen, sonst geht der Text zwischen zwei Abkürzungen verloren.
    if (ABBREV.test(candidate)) continue;
    if (INITIAL_END.test(candidate)) continue;
    // Datum/Uhrzeit/Ordinalzahl: "Samstag, der 21. November 2026" und "um 11. 30 Uhr"
    // sind EIN Satz. Ohne diese Sperre sagt die Stimme "... der einundzwanzig."
    // und beginnt dann neu mit "November ...".
    if (ORDINAL_END.test(candidate) && (MONTH.test(after.trimStart()) || /^\s*\d/.test(after))) continue;
    // Folgt ein klein geschriebenes Wort, war es kein Satzende ("... gibt's. der"
    // entsteht z. B. bei Aufzählungen). Satzanfänge sind im Deutschen groß.
    if (/^\s*[a-zäöüß]/.test(after)) continue;
    sentences.push(candidate);
    lastEnd = end;
  }
  rest = raw.slice(lastEnd);
  if (force) {
    const tail = cleanForSpeech(rest);
    if (tail) sentences.push(tail);
    rest = "";
  }
  const expanded: string[] = [];
  for (const s of sentences) expanded.push(...splitLong(s));
  return { sentences: expanded, rest };
}

