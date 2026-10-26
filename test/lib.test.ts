import { test } from "node:test";
import assert from "node:assert";
import { Utf8Decoder, argSummary, breakLongLines, formatTime, presetCron, cronLabel, toolMeta, toolLabel } from "../lib.ts";

test("Utf8Decoder dekodiert ASCII", () => {
  const d = new Utf8Decoder();
  assert.strictEqual(d.decode(new TextEncoder().encode("Hallo")), "Hallo");
});

test("Utf8Decoder dekodiert Umlaute und Emoji über Chunk-Grenzen", () => {
  const d = new Utf8Decoder();
  const bytes = new TextEncoder().encode("Grüße 😀");
  let out = "";
  // byte-weise füttern, damit Multi-Byte-Zeichen gesplittet werden
  for (const b of bytes) out += d.decode(new Uint8Array([b]));
  assert.strictEqual(out, "Grüße 😀");
});

test("Utf8Decoder ersetzt kaputte Sequenzen durch Replacement-Zeichen", () => {
  const d = new Utf8Decoder();
  assert.strictEqual(d.decode(new Uint8Array([0xff, 0xfe])), "\uFFFD\uFFFD");
});

test("argSummary extrahiert command/path/url", () => {
  assert.strictEqual(argSummary({ command: "ls -la" }), "ls -la");
  assert.strictEqual(argSummary({ path: "/tmp/x" }), "/tmp/x");
  assert.strictEqual(argSummary({ url: "https://x.de" }), "https://x.de");
  assert.strictEqual(argSummary(null), "");
  assert.strictEqual(argSummary("str"), "");
  assert.strictEqual(argSummary({}), "");
});

test("argSummary kürzt lange Strings und fällt auf Key zurück", () => {
  assert.strictEqual(argSummary({ foo: "x".repeat(100) }), "x".repeat(60));
  assert.strictEqual(argSummary({ foo: 42 }), "foo");
});

test("breakLongLines entfernt Steuerzeichen und wrappt lange Zeilen", () => {
  assert.strictEqual(breakLongLines("a\u0007b\u007fc"), "abc");
  assert.strictEqual(breakLongLines("x".repeat(250)).split("\n").length, 3); // 120+120+10
  assert.strictEqual(breakLongLines("kurz\nzeile"), "kurz\nzeile");
  assert.strictEqual(breakLongLines("ä😀中"), "ä😀中"); // Umlaute/Emoji/CJK bleiben
});

test("formatTime liefert Uhrzeit für heute", () => {
  const now = Date.now();
  const t = formatTime(now);
  assert.match(t, /^\d{2}:\d{2}$/);
});

test("presetCron baut 5-Feld-Cron aus Presets", () => {
  assert.strictEqual(presetCron("hourly"), "0 * * * *");
  assert.strictEqual(presetCron("daily", { time: "07:30" }), "30 7 * * *");
  assert.strictEqual(presetCron("weekdays", { time: "18:00" }), "0 18 * * 1-5");
  assert.strictEqual(presetCron("weekend", { time: "09:00" }), "0 9 * * 0,6");
  assert.strictEqual(presetCron("weekly", { time: "08:15", day: 1 }), "15 8 * * 1");
  assert.strictEqual(presetCron("monthly", { time: "09:00", dayOfMonth: 15 }), "0 9 15 * *");
});

test("presetCron clampst ungültige Werte", () => {
  assert.strictEqual(presetCron("daily", { time: "99:99" }), "59 23 * * *");
  assert.strictEqual(presetCron("weekly", { time: "09:00", day: 9 }), "0 9 * * 6");
  assert.strictEqual(presetCron("monthly", { time: "09:00", dayOfMonth: 99 }), "0 9 31 * *");
});

test("cronLabel übersetzt Cron in Deutsch", () => {
  assert.strictEqual(cronLabel("0 * * * *"), "stündlich");
  assert.strictEqual(cronLabel("30 7 * * *"), "täglich um 07:30");
  assert.strictEqual(cronLabel("0 18 * * 1-5"), "wochentags um 18:00");
  assert.strictEqual(cronLabel("0 9 * * 0,6"), "am Wochenende um 09:00");
  assert.strictEqual(cronLabel("15 8 * * 1"), "jeden Mo um 08:15");
  assert.strictEqual(cronLabel("0 9 15 * *"), "monatlich am 15. um 09:00");
});

test("cronLabel fällt bei unbekanntem Muster auf rohen Cron zurück", () => {
  assert.strictEqual(cronLabel("*/15 8-17 * * 1-5"), "*/15 8-17 * * 1-5");
  assert.strictEqual(cronLabel("kaputt"), "kaputt");
});

test("toolMeta übersetzt bekannte pi-Werkzeuge in Deutsch + Icon", () => {
  assert.deepStrictEqual(toolMeta("bash"), { label: "Befehl", icon: "💻", category: "system" });
  assert.deepStrictEqual(toolMeta("read"), { label: "Datei lesen", icon: "📄", category: "file" });
  assert.deepStrictEqual(toolMeta("web_fetch"), { label: "Webseite abrufen", icon: "🌐", category: "web" });
  assert.strictEqual(toolLabel("bash"), "Befehl");
});

test("toolMeta fällt über Präfix-Heuristik auf sinnvolle Kategorien zurück", () => {
  assert.strictEqual(toolMeta("memory_search").category, "memory");
  assert.strictEqual(toolMeta("calendar_list_events").icon, "📅");
  assert.strictEqual(toolMeta("github_foo").icon, "🐙");
  assert.strictEqual(toolMeta("skill_bar").category, "search");
});

test("toolMeta liefert rohen Namen + 🔧 bei unbekanntem Werkzeug", () => {
  assert.deepStrictEqual(toolMeta("völlig_unbekannt"), { label: "völlig_unbekannt", icon: "🔧", category: "other" });
});
