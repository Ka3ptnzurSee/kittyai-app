// Reine Suchlogik (keine RN-Imports) — damit sie per node --test pruefbar ist.
// Quelle fuer das Verhalten: ChatGPT-Suche filtert ueber Titel UND Nachrichtentext,
// mehrere Woerter sind UND-verknuepft, Treffer zeigen einen Kontextausschnitt.

export type ChatLike = {
  id: string;
  title?: string;
  preview?: string;
  updatedAt?: number;
  messages?: { id: string; role: string; text?: string }[];
};

export type SearchDoc = {
  chatId: string;
  msgId: string | null;
  role: string;
  text: string;
  folded: string;
  map: number[];
  ts: number;
};

export type SearchHit = {
  chatId: string;
  msgId: string | null;
  role: string;
  count: number;
  snippet: string;
};

const FOLD: Record<string, string> = {
  ä: "a", ö: "o", ü: "u", Ä: "a", Ö: "o", Ü: "u", à: "a", á: "a", â: "a", é: "e",
  è: "e", ê: "e", í: "i", ì: "i", ó: "o", ò: "o", ô: "o", ú: "u", ù: "u", ß: "ss",
};

// Faltet Text fuer den Vergleich und merkt sich, woher jedes Zeichen kommt —
// nur so laesst sich der Treffer spaeter korrekt im Original markieren (Umlaute, ss).
export function foldWithMap(input: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const rep = FOLD[ch] ?? ch.toLowerCase();
    for (let k = 0; k < rep.length; k++) {
      folded += rep[k];
      map.push(i);
    }
  }
  return { folded, map };
}

export function foldText(input: string): string {
  return foldWithMap(input).folded;
}

function pushDoc(out: SearchDoc[], chatId: string, msgId: string | null, role: string, text: string, ts: number, maxChars: number) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  const clipped = trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
  const { folded, map } = foldWithMap(clipped);
  out.push({ chatId, msgId, role, text: clipped, folded, map, ts });
}

// Baut den Index ueber Titel, Vorschau und Nachrichten (die letzten `maxMessages`
// pro Chat — aeltere Verlaeufe bleiben auf dem Server durchsuchbar).
export function buildIndex(
  chats: ChatLike[],
  opts: { maxMessages?: number; maxChars?: number } = {},
): SearchDoc[] {
  const maxMessages = opts.maxMessages ?? 60;
  const maxChars = opts.maxChars ?? 4000;
  const out: SearchDoc[] = [];
  for (const c of chats) {
    const ts = c.updatedAt ?? 0;
    pushDoc(out, c.id, null, "title", c.title || "", ts, maxChars);
    if (c.preview) pushDoc(out, c.id, null, "preview", c.preview, ts, maxChars);
    const msgs = c.messages || [];
    const start = Math.max(0, msgs.length - maxMessages);
    for (let i = start; i < msgs.length; i++) {
      const m = msgs[i];
      pushDoc(out, c.id, m.id, m.role, m.text || "", ts + i, maxChars);
    }
  }
  return out;
}

export function tokenize(query: string): string[] {
  // Apostrophe trennen (war's -> war s), damit "war" als Token gefunden wird.
  return foldText(query)
    .replace(/['’`]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length >= 2);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function makeSnippet(doc: SearchDoc, token: string, radius: number): string {
  const pos = doc.folded.indexOf(token);
  if (pos < 0) return doc.text.slice(0, radius * 2);
  const origStart = doc.map[pos] ?? 0;
  const matchLen = token.length;
  const origEnd = doc.map[Math.min(doc.map.length - 1, pos + matchLen - 1)] ?? origStart + matchLen;
  const from = Math.max(0, origStart - radius);
  const to = Math.min(doc.text.length, origEnd + radius);
  const body = doc.text.slice(from, to).replace(/\s+/g, " ").trim();
  return (from > 0 ? "… " : "") + body + (to < doc.text.length ? " …" : "");
}

export function searchIndex(
  docs: SearchDoc[],
  query: string,
  opts: { limit?: number; snippetRadius?: number } = {},
): SearchHit[] {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const limit = opts.limit ?? 200;
  const radius = opts.snippetRadius ?? 60;
  const hits: SearchHit[] = [];
  for (const d of docs) {
    if (!tokens.every((t) => d.folded.includes(t))) continue;
    const count = tokens.reduce((sum, t) => sum + countOccurrences(d.folded, t), 0);
    hits.push({ chatId: d.chatId, msgId: d.msgId, role: d.role, count, snippet: makeSnippet(d, tokens[0], radius) });
  }
  hits.sort((a, b) => b.count - a.count);
  return hits.slice(0, limit);
}

// Nur die Chat-IDs, die irgendwo treffen — fuer die Listenfilterung.
export function matchingChatIds(docs: SearchDoc[], query: string): Set<string> {
  return new Set(searchIndex(docs, query).map((h) => h.chatId));
}

