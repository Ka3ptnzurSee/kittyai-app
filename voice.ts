/**
 * voice.ts - Kleine Helfer fuer den Sprache-zu-Sprache-Modus (Freisprechen).
 *
 * Enthaelt bewusst KEINE UI: nur den Satz-Splitter (damit die Sprachausgabe
 * schon startet, waehrend die Antwort noch streamt) und einen Mini-Event-Bus,
 * ueber den App.tsx die Text-Deltas des Chats an den Sprachmodus weiterreicht.
 */

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
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/^\s*[-*+]\s+/gm, " ")
    .replace(/[*_~#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const ABBREV = /(?:\b(?:z\.\s?B|u\.\s?a|d\.\s?h|bzw|ca|etc|Dr|Prof|Nr|vgl|inkl|max|min)\.)$/i;

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
    // Abkürzungen ("z. B.", "bzw.", "Dr.") sind kein Satzende -> Puffer weiterlaufen
    // lassen, sonst geht der Text zwischen zwei Abkürzungen verloren.
    if (ABBREV.test(candidate)) continue;
    if (/(?:^|\s)[A-Za-zÄÖÜäöü]\.$/.test(candidate)) continue;
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

