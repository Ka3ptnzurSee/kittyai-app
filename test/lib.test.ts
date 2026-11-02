import { test } from "node:test";
import assert from "node:assert";
import { Utf8Decoder, SseParser, argSummary, breakLongLines, breakUnbreakable, formatTime, presetCron, cronLabel, toolMeta, toolLabel, safeImageUri, absoluteImageUri } from "../lib.ts";

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

test("breakLongLines strippt ANSI CSI- und OSC-Sequenzen", () => {
  assert.strictEqual(breakLongLines("\u001b[31mrot\u001b[0m"), "rot");
  assert.strictEqual(breakLongLines("\u001b]9;4;#16a34a\u0007text"), "text");
});

test("breakUnbreakable lässt normale Prosa unangetastet", () => {
  const prose = "kurzer Text mit Leerzeichen bleibt unverändert";
  assert.strictEqual(breakUnbreakable(prose), prose);
});

test("breakUnbreakable bricht nur unbrechbare Läufe", () => {
  assert.strictEqual(breakUnbreakable("x".repeat(250)).split("\n").length, 3); // 120+120+10
});

test("breakUnbreakable strippt ANSI und bricht danach", () => {
  const out = breakUnbreakable("a\u001b[32m".repeat(200));
  assert.ok(!out.includes("\u001b"), "kein ESC mehr im Ergebnis");
  assert.strictEqual(out.split("\n").length, 2); // 200 'a' → 120+80
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
  assert.deepStrictEqual(toolMeta("bash"), { label: "Befehl", icon: "⌘", category: "system" });
  assert.deepStrictEqual(toolMeta("read"), { label: "Datei lesen", icon: "¶", category: "file" });
  assert.deepStrictEqual(toolMeta("web_fetch"), { label: "Webseite abrufen", icon: "◎", category: "web" });
  assert.strictEqual(toolLabel("bash"), "Befehl");
});

test("toolMeta fällt über Präfix-Heuristik auf sinnvolle Kategorien zurück", () => {
  assert.strictEqual(toolMeta("memory_search").category, "memory");
  assert.strictEqual(toolMeta("calendar_list_events").icon, "▤");
  assert.strictEqual(toolMeta("github_foo").icon, "◈");
  assert.strictEqual(toolMeta("skill_bar").category, "search");
});

test("toolMeta liefert rohen Namen + ⌁ bei unbekanntem Werkzeug", () => {
  assert.deepStrictEqual(toolMeta("völlig_unbekannt"), { label: "völlig_unbekannt", icon: "⌁", category: "other" });
});

test("SseParser parst ein einzelnes Event", () => {
  const p = new SseParser();
  assert.deepStrictEqual(p.push('data: {"type":"text","data":"Hallo"}\n\n'), [{ type: "text", data: "Hallo" }]);
});

test("SseParser parst mehrere Events in einem Chunk", () => {
  const p = new SseParser();
  assert.deepStrictEqual(p.push('data: {"type":"a"}\n\ndata: {"type":"b"}\n\n'), [{ type: "a" }, { type: "b" }]);
});

test("SseParser sammelt Events über Chunk-Grenzen", () => {
  const p = new SseParser();
  const parts = ['data: {"type":"te', 'xt","data":"Hallo"}\n\n'];
  let out: unknown[] = [];
  for (const part of parts) out = out.concat(p.push(part));
  assert.deepStrictEqual(out, [{ type: "text", data: "Hallo" }]);
});

test("SseParser normalisiert CRLF-Delimiter", () => {
  const p = new SseParser();
  assert.deepStrictEqual(p.push('data: {"type":"text","data":"Hi"}\r\n\r\n'), [{ type: "text", data: "Hi" }]);
});

test("SseParser behandelt CRLF über eine Chunk-Grenze", () => {
  const p = new SseParser();
  // \r am Ende des ersten Chunks, \n am Anfang des zweiten → ein CRLF-Paar
  let out = p.push('data: {"type":"a"}\r');
  out = out.concat(p.push('\n\r\ndata: {"type":"b"}\n\n'));
  assert.deepStrictEqual(out, [{ type: "a" }, { type: "b" }]);
});

test("SseParser verwirft übergroße Einzel-Events statt sie zu parsen", () => {
  const p = new SseParser(1000000);
  const huge = `data: {"type":"text","data":"${"x".repeat(70000)}"}\n\n`;
  assert.deepStrictEqual(p.push(huge), []); // > MAX_EVENT_CHARS (65536) → verworfen
});

test("SseParser überspringt kaputtes JSON und liefert Folge-Events", () => {
  const p = new SseParser();
  assert.deepStrictEqual(p.push('data: {kaputt\n\ndata: {"type":"ok"}\n\n'), [{ type: "ok" }]);
});

test("SseParser ignoriert Events ohne data:-Feld (Kommentare/Heartbeats)", () => {
  const p = new SseParser();
  assert.deepStrictEqual(p.push(': keep-alive\n\n'), []);
});

test("SseParser akzeptiert data: ohne Leerzeichen", () => {
  const p = new SseParser();
  assert.deepStrictEqual(p.push('data:{"type":"x"}\n\n'), [{ type: "x" }]);
});

test("SseParser.flush liefert ein Event ohne finales \\n\\n", () => {
  const p = new SseParser();
  assert.deepStrictEqual(p.push('data: {"type":"text","data":"Ende"}'), []);
  assert.deepStrictEqual(p.flush(), [{ type: "text", data: "Ende" }]);
  assert.deepStrictEqual(p.flush(), []); // zweiter flush ist leer
});

test("SseParser deckelt einen hängenden Puffer ohne Chunks zu verlieren", () => {
  const p = new SseParser(10);
  // 1000 Zeichen ohne Delimiter → Puffer wird intern gekürzt, kein Crash
  assert.deepStrictEqual(p.push("x".repeat(1000)), []);
  assert.deepStrictEqual(p.flush(), []); // kein data:-Feld → nichts Verwertbares
});

// --- Bilder in Chat-Antworten (Markdown-Bilder + Server-Anlagen) ---

test("safeImageUri erlaubt https und data:image, blockt den Rest", () => {
  assert.strictEqual(safeImageUri("https://h.de:8446/generated/IMG_1_a.jpg"), "https://h.de:8446/generated/IMG_1_a.jpg");
  assert.strictEqual(safeImageUri("  https://h.de/x.png  "), "https://h.de/x.png");
  const b64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  assert.strictEqual(safeImageUri(b64), b64);
  // Angriffe / Fremdschemata
  for (const bad of [
    "",
    null,
    undefined,
    "http://h.de/x.jpg",
    "file:///etc/passwd",
    "ph://ABCD-1234",
    "javascript:alert(1)",
    "https://h.de/x.jpg\nX-Injected: 1",
    "https://h.de/a b.jpg",
    "data:text/html;base64,PHNjcmlwdD4=",
    `https://h.de/${"a".repeat(3000)}.jpg`,
  ]) {
    assert.strictEqual(safeImageUri(bad as unknown as string), null, `unerwartet erlaubt: ${String(bad)}`);
  }
});

test("absoluteImageUri macht /generated/-Pfade absolut, blockt Fremdschemata", () => {
  assert.strictEqual(absoluteImageUri("/generated/IMG_1_a.jpg", "https://h.de:8446"), "https://h.de:8446/generated/IMG_1_a.jpg");
  assert.strictEqual(absoluteImageUri("/generated/IMG_1_a.jpg", "https://h.de:8446/"), "https://h.de:8446/generated/IMG_1_a.jpg");
  assert.strictEqual(absoluteImageUri("https://cdn/x.jpg", "https://h.de"), "https://cdn/x.jpg");
  // Ohne (gültige) Basis bleibt der Pfad relativ → null (iOS würde ihn nicht laden)
  assert.strictEqual(absoluteImageUri("/generated/IMG_1_a.jpg", ""), null);
  assert.strictEqual(absoluteImageUri("/generated/IMG_1_a.jpg", "h.de"), null);
  // Protokoll-relative und fremde Schemata
  assert.strictEqual(absoluteImageUri("//evil/x.jpg", "https://h.de"), null);
  assert.strictEqual(absoluteImageUri("file:///etc/passwd", "https://h.de"), null);
  assert.strictEqual(absoluteImageUri("javascript:alert(1)", "https://h.de"), null);
  assert.strictEqual(absoluteImageUri("", "https://h.de"), null);
});
