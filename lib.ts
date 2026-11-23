// Reine, RN-unabhängige Helfer – extrahiert, damit sie ohne Expo getestet werden können.

// Kleiner inkrementeller UTF-8-Decoder (kein globaler TextDecoder nötig).
export class Utf8Decoder {
  private pending: number[] = [];
  private expected = 0;

  decode(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (this.expected === 0) {
        if (b < 0x80) out += String.fromCharCode(b);
        else if ((b >> 5) === 0b110) { this.pending = [b]; this.expected = 1; }
        else if ((b >> 4) === 0b1110) { this.pending = [b]; this.expected = 2; }
        else if ((b >> 3) === 0b11110) { this.pending = [b]; this.expected = 3; }
        else out += "\uFFFD";
      } else {
        this.pending.push(b);
        this.expected--;
        if (this.expected === 0) out += this.flush();
      }
    }
    return out;
  }

  private flush(): string {
    const p = this.pending;
    this.pending = [];
    let cp: number;
    if (p.length === 2) cp = ((p[0] & 0x1f) << 6) | (p[1] & 0x3f);
    else if (p.length === 3) cp = ((p[0] & 0x0f) << 12) | ((p[1] & 0x3f) << 6) | (p[2] & 0x3f);
    else cp = ((p[0] & 0x07) << 18) | ((p[1] & 0x3f) << 12) | ((p[2] & 0x3f) << 6) | (p[3] & 0x3f);
    if (cp > 0xffff) {
      cp -= 0x10000;
      return String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
    return String.fromCharCode(cp);
  }
}

export function argSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  if (typeof a.command === "string") return breakLongLines(a.command.slice(0, 400)).split("\n")[0];
  if (typeof a.path === "string") return breakLongLines(a.path.slice(0, 400)).split("\n")[0];
  if (typeof a.url === "string") return a.url.slice(0, 200);
  const keys = Object.keys(a);
  if (keys.length) {
    const v = a[keys[0]];
    if (typeof v === "string") return v.slice(0, 60);
    return keys[0];
  }
  return "";
}

// Überlange Zeilen OHNE Umbruch (minifiziertes JS, Roh-Binärdumps, Base64,
// Zahlen-Arrays aus RE-Ausgaben) brechen iOS-Layout: Eine einzige Zeile mit
// 4000+ Zeichen erzeugt eine intrinsische Breite von ~25.000pt und lässt die
// FlatList-Zelle als „unendlich langen weißen Balken" aufplatzen. Deshalb:
// Steuerzeichen + ANSI-Sequenzen entfernen, lange Läufe in Blöcke zerlegen.

// Entfernt Steuerzeichen UND ANSI-Escape-Sequenzen (CSI-Farben/Cursor + OSC-Terminal-Reports/Hyperlinks).
function stripControl(s: string): string {
  return s
    // OSC: ESC ] … BEL bzw. ST (iTerm2-Reports wie ]9;4;…#16a34a, Hyperlinks, Terminal-Titel)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // CSI: ESC [ params Abschlussbuchstabe (SGR-Farben, Cursor)
    .replace(/\u001b\[[0-9;:?]*[a-zA-Z]/g, "")
    // verbleibende Steuerzeichen
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function breakRun(run: string, max: number): string {
  const parts: string[] = [];
  for (let i = 0; i < run.length; i += max) parts.push(run.slice(i, i + max));
  return parts.join("\n");
}

// Harte Variante (für vorformatierten Text: Tool-Ergebnisse, Code-Blöcke):
// bricht JEDE Zeile ab `max` Zeichen.
export function breakLongLines(s: string, max = 120): string {
  return stripControl(s)
    .split("\n")
    .map((line) => (line.length <= max ? line : breakRun(line, max)))
    .join("\n");
}

// Weiche Variante (für Fließtext): bricht NUR unbrechbare Läufe (ohne Whitespace)
// ab `max` Zeichen; normale Prosa mit Leerzeichen bleibt unangetastet.
export function breakUnbreakable(s: string, max = 120): string {
  const clean = stripControl(s);
  const re = new RegExp(`[^\\s]{${max + 1},}`, "g");
  return clean.replace(re, (run) => breakRun(run, max));
}

// ── Layout-Schutz gegen „unendlich lange weiße Balken" ─────────────────────
// Ein einzelner Message-Block, der höher rendert als ein paar Bildschirme, macht
// die FlatList unscrollbar: er schiebt alles andere weg und zeigt nur noch leere
// Fläche („keine Nachrichten mehr lesbar"). Deshalb wird JEDE Blase gemessen und
// oberhalb der Grenze eingeklappt (aufklappbar) — egal WELCHE Daten sie aufblähen.
export const MAX_BUBBLE_PT = 12_000; // Sicherheitsnetz (~250–400 Zeilen) — erst GANZ oben einklappen
export const BUBBLE_PREVIEW_PT = 1200; // eingeklappte Höhe, wenn eine Blase wirklich zu groß ist
/** Ab dieser Textlänge wird eine Antwort eingeklappt (12000 Z ≈ 250 Zeilen ≈ 3–4 Displays).
 *  Darunter wird IMMER vollständig gerendert — der frühere 6000-pt-Deckel hat normale
 *  lange Antworten (9000 Z) ohne echten Grund abgeschnitten. */
export const MAX_INLINE_TEXT_CHARS = 12_000;
/** Sichtbarer Hinweis am Ende einer eingeklappten Blase (kein kommentarloser Schnitt). */
export const COLLAPSED_HINT = "… gekürzt – tippen für volle Antwort";

/** Ist die gemessene Höhe so groß, dass sie den Chat unlesbar macht? */
export function tooTall(height: number, limit = MAX_BUBBLE_PT): boolean {
  const n = Number(height);
  return Number.isFinite(n) && n > limit;
}

/**
 * Soll diese Blase eingeklappt werden?
 * Früher: nur Höhe > 6000 pt (>6000 Z) → eingeklappt auf 1200 pt mit `overflow:hidden`,
 * also ein harter Schnitt mitten im Text. Jetzt: erst oberhalb von `MAX_INLINE_TEXT_CHARS`
 * Zeichen (oder wenn ein Datenblock das Höhen-Sicherheitsnetz sprengt).
 */
export function shouldCollapseBubble(text: string, height = 0): boolean {
  if (String(text ?? "").length > MAX_INLINE_TEXT_CHARS) return true;
  return tooTall(height);
}

/**
 * Langen Leerzeilen-Lauf zusammenfassen. Hunderte Leerzeilen (z. B. aus einer
 * kaputten Tool-Ausgabe) rendern als riesige leere Fläche, obwohl „nichts" da ist.
 * Normale Formatierung (bis `max` Zeilen) bleibt unverändert.
 */
export function normalizeBlankRuns(s: string, max = 6): string {
  const clean = stripControl(s);
  const n = Math.max(1, Math.min(20, Math.floor(Number(max)) || 6));
  return clean.replace(new RegExp(`\\n{${n + 1},}`, "g"), "\n".repeat(n));
}

/**
 * ```dil```-Fences (JSON-Widgets) aus einem Text entfernen — übrig bleibt nur die
 * Prosa. Damit lässt sich unterscheiden, ob eine Nachricht ÜBERHAUPT etwas
 * Sichtbares enthält (die Widgets werden separat gerendert).
 */
export function stripDilFences(text: string): string {
  return String(text ?? "").replace(/```dil\b[^\n]*\n?([\s\S]*?)```/g, "");
}

/**
 * Leere KI-Nachricht = „weißer Balken": kein sichtbarer Text (DIL-Fences zählen
 * NICHT — sie werden als Widget separat gerendert), keine Widgets, keine Bilder,
 * kein Fehler, keine Werkzeug-/Freigabe-Karten. Genau dieselbe Regel nutzen
 * Chat-Öffnen und Turn-Ende, damit sich nichts widerspricht.
 */
export function isBlankAiMessage(m: {
  role?: string;
  text?: string | null;
  dil?: unknown;
  images?: unknown;
  error?: unknown;
  activity?: unknown;
  permissions?: unknown;
}): boolean {
  if (!m || m.role !== "assistant") return false;
  if (m.error) return false;
  if (Array.isArray(m.dil) && m.dil.length > 0) return false;
  if (Array.isArray(m.images) && m.images.length > 0) return false;
  if (Array.isArray(m.activity) && m.activity.length > 0) return false;
  if (Array.isArray(m.permissions) && m.permissions.length > 0) return false;
  return !stripDilFences(m.text || "").trim();
}

/**
 * Nachrichten aus dem Speicher fuer die Anzeige aufbereiten.
 *
 * Gespeicherte Fehlerkarten werden verworfen: Sie sind die Momentaufnahme eines
 * Turns, der beim naechsten App-Start ohnehin nicht mehr laeuft. Ohne diesen
 * Schritt blieb JEDER einmal fehlgeschlagene Chat fuer immer rot (das `error`-Flag
 * wurde mitpersistiert) und der Auto-Resume uebersprang ihn — die Antwort wurde
 * nie nachgeladen. Danach werden leere KI-Bubbles entfernt; `anchorId` ist die
 * letzte leere Bubble, an der ein Resume haengen bleiben darf.
 */
export function sanitizeLoadedMessages<T extends { id?: string; role?: string; error?: unknown }>(
  messages: T[],
  anchorId: string | null = null,
): T[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => (m && m.role === "assistant" && m.error ? ({ ...m, error: undefined } as T) : m))
    .filter((m) => !isFallbackReply((m as { text?: string })?.text))
    .filter((m) => !isBlankAiMessage(m) || m?.id === anchorId);
}

/**
 * Fehler-Flags aus einem Verlauf entfernen, ohne Text zu verlieren.
 *
 * Anders als sanitizeLoadedMessages (Start) wird hier nichts gefiltert: eine
 * Teil-Antwort mit Fehlerkarte bleibt als Text stehen, nur die rote Karte faellt weg.
 * Genutzt (a) beim Speichern — der Store enthaelt nie Fehlerkarten — und (b) wenn ein
 * neuer Turn startet, weil der alte Fehler dann ueberholt ist.
 */
export function stripErrorFlags<T extends { error?: unknown }>(messages: T[]): T[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => (m && m.error ? ({ ...m, error: undefined } as T) : m));
}

/**
 * Notausgang-Texte des Servers (lib.js: emptyReplyFallback) erkennen.
 *
 * Wenn das Modell einen Turn ohne Text-Block beendet, schickt der Server statt einer
 * leeren Bubble einen Hinweis wie "Fertig — das Modell hat eine leere Antwort
 * geliefert. Bitte erneut senden." Diese Nachricht ist KEIN Fehler-Flag und wurde
 * deshalb als normaler Chat-Text gespeichert — sie blieb fuer immer im Verlauf.
 */
export function isFallbackReply(text: string | undefined | null): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    t.startsWith("Fertig — das Modell hat eine leere Antwort geliefert") ||
    t.startsWith("Fertig – das Modell hat eine leere Antwort geliefert") ||
    t.startsWith("Fertig — es kam keine Textantwort vom Modell") ||
    t.startsWith("Fertig – es kam keine Textantwort vom Modell")
  );
}

// ── Tool-Berechtigungskarten: menschliche Namen + Icons für pi-Werkzeuge ──
export type ToolCategory = "system" | "file" | "web" | "memory" | "search" | "agent" | "calendar" | "github" | "media" | "other";
export type ToolMeta = { label: string; icon: string; category: ToolCategory };

const TOOL_META: Record<string, ToolMeta> = {
  // System / Shell
  bash: { label: "Befehl", icon: "⌘", category: "system" },
  // Dateien
  read: { label: "Datei lesen", icon: "¶", category: "file" },
  write: { label: "Datei schreiben", icon: "✎", category: "file" },
  edit: { label: "Datei bearbeiten", icon: "✏", category: "file" },
  // Web
  web_fetch: { label: "Webseite abrufen", icon: "◎", category: "web" },
  // GitHub
  github_read_repo: { label: "Repo ansehen", icon: "◈", category: "github" },
  github_create_issue: { label: "Issue anlegen", icon: "◈", category: "github" },
  // Gedächtnis
  memory_add: { label: "Merkzettel", icon: "◉", category: "memory" },
  memory_replace: { label: "Merkzettel ändern", icon: "◉", category: "memory" },
  memory_remove: { label: "Merkzettel löschen", icon: "◉", category: "memory" },
  memory_search: { label: "Gedächtnis durchsuchen", icon: "◉", category: "memory" },
  session_search: { label: "Verlauf durchsuchen", icon: "⌕", category: "search" },
  // Skills
  skill_search: { label: "Skill suchen", icon: "◆", category: "search" },
  skill_load: { label: "Skill laden", icon: "◆", category: "search" },
  skill_manage: { label: "Skill verwalten", icon: "◆", category: "search" },
  skill_fetch_online: { label: "Skill online suchen", icon: "◆", category: "search" },
  // Agenten
  subagent: { label: "Subagent", icon: "▣", category: "agent" },
  codemode: { label: "Codemode-Skript", icon: "▶", category: "agent" },
  // Kalender / Zeit
  time_now: { label: "Uhrzeit", icon: "◷", category: "calendar" },
  calendar_list_events: { label: "Kalender lesen", icon: "▤", category: "calendar" },
  calendar_create_event: { label: "Termin anlegen", icon: "▤", category: "calendar" },
  // Sonstiges
  git_status: { label: "Git-Status", icon: "⌘", category: "system" },
  email_send: { label: "E-Mail senden", icon: "◎", category: "web" },
};

/** Menschlich lesbare Beschreibung für ein pi-Werkzeug (mit Fallback). */
export function toolMeta(tool: string): ToolMeta {
  const exact = TOOL_META[tool];
  if (exact) return exact;
  if (tool.startsWith("memory_")) return { label: "Gedächtnis", icon: "◉", category: "memory" };
  if (tool.startsWith("calendar_")) return { label: "Kalender", icon: "▤", category: "calendar" };
  if (tool.startsWith("github_")) return { label: "GitHub", icon: "◈", category: "github" };
  if (tool.startsWith("skill_")) return { label: "Skill", icon: "◆", category: "search" };
  if (tool.startsWith("web_") || tool.startsWith("http")) return { label: "Web", icon: "◎", category: "web" };
  if (tool.startsWith("image") || tool.startsWith("tts") || tool.startsWith("stt")) return { label: tool, icon: "▢", category: "media" };
  return { label: tool, icon: "⌁", category: "other" };
}

/** Nur das Label (deutscher Name) für ein Tool – für kompakte Anzeige. */
export function toolLabel(tool: string): string {
  return toolMeta(tool).label;
}

// ── Permission-Engine: Freigabe-Karten für Tool-Aufrufe ──

export type PermissionStatus = "pending" | "allowed" | "denied";
export type PermissionRequest = {
  permissionId: string;
  turnId: string;
  tool: string;
  title: string;
  description: string;
  status: PermissionStatus;
};

type PermissionEventData = {
  permissionId?: string;
  turnId?: string;
  tool?: string;
  title?: string;
  description?: string;
  decision?: string;
};

/**
 * Wendet ein permission_required- bzw. permission_resolved-Event auf die
 * Freigabe-Liste einer Nachricht an. Rein & testbar (kein React, keine Seiteneffekte).
 *
 * - permission_required: fügt eine neue Karte hinzu (dedupliziert per permissionId).
 * - permission_resolved: setzt den Status auf "allowed"/"denied".
 * - alles andere: unverändert zurück.
 */
export function applyPermission(
  perms: PermissionRequest[] | undefined,
  type: string,
  data: unknown,
): PermissionRequest[] | undefined {
  const d = (data || {}) as PermissionEventData;
  if (type === "permission_required") {
    const permissionId = d.permissionId || "";
    if (!permissionId) return perms;
    const existing = perms || [];
    if (existing.some((p) => p.permissionId === permissionId)) return perms;
    return [
      ...existing,
      {
        permissionId,
        turnId: d.turnId || "",
        tool: d.tool || "?",
        title: d.title || "",
        description: d.description || "",
        status: "pending",
      },
    ];
  }
  if (type === "permission_resolved") {
    const permissionId = d.permissionId || "";
    const decision = d.decision === "allow" ? "allowed" : d.decision === "deny" || d.decision === "timeout" ? "denied" : null;
    if (!permissionId || !decision) return perms;
    const existing = perms || [];
    if (!existing.some((p) => p.permissionId === permissionId)) return perms;
    return existing.map((p) => (p.permissionId === permissionId ? { ...p, status: decision } : p));
  }
  return perms;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

/**
 * Relative Zeit für die Chat-Liste („vor 2 Std", „gestern", „vor 3 Tagen").
 * Absolute Uhrzeiten in der zweiten Zeile reichen nicht: bei 444 Chats sehen
 * viele Zeilen identisch aus — die relative Zeit trennt sie sichtbar.
 * `nowTs` ist injizierbar (Tests, stabile Ausgaben).
 */
export function relativeTime(ts: number, nowTs: number = Date.now()): string {
  if (!Number.isFinite(ts)) return "";
  const diff = nowTs - ts;
  if (diff < 60_000) return "gerade eben";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `vor ${min} Min`;
  const std = Math.floor(min / 60);
  if (std < 24) return `vor ${std} Std`;
  const tage = Math.floor(std / 24);
  if (tage === 1) return "gestern";
  if (tage < 30) return `vor ${tage} Tagen`;
  const d = new Date(ts);
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

// Eindeutige ID mit Zeitstempel + Zufall – verhindert Kollisionen,
// wenn mehrere Elemente in derselben Millisekunde erzeugt werden.
export function uid(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Routinen/Zeitpläne – Claude-iOS-Pendant („Routines“): 5-Feld-Cron
// (Minute Stunde TagImMonat Monat Wochentag; 0=Sonntag)
// ---------------------------------------------------------------------------

export type CronPreset = "hourly" | "daily" | "weekdays" | "weekend" | "weekly" | "monthly";

export const WEEKDAYS_DE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

/** Cron-Ausdruck aus einem Preset bauen. `time` = "HH:MM", `day` = 0..6 (0=So). */
export function presetCron(
  preset: CronPreset,
  opts?: { time?: string; day?: number; dayOfMonth?: number },
): string {
  const [h, m] = (opts?.time || "09:00").split(":").map((x) => Number(x) || 0);
  const hour = Math.min(23, Math.max(0, h));
  const minute = Math.min(59, Math.max(0, m));
  const day = Math.min(6, Math.max(0, opts?.day ?? 1));
  const dayOfMonth = Math.min(31, Math.max(1, opts?.dayOfMonth ?? 1));
  switch (preset) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekend":
      return `${minute} ${hour} * * 0,6`;
    case "weekly":
      return `${minute} ${hour} * * ${day}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    default:
      return `${minute} ${hour} * * *`;
  }
}

/** Lesbare deutsche Beschriftung für einen 5-Feld-Cron-Ausdruck. */
export function cronLabel(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, month, dow] = parts;
  const hh = hour.padStart(2, "0");
  const mm = min.padStart(2, "0");
  const time = `${hh}:${mm}`;
  const simple = /^\d+$/.test(min) && /^\d+$/.test(hour);
  if (min === "0" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "stündlich";
  if (!simple) return cron;
  if (dom === "*" && month === "*" && dow === "*") return `täglich um ${time}`;
  if (dom === "*" && month === "*" && dow === "1-5") return `wochentags um ${time}`;
  if (dom === "*" && month === "*" && (dow === "0,6" || dow === "6,0")) return `am Wochenende um ${time}`;
  if (dom === "*" && month === "*" && /^[0-6]$/.test(dow)) return `jeden ${WEEKDAYS_DE[Number(dow)]} um ${time}`;
  if (dom !== "*" && month === "*" && dow === "*" && /^\d+$/.test(dom)) return `monatlich am ${dom}. um ${time}`;
  return cron;
}

// ---------------------------------------------------------------------------
// SSE-Parser (robust) – für den Chat-Stream vom Backend.
//
// Der Server sendet `data: {json}\n\n` (ein Event pro Block). Ein naiver
// `buffer.indexOf("\n\n")`-Parser bricht bei drei Dingen:
//   1. Proxys/HTTP können `\r\n` liefern → Delimiter wird nie gefunden.
//   2. `data:` darf laut SSE-Standard mehrzeilig sein → nur die erste Zeile zählt.
//   3. Ein hängendes Event ohne finales `\n\n` (Stream-Ende) geht verloren.
// Diese Klasse behandelt alle drei plus Puffer-Deckelung (kein stilles
// Verwerfen von Chunks, kein unbegrenztes Puffer-Wachstum).
// ---------------------------------------------------------------------------

/** Obergrenze für ein einzelnes SSE-Event. Der Server schickt die komplette Antwort
 *  (Snapshot) + alle Tool-Karten + alle DIL-Widgets in EINEM `done`-Event — gemessen
 *  bis 135 KB (148 Tool-Calls). Bei 64 KB wurde so ein Event stillschweigend
 *  verworfen: Antwort/Bilder/Diagramme fehlten dann ohne jede Fehlermeldung.
 *  4 MB ist reichlich Luft, begrenzt aber weiterhin pathologische Events. */
const MAX_EVENT_CHARS = 4 * 1024 * 1024;

/** Parst einen einzelnen SSE-Event-Block (Zeilen bis zur Trennzeile `\n\n`). */
function parseSseEvent(raw: string): unknown {
  const data = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("\n");
  if (!data) return undefined;
  if (data.length > MAX_EVENT_CHARS) return undefined; // nur pathologische Events (> 4 MB) verwerfen
  try {
    return JSON.parse(data);
  } catch {
    return undefined; // einzelnes kaputtes Event überspringen, Stream nicht abbrechen
  }
}

export class SseParser {
  private buffer = "";
  private maxBufferChars: number;

  constructor(maxBufferChars = 200000) {
    this.maxBufferChars = maxBufferChars;
  }

  /** Füttert einen dekodierten Text-Chunk und liefert alle darin vollständig
   *  enthaltenen Events als geparste Objekte zurück. */
  push(chunk: string): unknown[] {
    const out: unknown[] = [];
    // CRLF kann an einer Chunk-Grenze zerreißen (\r am Ende des einen Chunks,
    // \n am Anfang des nächsten). Überhängendes \r abschneiden, damit der
    // \n\n-Delimiter zuverlässig gefunden wird.
    if (this.buffer.endsWith("\r") && chunk.startsWith("\n")) {
      this.buffer = this.buffer.slice(0, -1);
    }
    this.buffer += chunk.replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const evt = parseSseEvent(raw);
      if (evt !== undefined) out.push(evt);
    }
    // Deckel gegen unbegrenztes Wachstum: ein unvollständiges Event, das den Puffer
    // sprengt, ist ein kaputter Stream → verwerfen. NICHT den Kopf abschneiden, das
    // würde ein gültiges JSON zerstören und das Event still verlieren (genau so sind
    // vorher große `done`-Events verschwunden).
    if (this.buffer.length > this.maxBufferChars) {
      this.buffer = "";
    }
    return out;
  }

  /** Stream zu Ende: letzten Rest (Event ohne finales `\n\n`) noch auswerten. */
  flush(): unknown[] {
    const out: unknown[] = [];
    const raw = this.buffer;
    this.buffer = "";
    if (raw.trim()) {
      const evt = parseSseEvent(raw);
      if (evt !== undefined) out.push(evt);
    }
    return out;
  }
}

// ── Fehlerklassifikation & Titelableitung (aus App.tsx extrahiert, damit testbar) ──

const AUTH_PATTERN = /401|403|unauthor|forbidden|invalid api key|invalid token|expired token|bad token/i;

/** Fehler in menschenlesbare Kategorie übersetzen (statt rohem ⚠️-Text). */
export function classifyError(raw: string): string {
  const s = raw.toLowerCase();
  if (/rate.?limit|429|too many|limit reached|fenster/i.test(s)) return "Limit erreicht";
  if (/quota|credits|billing|zahlung|payment|out of credits/i.test(s)) return "Konto/Guthaben";
  if (AUTH_PATTERN.test(s)) return "Zugriff verweigert";
  if (/timeout|timed out|zeitüberschreitung/i.test(s)) return "Zeitüberschreitung";
  if (/overload|busy|capacity|ausgelastet|überlast/i.test(s)) return "Server ausgelastet";
  if (/context length|maximum context|token limit/i.test(s)) return "Kontext zu lang";
  // WICHTIG: VOR der Netzwerk-Heuristik prüfen. Ein Server-Neustart mitten im Turn
  // sah früher wie "Verbindung unterbrochen" aus (irreführend, 19.11.2026).
  if (/server wurde neu gestartet|server-neustart|server restart/i.test(s)) return "Server neu gestartet";
  if (/network|fetch failed|connection|econnreset|socket|dns|netzwerk|verbindung/i.test(s)) return "Netzwerk unterbrochen";
  return "Fehler";
}

/** Ob ein Fehler einen erneuten Versuch (Retry) erlaubt. */
export function isRetryable(raw: string): boolean {
  return !AUTH_PATTERN.test(raw)
    && !/quota|credits|billing|zahlung|payment/i.test(raw)
    && !/context length|maximum context|token limit/i.test(raw);
}

/** Speicher-Deckel für den lokalen (verschlüsselten) Chat-Store in JSON-Zeichen.
 *  Gemessen (echter Code): 2,2 MB ≈ 331 ms, 4,3 MB ≈ 664 ms AES-GCM im JS-Thread
 *  (noble + hex verdoppelt die Schreibmenge). Der Deckel hält die Schreibkosten klein. */
export const MAX_STORAGE_CHARS = 900_000;
export const MAX_STORED_MESSAGES = 500;
/** Text-Deckel je gespeicherter Nachricht. Der Volltext steht in der Server-Session
 *  und wird beim Öffnen des Chats nachgeladen — eine Antwort darf nicht das ganze
 *  Speicher-Budget eines Geräts fressen (MAX_REPLY_CHARS = 500 000 Zeichen!). */
export const MAX_STORED_TEXT_CHARS = 12_000;
/** Marker, den `compactChatsForStorage` an gekappte Texte anhängt. Damit erkennt die App
 *  beim Öffnen eines Chats, dass der lokale Text unvollständig ist, und holt den Volltext
 *  aus `GET /api/session/:id` nachgeladen (siehe `healTruncatedMessages`). */
export const LOCAL_TRUNC_MARKER = "\n\n… (gekürzt gespeichert — Volltext lädt beim Öffnen nach)";
/** Ab hier wird ein Chat nicht weiter verkleinert (letzte Nachrichten bleiben). */
export const MIN_COMPACT_MESSAGES = 8;

/**
 * Komprimiert den lokalen Chat-Store: **kein Chat wird gelöscht**.
 *
 * Vorher (bis 20.11.2026) hat `trimChatsForStorage` bei Überschreiten des Budgets
 * ganze Chats "geopfert" (älteste zuerst). Folge im Feld: eine einzige sehr lange
 * Antwort (bis 500 000 Zeichen) sprengte die 700-KB-Grenze allein — danach waren
 * nach dem nächsten App-Start alle anderen Chats aus der Liste verschwunden.
 *
 * Jetzt gilt Auto-Compact wie beim Server:
 *   1. je Chat die letzten `maxMessages` Nachrichten,
 *   2. je Nachricht den Text auf `maxText` Zeichen kappen (Volltext bleibt am Server),
 *   3. reicht das nicht: den GRÖSSTEN Chat-Körper zuerst halbieren (nie unter
 *      `minMessages`), danach dessen Körper ganz ablegen und `bodyCompacted` setzen.
 * Der Chat-Eintrag (Titel, Zeitstempel, letzte Vorschau) bleibt IMMER erhalten und
 * der Verlauf wird beim Öffnen per `/api/session/<id>` nachgeladen.
 */
export function compactChatsForStorage<
  T extends { messages: unknown[]; updatedAt?: number; preview?: string; bodyCompacted?: boolean },
>(
  chats: T[],
  maxMessages = MAX_STORED_MESSAGES,
  maxText = MAX_STORED_TEXT_CHARS,
  maxChars = MAX_STORAGE_CHARS,
  minMessages = MIN_COMPACT_MESSAGES,
): T[] {
  const capText = (m: unknown): unknown => {
    if (!m || typeof m !== "object") return m;
    const o = m as Record<string, unknown>;
    const t = typeof o.text === "string" ? o.text : "";
    if (t.length <= maxText) return m;
    // Kopf behalten (die Pointe steht bei Antworten meist am Ende → Ende behalten
    // wäre riskant; wir behalten den Anfang und markieren die Kürzung im UI-frei
    // sichtbaren Text, damit nichts stillschweigend verschwindet).
    return { ...o, text: t.slice(0, maxText) + LOCAL_TRUNC_MARKER };
  };
  const previewOf = (c: T): string | undefined => {
    if (c.preview) return c.preview;
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const m = c.messages[i] as { text?: string } | null;
      const t = String(m?.text || "").replace(/\s+/g, " ").trim();
      if (t) return t.slice(0, 160);
    }
    return undefined;
  };
  let list: T[] = chats.map((c) => ({
    ...c,
    messages: c.messages.slice(-maxMessages).map(capText),
  }));
  const size = (l: T[]) => JSON.stringify(l).length;
  const bodySize = (c: T) => JSON.stringify(c.messages).length;
  let guard = 0;
  while (size(list) > maxChars && guard++ < 500) {
    // Größten Körper zuerst komprimieren (fair: kleine Chats bleiben vollständig).
    let idx = -1;
    let biggest = 0;
    for (let i = 0; i < list.length; i++) {
      const s = bodySize(list[i]);
      if (s > biggest) { biggest = s; idx = i; }
    }
    if (idx < 0 || biggest < 200) break; // nichts mehr zu holen
    const victim = list[idx];
    const msgs = victim.messages as unknown[];
    if (msgs.length > minMessages) {
      const keep = Math.max(minMessages, Math.floor(msgs.length / 2));
      list = list.map((c, i) => (i === idx ? { ...c, messages: c.messages.slice(-keep), bodyCompacted: true } : c));
    } else if (msgs.length > 0) {
      list = list.map((c, i) =>
        i === idx ? { ...c, messages: [], preview: previewOf(c), bodyCompacted: true } : c,
      );
    } else {
      // Körper schon leer → als erledigt markieren, damit die Schleife nicht hängt.
      list = list.map((c, i) => (i === idx ? { ...c, messages: [] } : c));
      break;
    }
  }
  return list;
}

/** @deprecated Alter Name — opferte Chats. Ruft jetzt `compactChatsForStorage` auf. */
export function trimChatsForStorage<
  T extends { messages: unknown[]; updatedAt?: number; preview?: string; bodyCompacted?: boolean },
>(chats: T[], maxMessages = MAX_STORED_MESSAGES, maxChars = MAX_STORAGE_CHARS): T[] {
  return compactChatsForStorage(chats, maxMessages, MAX_STORED_TEXT_CHARS, maxChars);
}

// ── Turn-Volltext: EINE Blase pro Turn aus ALLEN Assistant-Segmenten ─────────
// Warum: der Server liefert pro Turn MEHRERE Assistant-Nachrichten (ein Segment pro
// Werkzeug-Runde: Text → Tool → Text …). Der Sync übernahm bisher immer nur das
// LETZTE Segment (`serverLast.text`) — bei „Ich prüfe das. [Tool] Ergebnis: 42"
// blieb so nur „Ergebnis: 42" übrig (gemessen 23.11.2026: 33 von 60 Turns hatten
// mehr als ein Segment, im Schnitt 1,8).
export const TURN_SEGMENT_SEP = "\n\n";
export const TURN_TOOL_PREFIX = "· Werkzeug: ";
/** Hinweis am Ende eines abgebrochenen Turns (Server-Shutdown mit gerettetem Teiltext). */
export const INCOMPLETE_TURN_HINT = "⏹ Abgebrochen — dies ist der bis dahin gestreamte Teiltext.";

/** Ein Assistant-Segment (Server-Nachricht oder lokale Blase) eines Turns. */
export type TurnSegment = {
  id?: string;
  role?: string;
  text?: string;
  /** Turn-Zugehörigkeit (ID der User-Nachricht, die den Turn gestartet hat). */
  turnId?: string;
  /** Server: `replyTo` der pi-Nachricht — als Turn-Anker nutzbar. */
  replyTo?: unknown;
  tools?: (string | { tool?: string; name?: string })[];
  activity?: { id?: string; tool?: string; name?: string }[];
  incomplete?: boolean;
  images?: unknown[];
  error?: unknown;
};

function toolNameOf(t: string | { tool?: string; name?: string } | undefined | null): string {
  if (typeof t === "string") return t.trim();
  if (!t || typeof t !== "object") return "";
  return String((t as { tool?: string }).tool || (t as { name?: string }).name || "").trim();
}

/**
 * Turn-Schlüssel einer Nachricht: User-Nachricht → eigene ID, Assistant → Anker
 * (`turnId` bzw. `replyTo`), sonst `fallback` (z. B. der Turn der Vorgängernachricht).
 * Damit lassen sich Segmente desselben Turns gruppieren, ohne sie zu raten.
 */
export function turnKeyOf(msg: TurnSegment | null | undefined, fallback = ""): string {
  if (!msg || typeof msg !== "object") return fallback;
  const own = String(msg.id || "").trim();
  const explicit = String((msg as { turnId?: string }).turnId || "").trim();
  if (explicit) return explicit;
  if (msg.role === "user") return own || fallback;
  const rt = (msg as { replyTo?: unknown }).replyTo;
  if (typeof rt === "string" && rt.trim()) return rt.trim();
  if (rt && typeof rt === "object") {
    const rid = String((rt as { id?: string }).id || "").trim();
    if (rid) return rid;
  }
  // Kein expliziter Anker: der übergebene Turn-Schlüssel gilt (Gruppierung), sonst
  // die eigene ID. Sonst ließen sich Segmente ohne Anker nie zu einem Turn bündeln.
  return fallback || own;
}

/**
 * Text EINES Turns: alle Segmente in Reihenfolge, getrennt durch eine Leerzeile,
 * dazwischen die Werkzeug-Zeilen (`· Werkzeug: bash`, nur einmal pro Segment).
 * `includeTools: false` schaltet diese Zeilen ab (Setting in der App).
 * Ein Segment mit `incomplete: true` bekommt den Abbruch-Hinweis am Ende.
 */
export function joinTurnSegments(
  segments: TurnSegment[],
  opts: { includeTools?: boolean; incompleteHint?: boolean } = {},
): string {
  const includeTools = opts.includeTools !== false;
  const incompleteHint = opts.incompleteHint !== false;
  const list = Array.isArray(segments) ? segments : [];
  const blocks: string[] = [];
  let incomplete = false;
  for (const seg of list) {
    if (!seg || typeof seg !== "object") continue;
    if ((seg as { incomplete?: boolean }).incomplete === true) incomplete = true;
    if (includeTools) {
      const tools: (string | { tool?: string; name?: string })[] = [
        ...(Array.isArray(seg.tools) ? seg.tools : []),
        ...(Array.isArray(seg.activity) ? seg.activity : []),
      ];
      const seen = new Set<string>();
      for (const raw of tools) {
        const name = toolNameOf(raw);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        blocks.push(TURN_TOOL_PREFIX + name);
      }
    }
    const text = typeof seg.text === "string" ? seg.text.trim() : "";
    if (text) blocks.push(text);
  }
  if (incomplete && incompleteHint) blocks.push(INCOMPLETE_TURN_HINT);
  return blocks.join(TURN_SEGMENT_SEP);
}

/**
 * Der LÄNGERE von zwei Texten — Sync-Regel: ein Server-Text darf eine lokale Blase
 * nur ersetzen, wenn er LÄNGER ist (nie einen vollständigeren Text verkürzen).
 * Bei Gleichstand gewinnt `a`.
 */
export function longestTurnText(a?: string | null, b?: string | null): string {
  const first = typeof a === "string" ? a : "";
  const second = typeof b === "string" ? b : "";
  return second.trim().length > first.trim().length ? second : first;
}

/** Text des LETZTEN Turns (alles nach der letzten User-Nachricht), zusammengefügt. */
export function turnTextOfLastTurn(
  messages: TurnSegment[],
  opts: { includeTools?: boolean; incompleteHint?: boolean } = {},
): string {
  const list = Array.isArray(messages) ? messages : [];
  let start = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === "user") { start = i; break; }
  }
  const segs = list.slice(start + 1).filter((m) => m && m.role !== "user");
  return joinTurnSegments(segs as TurnSegment[], opts);
}

/**
 * Eine Blase pro Turn: aufeinanderfolgende Assistant-Nachrichten desselben Turns
 * zusammenfassen (Text = `joinTurnSegments`; Aktivität nach ID, Bilder aneinander).
 * Blasen mit Fehlerkarte bleiben einzeln — die Karte gehört zu genau diesem Schritt.
 * Rückgabe `null` = nichts zu tun (kein Re-Render, kein Endlos-Patch).
 */
export function collapseTurnBubbles<T extends TurnSegment>(
  messages: T[],
  opts: { includeTools?: boolean; incompleteHint?: boolean } = {},
): T[] | null {
  const list = Array.isArray(messages) ? messages : [];
  const out: T[] = [];
  let changed = false;
  let i = 0;
  while (i < list.length) {
    const head = list[i];
    if (!head || head.role !== "assistant") { out.push(head); i++; continue; }
    const key = turnKeyOf(head);
    const group: T[] = [];
    let j = i;
    while (j < list.length && list[j] && list[j].role === "assistant" && turnKeyOf(list[j], key) === key) {
      group.push(list[j]);
      j++;
    }
    if (group.length < 2 || group.some((g) => g.error)) { out.push(...group); i = j; continue; }
    const merged = { ...group[0], text: joinTurnSegments(group, opts) } as T;
    const activity: NonNullable<TurnSegment["activity"]> = [];
    for (const g of group) {
      for (const a of Array.isArray(g.activity) ? g.activity : []) {
        const id = String(a?.id || "");
        if (id && activity.some((x) => String(x?.id || "") === id)) continue;
        activity.push(a);
      }
    }
    if (activity.length) merged.activity = activity;
    const images: unknown[] = [];
    for (const g of group) for (const im of Array.isArray(g.images) ? g.images : []) images.push(im);
    if (images.length) merged.images = images;
    const withDil = [...group].reverse().find((g) => Array.isArray((g as { dil?: unknown[] }).dil) && ((g as { dil?: unknown[] }).dil as unknown[]).length > 0);
    if (withDil) (merged as { dil?: unknown }).dil = (withDil as { dil?: unknown }).dil;
    out.push(merged);
    changed = true;
    i = j;
  }
  return changed ? out : null;
}

/**
 * Fehlende Verlaufs-Teile vom Server an den lokalen Chat anhängen.
 *
 * Warum: Antworten gingen verloren, wenn die App während (oder direkt nach) einem
 * Turn beendet wurde — lokal war die KI-Bubble leer/weg, und die bisherige Logik
 * konnte eine Server-Antwort nur in eine VORHANDENE Bubble schreiben. Ergebnis:
 * "Antwort wird nicht angezeigt" bzw. nach dem Schließen ganz weg.
 *
 * Regeln:
 *  - lokal leer (Körper komprimiert) → letzten Server-Nachrichten übernehmen
 *  - sonst: letzte lokale Nutzernachricht im Server suchen (Text-Vergleich, tolerant)
 *    und alles danach anhängen — aber nur, wenn lokal noch keine Antwort vorliegt
 *    bzw. der Server NEUE Turns kennt. Sonst `null` (nichts zu tun).
 */
export function mergeServerTail<
  T extends { id?: string; role?: string; text?: string; images?: unknown[] },
>(
  local: T[],
  server: { id?: string; role?: string; text?: string; images?: unknown[] }[],
  opts: { maxAppend?: number; maxPrepend?: number; resolveImages?: (imgs: unknown[]) => unknown[] | undefined } = {},
): T[] | null {
  const maxAppend = opts.maxAppend ?? 40;
  const maxPrepend = opts.maxPrepend ?? 320;
  const srv = Array.isArray(server) ? server : [];
  if (!srv.length) return null;
  const localMsgs = Array.isArray(local) ? local : [];
  const toLocal = (m: { id?: string; role?: string; text?: string; images?: unknown[] }, i: number): T => {
    const images = Array.isArray(m.images) && m.images.length
      ? (opts.resolveImages ? opts.resolveImages(m.images) : m.images)
      : undefined;
    return {
      id: String(m.id || `srv${i}`),
      role: m.role === "user" ? "user" : "assistant",
      text: String(m.text || "").slice(0, 500_000),
      ...(images ? { images } : {}),
    } as unknown as T;
  };
  const worthKeeping = (m: T) => {
    const text = String((m as { text?: string }).text || "").trim();
    const imgs = (m as { images?: unknown[] }).images;
    return (m as { role?: string }).role === "user" || !!text || (Array.isArray(imgs) && imgs.length > 0);
  };
  const norm = (s?: string) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 240);

  if (localMsgs.length === 0) {
    const tail = srv.slice(-maxAppend).map(toLocal).filter(worthKeeping);
    return tail.length ? tail : null;
  }
  // Server hat MEHR Verlauf als lokal (ältere Nachrichten wurden lokal durch den
  // Speicher-/Auto-Compact-Deckel abgeschnitten): die fehlenden ÄLTEREN Nachrichten vorne
  // nachziehen — Ausrichtung über die Message-IDs, keine Heuristik.
  const older = olderServerHead(localMsgs, srv, toLocal, worthKeeping, maxPrepend);

  const localUsers = localMsgs.filter((m) => m.role === "user").length;
  const srvUsers = srv.filter((m) => m.role === "user").length;
  if (srvUsers < localUsers) return older.length ? [...older, ...localMsgs] : null; // Server hinkt hinterher

  // Abgleich per Message-ID, sonst per Text: lokale Blasen tragen EIGENE IDs (uid),
  // die Server-Nachrichten kommen aus der pi-Session — ein reiner ID-Vergleich würde
  // deshalb alles doppeln. Jede lokale Nachricht bekommt ihren Server-Index; alle
  // Server-Nachrichten ohne lokales Gegenstück werden an GENAU DIESER Stelle eingefügt,
  // auch mitten im Turn. Vorher brach der Merge bei gleicher User-Zahl ab und der
  // Aufrufer übernahm nur das LETZTE Assistant-Segment (Segmente 1..n-1 gingen verloren).
  const srvIdxById = new Map<string, number>();
  srv.forEach((m, i) => {
    const id = String(m.id || "");
    if (id) srvIdxById.set(id, i);
  });
  const localIdSet = new Set(localMsgs.map((m) => String((m as { id?: string }).id || "")).filter(Boolean));
  const usedSrv = new Set<number>();
  const anchors: number[] = [];
  let textCursor = 0;
  for (const m of localMsgs) {
    const byId = srvIdxById.get(String((m as { id?: string }).id || ""));
    if (byId !== undefined && !usedSrv.has(byId)) {
      usedSrv.add(byId);
      anchors.push(byId);
      if (byId + 1 > textCursor) textCursor = byId + 1;
      continue;
    }
    // Text-Anker: die lokale Blase trägt den Server-Wortlaut (oder dessen gekappten Kopf).
    const want = norm((m as { text?: string }).text);
    let hit = -1;
    if (want) {
      for (let i = textCursor; i < srv.length; i++) {
        if (usedSrv.has(i)) continue;
        if (srv[i].role !== m.role) continue;
        const cand = norm(srv[i].text);
        if (!cand) continue;
        if (cand === want || (want.length >= 40 && (cand.startsWith(want) || want.startsWith(cand)))) { hit = i; break; }
      }
    }
    if (hit >= 0) { usedSrv.add(hit); textCursor = hit + 1; }
    anchors.push(hit);
  }
  // Server-Nachrichten bis `limit` einfügen, soweit sie lokal fehlen.
  const out: T[] = [];
  let inserted = 0;
  let cursor = 0;
  const flushUpTo = (limit: number) => {
    for (; cursor < limit && cursor < srv.length; cursor++) {
      if (usedSrv.has(cursor)) continue; // lokal vorhanden (ggf. mit anderer ID)
      const id = String(srv[cursor].id || "");
      if (id && localIdSet.has(id)) continue;
      const m = toLocal(srv[cursor], cursor);
      if (!worthKeeping(m)) continue;
      out.push(m);
      inserted++;
    }
  };
  for (let i = 0; i < localMsgs.length; i++) {
    const a = anchors[i];
    if (a >= 0) flushUpTo(a);
    out.push(localMsgs[i]);
  }
  flushUpTo(srv.length);

  const head = older.filter((m) => {
    const id = String((m as { id?: string }).id || "");
    if (id && localIdSet.has(id)) return false;
    return !out.some((o) => String((o as { id?: string }).id || "") === id);
  });
  if (!inserted && !head.length) return null;
  return [...head, ...out];
}

/**
 * Fehlende ÄLTERE Server-Nachrichten vor dem ersten lokal bekannten Treffer.
 * Ohne ID-Treffer wird nichts vorne angefügt (kein Raten → keine Dubletten).
 */
function olderServerHead<T>(
  localMsgs: T[],
  srv: { id?: string; role?: string; text?: string; images?: unknown[] }[],
  toLocal: (m: { id?: string; role?: string; text?: string; images?: unknown[] }, i: number) => T,
  worthKeeping: (m: T) => boolean,
  maxPrepend: number,
): T[] {
  if (!srv.length || !localMsgs.length) return [];
  const idxById = new Map<string, number>();
  srv.forEach((m, i) => {
    const id = String(m.id || "");
    if (id) idxById.set(id, i);
  });
  let firstIdx = -1;
  for (const m of localMsgs) {
    const id = String((m as { id?: string }).id || "");
    if (!id) continue;
    const i = idxById.get(id);
    if (i !== undefined) { firstIdx = i; break; }
  }
  if (firstIdx <= 0) return [];
  const localIds = new Set(localMsgs.map((m) => String((m as { id?: string }).id || "")).filter(Boolean));
  const head: T[] = [];
  const start = Math.max(0, firstIdx - Math.max(0, maxPrepend));
  for (let i = start; i < firstIdx; i++) {
    const id = String(srv[i].id || "");
    if (id && localIds.has(id)) continue;
    const m = toLocal(srv[i], i);
    if (worthKeeping(m)) head.push(m);
  }
  return head;
}

/** Endet der Text auf dem lokalen Speicher-Kürzungsmarker? */
export function hasLocalTruncation(text: string): boolean {
  return String(text ?? "").trimEnd().endsWith(LOCAL_TRUNC_MARKER.trim());
}

/** Lokal gekappten Text ohne Marker (nur der gespeicherte Kopf). */
export function stripLocalTruncation(text: string): string {
  const t = String(text ?? "");
  const i = t.lastIndexOf(LOCAL_TRUNC_MARKER.trim());
  return i >= 0 ? t.slice(0, i) : t;
}

/**
 * Lokal gekürzte Texte durch den Server-Volltext ersetzen.
 *
 * Bis 23.11.2026 blieb der Kürzungsmarker `… (gekürzt gespeichert …)` dauerhaft in der
 * Blase: `compactChatsForStorage` kappte bei 12 000 Zeichen, `mergeServerTail` hat aber
 * nur NEUE Nachrichten nachgezogen bzw. die letzte Antwort — nie eine schon vorhandene,
 * gekappte Blase repariert. Ergebnis: langer Text blieb nach dem Öffnen für immer
 * abgeschnitten, obwohl der Volltext in `GET /api/session/:id` steht.
 *
 * Zuordnung: primär über die Message-ID, sonst über den Textanfang (Server speichert
 * denselben Wortlaut). Nur ersetzen, wenn der Server-Text wirklich länger ist.
 * Rückgabe `null` = nichts zu tun.
 */
export function healTruncatedMessages<
  T extends { id?: string; role?: string; text?: string; images?: unknown[] },
>(
  local: T[],
  server: { id?: string; role?: string; text?: string; images?: unknown[] }[],
): T[] | null {
  if (!Array.isArray(local) || !Array.isArray(server) || !local.length || !server.length) return null;
  const byId = new Map<string, { id?: string; role?: string; text?: string; images?: unknown[] }>();
  for (const m of server) {
    const id = String(m?.id || "");
    if (id) byId.set(id, m);
  }
  const norm = (v?: string) => String(v || "").replace(/\s+/g, " ").trim();
  let changed = 0;
  const out = local.map((m) => {
    const text = typeof m.text === "string" ? m.text : "";
    if (!hasLocalTruncation(text)) return m;
    const head = stripLocalTruncation(text);
    let hit = byId.get(String(m.id || ""));
    if (!hit) {
      const want = norm(head).slice(0, 200);
      if (want) hit = server.find((s) => s.role === m.role && norm(s.text).startsWith(want));
    }
    const full = String(hit?.text || "");
    if (full.length <= head.length) return m; // Server kennt keinen längeren Text
    changed++;
    return { ...m, text: full, images: (m.images as unknown) ?? (hit?.images as unknown) } as T;
  });
  return changed ? out : null;
}

// ── Aufgeklappte Blasen merken (pro Chat + Message-ID, überlebt App-Neustart) ──
/** AsyncStorage-kompatibler Minimal-Store (in Tests: In-Memory). */
export type OpenedStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
};
export const OPENED_KEY_PREFIX = "pi.opened.v1";
export function openedKey(chatId: string): string {
  return `${OPENED_KEY_PREFIX}.${chatId || "default"}`;
}
/** Kaputtes/leeres JSON → leere Liste (nie werfen). */
export function parseOpenedIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Merkt sich, welche Blasen der Nutzer aufgeklappt hat.
 * Ohne Persistenz war `forceOpen` nach jedem App-Start weg → dieselbe Riesennachricht
 * stand wieder zugeklappt da, obwohl der Nutzer sie schon geöffnet hatte.
 */
export function createOpenedRegistry(store: OpenedStore, maxIds = 300) {
  return {
    async load(chatId: string): Promise<string[]> {
      try {
        return parseOpenedIds(await store.getItem(openedKey(chatId)));
      } catch {
        return [];
      }
    },
    async isOpen(chatId: string, msgId: string): Promise<boolean> {
      const ids = await this.load(chatId);
      return ids.includes(String(msgId || ""));
    },
    /** Merken (idempotent), älteste Einträge fallen weg. Rückgabe = neue Liste. */
    async remember(chatId: string, msgId: string): Promise<string[]> {
      const id = String(msgId || "");
      const ids = await this.load(chatId);
      if (!id) return ids;
      const next = [...ids.filter((x) => x !== id), id].slice(-Math.max(1, maxIds));
      try {
        await store.setItem(openedKey(chatId), JSON.stringify(next));
      } catch {
        // Speichern darf die UI nie blockieren.
      }
      return next;
    },
  };
}

/** Chat-Titel aus der ersten Nutzernachricht ableiten (gekürzt, an Wortgrenze). */
export function deriveTitle(raw: string, maxChars = 18): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxChars) return cleaned;
  const cut = cleaned.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const truncated = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return truncated ? `${truncated}…` : "";
}

// ───────────────────────────── Bilder in Chat-Antworten ─────────────────────────────
// Der Server hängt erzeugte Bilder sowohl als Markdown (`![](/generated/…)`) als auch
// als Anlage (`images: [{uri}]`) an. RN lädt nur absolute URIs — und nur harmlose Schemata:
// kein file://, kein http://, keine Steuerzeichen, kein javascript:. Beide Pfade hier
// bündeln die Prüfung, damit Markdown-Renderer und Bild-Anlagen identisch filtern.

const MD_IMAGE_MAX_B64 = 2_000_000;

/** data:image/*-Base64 (nur echte Bildtypen, begrenzte Länge). */
export function isDataImage(uri: string): boolean {
  const s = String(uri || "").trim();
  if (!s || s.length > MD_IMAGE_MAX_B64) return false;
  return /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(s);
}

/** Nur https-URLs und data:image/*-Base64 sind als Bild erlaubt. */
export function safeImageUri(src: string): string | null {
  const s = String(src || "").trim();
  if (!s) return null;
  if (isDataImage(s)) return s;
  if (s.length > 2048) return null;
  if (/\s/.test(s)) return null;
  if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
  return null;
}

/** Relative Server-Pfade (/generated/…) gegen die Server-URL absolut machen. */
export function absoluteImageUri(raw: string, base: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const direct = safeImageUri(s);
  if (direct) return direct;
  if (!s.startsWith("/") || s.startsWith("//")) return null;
  if (/\s/.test(s)) return null;
  const b = String(base || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(b)) return null;
  return `${b}${s}`;
}

// Server-Basis für relative Bild-URLs (/generated/…). Einmal beim Start gesetzt,
// damit der Markdown-Renderer sie ohne Prop-Durchreichung (App → DilRichText →
// Markdown) auflösen kann.
let imageBaseUrl = "";
export function setImageBaseUrl(base: string): void {
  imageBaseUrl = String(base || "").trim();
}
export function getImageBaseUrl(): string {
  return imageBaseUrl;
}

/** Link auf eine erzeugte Datei? Relativ (`/generated/bericht.docx`) oder absolut. */
export function isGeneratedFileHref(href: string): boolean {
  const h = String(href || "");
  if (!/\.(docx|pptx|xlsx|pdf|csv|zip|txt|md)(?:[?#].*)?$/i.test(h)) return false;
  return h.startsWith("/generated/") || /^https?:/i.test(h);
}

/** Dateiendung einer URL/Pfadangabe in Kleinbuchstaben ("" wenn keine). */
export function fileExtOf(uri: string): string {
  const m = String(uri || "").split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

/** Wochentagsnamen, Index 0 = Montag (wie der Reha-Server plan.strength_days). */
export const REHA_DOW = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

/**
 * Wochentagsname des Reha-Tags aus dem Zustand.
 *
 * Der Server liefert `state.today` (YYYY-MM-DD) und `state.weekday` 0-basiert
 * (0 = Montag). Fruehere Server-Versionen schickten ISO (1 = Montag), deshalb
 * wird der Name primaer aus dem DATUM berechnet — der Index ist nur Fallback.
 * Vorher wurde `weekday` als ISO gelesen, dadurch hiess Mittwoch "Dienstag" und
 * das Lagebild zeigte den Plan vom Vortag (Kraft-Tag als "Physio Dresden").
 */
export function rehaTagName(state: { today?: string; weekday?: number } | null | undefined): string {
  const iso = String(state?.today || "");
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isNaN(d.getTime())) return REHA_DOW[(d.getDay() + 6) % 7];
  }
  const n = Number(state?.weekday);
  if (Number.isFinite(n)) return REHA_DOW[((Math.trunc(n) % 7) + 7) % 7];
  return "";
}

/**
 * Filter der Chat-Liste.
 *   "app"    = nur Chats, die auf DIESEM Gerät liegen
 *   "server" = Verläufe, die nur auf dem Server liegen (anderes Gerät/App-Instanz)
 *   "all"    = beides zusammen
 *
 * Das war die Ursache für "ich sehe nur 2 Chats": die Startansicht war "app", also
 * wurden die 542 Server-Verläufe (andere Geräte, WhatsApp, Terminal) ausgeblendet —
 * unsichtbar, aber vorhanden.
 */
export type ChatSourceFilter = "all" | "app" | "server" | "whatsapp" | "terminal";

export function filterChatsBySource<T extends { source?: string; remote?: boolean }>(
  chats: T[],
  filter: ChatSourceFilter,
): T[] {
  const src = (c: T) => c.source || "app";
  if (filter === "all") return chats;
  if (filter === "app") return chats.filter((c) => src(c) === "app" && !c.remote);
  if (filter === "server") return chats.filter((c) => src(c) === "app" && !!c.remote);
  return chats.filter((c) => src(c) === filter);
}

/** Anzahl je Filter für die Chips — damit nie unklar ist, WARUM ein Chat fehlt. */
export function chatSourceCounts<T extends { source?: string; remote?: boolean }>(
  chats: T[],
): Record<ChatSourceFilter, number> {
  return {
    all: chats.length,
    app: filterChatsBySource(chats, "app").length,
    server: filterChatsBySource(chats, "server").length,
    whatsapp: filterChatsBySource(chats, "whatsapp").length,
    terminal: filterChatsBySource(chats, "terminal").length,
  };
}

// ---------------------------------------------------------------------------
// Server-Neustart: wann muss die App die Teilantwort nachladen?
// ---------------------------------------------------------------------------
// Ein Turn, der wegen eines Server-Neustarts stirbt, ist kein Endzustand: der Server
// persistiert den Turn (turn-store) und schreibt die Teilantwort bzw. den Auto-Retry
// in die Session-Datei — oft erst 1-2 s nach dem Reconnect. Die App laedt deshalb
// nach diesen Fehlerarten 2x im Abstand von 3 s nach und ersetzt die Fehlerblase
// durch den Text, statt eine leere/abgebrochene Blase stehen zu lassen.
export const RESTART_RELOAD_DELAYS_MS: readonly number[] = [0, 3000];

/** Fehlerarten, nach denen ein Nachladen sinnvoll ist (Server lebt wieder). */
export function isRestartErrorKind(kind: string, text?: string): boolean {
  const k = String(kind || "").trim().toLowerCase();
  if (k === "server_restart" || k === "engine_down") return true;
  return isRestartErrorText(text);
}

/** Textvariante (aeltere Server ohne `kind`-Feld). */
export function isRestartErrorText(text?: string): boolean {
  return /server wurde neu gestartet|server neu gestartet|server nicht bereit/i.test(String(text || ""));
}

/**
 * Erste Komponente aus einem React-`componentStack` ("   in Dil (at Dil.tsx:1200)").
 * Wird von der Fehler-Grenze (SichererBlock) für die Telemetrie genutzt — bewusst
 * hier in lib.ts, damit es ohne React-Native-Laufzeit testbar ist.
 */
/**
 * Secrets/PII aus Fehlertexten entfernen, BEVOR sie das Gerät verlassen.
 *
 * Review-Fund 23.11.2026 (security-reviewer, gemessen): eine reine Denylist
 * (URLs + 24-Zeichen-Alnum) ließ 9 von 10 echten Fällen unverändert —
 * `Bearer eyJ…`, `{"token":"s3cr3t"}`, `?token=abc123def`, `basic dXNlcjpwYXNz+…`,
 * `sk-live-4f3c/8ab+9de=`, `client_secret: 9f8e…`, `pw=Hunter2!`.
 * Deshalb umgekehrt: erst gezielt Werte nach Schlüsselworten/JWT/Base64 ersetzen,
 * am Ende auf eine Zeichen-WHITELIST filtern (wirft Quotes, Backslashes, Klammern,
 * Bidi-/Unicode-Tag-Zeichen weg — damit ist auch Injection in ein künftiges
 * Dashboard unmöglich).
 */
export function redigiere(text: string): string {
  let s = String(text ?? "");
  // 1) Werte nach Schlüsselwort: token=…, "password": …, Authorization: Bearer …
  s = s.replace(/(token|secret|passwort|password|passwd|pw|apikey|api[-_]key|key|bearer|authorization)[\s"']*[=:][\s"']*\S+/gi, "$1=#");
  // 2) Wörter mit Token-Charakter: JWT-Segmente, Base64 (inkl. + / = .), Hashes
  s = s.replace(/[A-Za-z0-9+/=_.-]{20,}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "#tok" : m));
  // 3) JSON-/Quoted-Werte
  s = s.replace(/"[^"]{8,}"/g, '"#"');
  // 4) Whitelist: alles außer Buchstaben (inkl. Umlaute), Ziffern und dieser Satzzeichen raus
  s = s.replace(/[^A-Za-z0-9äöüÄÖÜß .,:;/()_+#@!?%\-]/g, " ");
  return s.replace(/\s{2,}/g, " ").trim();
}

export function firstFrame(componentStack?: string): string {
  // Längen-Cap VOR dem Split: ein riesiger componentStack würde sonst im Crash-Pfad
  // viele MB Zeilen-Array allokieren (Review-Fund 23.11.2026).
  const zeilen = String(componentStack || "")
    .slice(0, 4_000)
    .split("\n")
    .map((z) => z.trim())
    .filter((z) => z.startsWith("in "));
  const m = (zeilen[0] || "").match(/in ([A-Za-z0-9_$.]+)/);
  return m ? m[1].slice(0, 40) : "";
}
