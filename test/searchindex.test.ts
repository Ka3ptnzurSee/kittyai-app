import { test } from "node:test";
import assert from "node:assert";
import { buildIndex, foldText, tokenize, searchIndex, matchingChatIds } from "../searchIndex.ts";

const chats = [
  {
    id: "c1",
    title: "Reha-Plan",
    updatedAt: 10,
    messages: [
      { id: "m1", role: "user", text: "Wie war mein Krafttraining am Montag?" },
      { id: "m2", role: "assistant", text: "Dein Krafttraining lief gut, 3 Saetze Press." },
    ],
  },
  {
    id: "c2",
    title: "Straße und Grüße",
    updatedAt: 5,
    messages: [{ id: "m3", role: "user", text: "Termin für die Physio am Dienstag" }],
  },
];

test("foldText: Umlaute, ß und Grossschreibung", () => {
  assert.strictEqual(foldText("Grüße STRASSE"), "grusse strasse");
  assert.strictEqual(foldText("ÄÖÜ"), "aou");
});

test("foldWithMap-Konsistenz: map zeigt auf Originalzeichen", () => {
  const docs = buildIndex(chats);
  const physio = docs.find((d) => d.text.includes("Physio"))!;
  assert.ok(physio, "Physio-Dokument fehlt");
  const pos = physio.folded.indexOf("physio");
  assert.strictEqual(physio.text[physio.map[pos]], "P");
});

test("tokenize: Satzzeichen weg, kurze Woerter weg", () => {
  assert.deepStrictEqual(tokenize("  Wie, war's? a b cd  "), ["wie", "war", "cd"]);
});

test("searchIndex: Treffer ueber Nachrichtentext, nicht nur Titel", () => {
  const docs = buildIndex(chats);
  const hits = searchIndex(docs, "krafttraining");
  assert.ok(hits.some((h) => h.chatId === "c1"));
  assert.ok(hits.some((h) => h.msgId === "m1"));
});

test("searchIndex: mehrere Woerter sind UND-verknuepft", () => {
  const docs = buildIndex(chats);
  assert.ok(searchIndex(docs, "krafttraining montag").length > 0);
  assert.strictEqual(searchIndex(docs, "krafttraining dienstag").length, 0);
});

test("searchIndex: diakritikfrei finden (fur -> für)", () => {
  const docs = buildIndex(chats);
  assert.ok(searchIndex(docs, "fur").some((h) => h.chatId === "c2"));
});

test("searchIndex: ß wird zu ss (strasse -> Straße)", () => {
  const docs = buildIndex(chats);
  assert.ok(searchIndex(docs, "strasse").some((h) => h.chatId === "c2"));
});

test("searchIndex: Snippet enthaelt den Treffer", () => {
  const docs = buildIndex(chats);
  const hit = searchIndex(docs, "saetze")[0];
  assert.ok(hit, "kein Treffer");
  assert.match(hit.snippet.toLowerCase(), /saetze|sätze/);
});

test("searchIndex: leere/zu kurze Query liefert nichts", () => {
  const docs = buildIndex(chats);
  assert.deepStrictEqual(searchIndex(docs, ""), []);
  assert.deepStrictEqual(searchIndex(docs, "a"), []);
});

test("searchIndex: limit greift", () => {
  const docs = buildIndex(chats);
  assert.ok(searchIndex(docs, "training", { limit: 1 }).length <= 1);
});

test("matchingChatIds: deduplizierte Chat-IDs", () => {
  const docs = buildIndex(chats);
  const ids = matchingChatIds(docs, "training");
  assert.ok(ids.has("c1"));
  assert.ok(ids.size >= 1);
});

test("buildIndex: maxMessages begrenzt den Index", () => {
  const viele = [{ id: "x", title: "t", messages: Array.from({ length: 100 }, (_, i) => ({ id: "m" + i, role: "user", text: "nachricht " + i })) }];
  const docs = buildIndex(viele, { maxMessages: 5 });
  const msgDocs = docs.filter((d) => d.msgId);
  assert.strictEqual(msgDocs.length, 5);
});

