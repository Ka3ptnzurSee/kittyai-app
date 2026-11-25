import { test } from "node:test";
import assert from "node:assert";
import { isGeneratedFileHref, fileExtOf, isFallbackReply } from "../lib.ts";
import { joinTurnSegments, longestTurnText, turnTextOfLastTurn, collapseTurnBubbles, turnKeyOf, INCOMPLETE_TURN_HINT, TURN_TOOL_PREFIX, TURN_SEGMENT_SEP, isRestartErrorKind, isRestartErrorText, RESTART_RELOAD_DELAYS_MS, shouldCollapseBubble, COLLAPSED_HINT, MAX_INLINE_TEXT_CHARS, LOCAL_TRUNC_MARKER, hasLocalTruncation, healTruncatedMessages, createOpenedRegistry, Utf8Decoder, SseParser, argSummary, breakLongLines, breakUnbreakable, formatTime, relativeTime, presetCron, cronLabel, toolMeta, toolLabel, safeImageUri, absoluteImageUri, compactChatsForStorage, trimChatsForStorage, mergeServerTail, MAX_STORAGE_CHARS, MAX_STORED_MESSAGES, sanitizeLoadedMessages, chatScrollPlan, stripErrorFlags, rehaTagName, filterChatsBySource, chatSourceCounts } from "../lib.ts";

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

test("relativeTime: Sekunden/Minuten/Stunden/Tage", () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(relativeTime(now - 5_000, now), "gerade eben");
  assert.strictEqual(relativeTime(now - 5 * 60_000, now), "vor 5 Min");
  assert.strictEqual(relativeTime(now - 2 * 3_600_000, now), "vor 2 Std");
  assert.strictEqual(relativeTime(now - 25 * 3_600_000, now), "gestern");
  assert.strictEqual(relativeTime(now - 3 * 86_400_000, now), "vor 3 Tagen");
});

test("relativeTime: alte und kaputte Werte kippen nicht", () => {
  const now = 1_700_000_000_000;
  assert.match(relativeTime(now - 90 * 86_400_000, now), /^\d{2}\.\d{2}\.\d{2}$/);
  assert.strictEqual(relativeTime(Number.NaN, now), "");
  assert.strictEqual(relativeTime(now + 5_000, now), "gerade eben"); // Zukunft
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

test("SseParser parst ein großes done-Event (148 Tool-Karten, ~600 KB) statt es zu verwerfen", () => {
  // Regression: MAX_EVENT_CHARS lag bei 64 KB → echte done-Events (bis 135 KB,
  // mit Tool-Karten auch ~600 KB) wurden STILL verworfen: Antwort/DIL fehlten.
  const p = new SseParser();
  const activity = Array.from({ length: 148 }, (_, i) => ({ id: `t${i}`, tool: "bash", status: "ok", result: "x".repeat(4000) }));
  const payload = JSON.stringify({ type: "done", data: { reply: "Antwort", activity } });
  assert.ok(payload.length > 500000, `Payload zu klein: ${payload.length}`);
  const out = p.push(`data: ${payload}\n\n`);
  assert.strictEqual(out.length, 1);
  assert.strictEqual((out[0] as { type: string }).type, "done");
});

test("SseParser verwirft nur pathologisch große Events (> 4 MB)", () => {
  const p = new SseParser(10000000);
  const huge = `data: {"type":"text","data":"${"x".repeat(5 * 1024 * 1024)}"}\n\n`;
  assert.deepStrictEqual(p.push(huge), []);
});

test("SseParser wirft bei Puffer-Überlauf den unvollständigen Rest weg (kein Kopf-Abschneiden)", () => {
  const p = new SseParser(1000);
  assert.deepStrictEqual(p.push('data: {"type":"text","data":"' + "y".repeat(2000)), []); // kein Delimiter → Puffer > Deckel
  // Folge-Event muss danach wieder sauber geparst werden
  assert.deepStrictEqual(p.push('data: {"type":"ok"}\n\n'), [{ type: "ok" }]);
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

// ── Layout-Schutz: „unendlich lange weiße Balken" ──────────────────────────
import { tooTall, normalizeBlankRuns, stripDilFences, isBlankAiMessage, MAX_BUBBLE_PT, BUBBLE_PREVIEW_PT } from "../lib.ts";

test("tooTall: Schwelle greift, Müll-Werte crashen nicht", () => {
  assert.strictEqual(tooTall(0), false);
  assert.strictEqual(tooTall(1200), false);
  assert.strictEqual(tooTall(MAX_BUBBLE_PT), false);
  assert.strictEqual(tooTall(MAX_BUBBLE_PT + 1), true);
  assert.strictEqual(tooTall(50000), true);
  // feindliche Eingaben
  assert.strictEqual(tooTall(NaN), false);
  assert.strictEqual(tooTall(Infinity), false);
  assert.strictEqual(tooTall(-1), false);
  assert.strictEqual(tooTall("4999" as unknown as number), false);
  assert.strictEqual(tooTall("13000" as unknown as number), true);
  assert.ok(BUBBLE_PREVIEW_PT < MAX_BUBBLE_PT);
});

test("normalizeBlankRuns: hunderte Leerzeilen werden zusammengefasst", () => {
  const monster = "Zeile 1" + "\n".repeat(500) + "Zeile 2";
  const out = normalizeBlankRuns(monster, 6);
  assert.ok(out.split("\n").length <= 8, `zu viele Zeilen: ${out.split("\n").length}`);
  assert.ok(out.startsWith("Zeile 1"));
  assert.ok(out.endsWith("Zeile 2"));
  // normale Formatierung bleibt unangetastet
  const normal = "a\n\n\nb";
  assert.strictEqual(normalizeBlankRuns(normal, 6), normal);
  // kaputte Parameter
  assert.strictEqual(typeof normalizeBlankRuns("a\n\nb", NaN as unknown as number), "string");
  assert.strictEqual(normalizeBlankRuns("", 6), "");
});

test("stripDilFences: JSON-Widgets zählen nicht als sichtbarer Text", () => {
  assert.strictEqual(stripDilFences("Hallo ```dil\n{\"type\":\"Text\"}\n``` Welt").trim(), "Hallo  Welt");
  assert.strictEqual(stripDilFences(undefined as unknown as string), "");
  assert.strictEqual(stripDilFences("nur Prosa"), "nur Prosa");
});

test("isBlankAiMessage: erkennt echte weiße Blasen, schont Inhalte", () => {
  assert.strictEqual(isBlankAiMessage({ role: "assistant", text: "" }), true);
  assert.strictEqual(isBlankAiMessage({ role: "assistant", text: "   \n\n " }), true);
  // nur ein DIL-Fence = nichts sichtbares → weiße Blase
  assert.strictEqual(isBlankAiMessage({ role: "assistant", text: "```dil\n{\"type\":\"Text\"}\n```" }), true);
  // Inhalte schützen die Blase
  assert.strictEqual(isBlankAiMessage({ role: "assistant", text: "Antwort" }), false);
  assert.strictEqual(isBlankAiMessage({ role: "assistant", text: "", activity: [{ id: "t" }] }), false);
  assert.strictEqual(isBlankAiMessage({ role: "assistant", text: "", images: [{ uri: "https://x/y.png" }] }), false);
  assert.strictEqual(isBlankAiMessage({ role: "assistant", text: "", dil: [{ type: "Text" }] }), false);
  assert.strictEqual(isBlankAiMessage({ role: "assistant", text: "", error: { type: "Timeout" } }), false);
  // User-Nachrichten sind nie „leere KI-Blasen"
  assert.strictEqual(isBlankAiMessage({ role: "user", text: "" }), false);
  // Müll
  assert.strictEqual(isBlankAiMessage(null as unknown as { role: string }), false);
  assert.strictEqual(isBlankAiMessage({ role: "assistant", text: null }), true);
});

// --- Erzeugte Dateien (Datei-Karten im Chat) ---
test("isGeneratedFileHref erkennt generierte Dateien", () => {
  assert.strictEqual(isGeneratedFileHref("/generated/bericht.docx"), true);
  assert.strictEqual(isGeneratedFileHref("/generated/folien.pptx"), true);
  assert.strictEqual(isGeneratedFileHref("/generated/zahlen.xlsx"), true);
  assert.strictEqual(isGeneratedFileHref("/generated/scan.pdf"), true);
  assert.strictEqual(isGeneratedFileHref("https://hashtagweinboehla.de/generated/a.pdf"), true);
  assert.strictEqual(isGeneratedFileHref("/generated/a.docx?v=2"), true);
});

test("isGeneratedFileHref lehnt Fremdes ab", () => {
  assert.strictEqual(isGeneratedFileHref("/generated/bild.jpg"), false);
  assert.strictEqual(isGeneratedFileHref("/web/reha.html"), false);
  assert.strictEqual(isGeneratedFileHref("javascript:alert(1)//x.pdf"), false);
  assert.strictEqual(isGeneratedFileHref(""), false);
  assert.strictEqual(isGeneratedFileHref("/generated/"), false);
});

test("fileExtOf liest die Endung", () => {
  assert.strictEqual(fileExtOf("/generated/a.docx"), "docx");
  assert.strictEqual(fileExtOf("https://x.de/a.PDF?x=1"), "pdf");
  assert.strictEqual(fileExtOf("/generated/ohne"), "");
  assert.strictEqual(fileExtOf(""), "");
});

test("compactChatsForStorage lässt kleine Verläufe unangetastet", () => {
  const chats = [{ id: "a", updatedAt: 2, messages: [{ t: 1 }, { t: 2 }] }];
  assert.deepStrictEqual(compactChatsForStorage(chats), chats);
});

test("compactChatsForStorage halbiert Nachrichten, wenn der Deckel greift (nie unter 8)", () => {
  const messages = Array.from({ length: 1000 }, (_, i) => ({ i }));
  const chats = [{ id: "a", updatedAt: 1, messages }];
  const out = compactChatsForStorage(chats, 5000, 12_000, 30_000);
  assert.ok(JSON.stringify(out).length <= 30_000);
  assert.ok(out[0].messages.length >= 8);
  // die NEUESTEN Nachrichten bleiben erhalten
  assert.deepStrictEqual(out[0].messages[out[0].messages.length - 1], { i: 999 });
});

// Kern des Feld-Bugs (21.11.2026): eine einzige lange Antwort sprengte das Budget und
// `trimChatsForStorage` opferte danach GANZE Chats — nach dem Neustart waren sie weg.
test("compactChatsForStorage löscht NIE einen Chat-Eintrag (auch nicht bei Riesen-Antworten)", () => {
  const mk = (id: string, updatedAt: number, len: number) => ({
    id,
    title: `Chat ${id}`,
    updatedAt,
    messages: [
      { id: `${id}-u`, role: "user", text: "frage " + id },
      { id: `${id}-a`, role: "assistant", text: "y".repeat(len) },
    ],
  });
  const chats = [mk("a", 1, 400_000), mk("b", 2, 400_000), mk("c", 3, 2000), mk("d", 4, 9000)];
  const out = compactChatsForStorage(chats);
  const ids = out.map((c) => c.id);
  assert.deepStrictEqual(ids, ["a", "b", "c", "d"]); // alle vier bleiben, Reihenfolge erhalten
  // der große Text wurde gedeckelt, die Nutzernachricht lebt weiter
  const a = out.find((c) => c.id === "a")!;
  assert.ok((a.messages[0] as { text: string }).text.includes("frage a"));
  assert.ok((a.messages[1] as { text: string }).text.length < 400_000);
});

test("compactChatsForStorage gibt bei extremem Budget den Körper auf, behält aber den Eintrag + Vorschau", () => {
  const chats = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`,
    title: `Chat ${i}`,
    updatedAt: i,
    messages: [{ id: `m${i}`, role: "assistant", text: `antwort ${i} ` + "z".repeat(20_000) }],
  }));
  const out = compactChatsForStorage(chats, 200, 12_000, 8_000);
  assert.strictEqual(out.length, 12); // kein Chat verloren
  assert.deepStrictEqual(out.map((c) => c.id), chats.map((c) => c.id));
  assert.ok(out.every((c) => !!c.title));
});

// ── mergeServerTail: Antworten nachträglich vom Server holen ──
test("mergeServerTail hängt eine fehlende Antwort an (Frage lokal da, Antwort nie gespeichert)", () => {
  const local = [{ id: "u1", role: "user", text: "Wie ist der Stand?" }];
  const server = [
    { id: "s1", role: "user", text: "Wie ist der Stand?" },
    { id: "s2", role: "assistant", text: "Alles erledigt." },
  ];
  const out = mergeServerTail(local, server);
  assert.ok(out);
  assert.strictEqual(out!.length, 2);
  assert.strictEqual(out![1].text, "Alles erledigt.");
});

test("mergeServerTail holt den ganzen Verlauf, wenn lokal nichts mehr da ist (Auto-Compact)", () => {
  const server = [
    { id: "s1", role: "user", text: "hallo" },
    { id: "s2", role: "assistant", text: "hi" },
  ];
  const out = mergeServerTail([], server);
  assert.deepStrictEqual(out, [
    { id: "s1", role: "user", text: "hallo" },
    { id: "s2", role: "assistant", text: "hi" },
  ]);
});

test("mergeServerTail doppelt nichts, wenn die Antwort lokal schon vollständig ist", () => {
  const local = [
    { id: "u1", role: "user", text: "hallo" },
    { id: "a1", role: "assistant", text: "hi" },
  ];
  const server = [
    { id: "s1", role: "user", text: "hallo" },
    { id: "s2", role: "assistant", text: "hi" },
  ];
  assert.strictEqual(mergeServerTail(local, server), null);
});

test("mergeServerTail ignoriert einen Server, der hinterherhängt (Frage nie angekommen)", () => {
  const local = [
    { id: "u1", role: "user", text: "erste" },
    { id: "u2", role: "user", text: "zweite (offline gesendet)" },
  ];
  const server = [{ id: "s1", role: "user", text: "erste" }, { id: "s2", role: "assistant", text: "ok" }];
  assert.strictEqual(mergeServerTail(local, server), null);
});

// ── Lange Antworten: nicht mehr abschneiden (Anzeige-Schwelle) ──────────────
test("Text 9000 Zeichen → wird vollständig gerendert (kein Auto-Collapse)", () => {
  const text = ("Zeile mit Inhalt\n".repeat(600) + "x".repeat(9000)).slice(0, 9000);
  assert.strictEqual(text.length, 9000);
  assert.strictEqual(shouldCollapseBubble(text), false, "9000 Z darf NICHT eingeklappt werden");
  // und die lokale Speicherung kappt 9000 Z ebenfalls nicht (kein Verlust)
  const chats = [{ id: "c1", messages: [{ id: "m1", role: "assistant", text }] }];
  const out = compactChatsForStorage(chats);
  const stored = String((out[0].messages[0] as { text: string }).text);
  assert.strictEqual(stored.length, 9000);
  assert.strictEqual(hasLocalTruncation(stored), false);
});

test("Text > 12k → Hinweiszeile vorhanden (kein kommentarloser Schnitt)", () => {
  const text = "x".repeat(MAX_INLINE_TEXT_CHARS + 1);
  assert.strictEqual(shouldCollapseBubble(text), true);
  assert.match(COLLAPSED_HINT, /gek\u00fcrzt/);
  assert.match(COLLAPSED_HINT, /volle Antwort/);
  // gespeicherter Text trägt den Kürzungsmarker (Volltext lädt nach)
  const chats = [{ id: "c2", messages: [{ id: "m2", role: "assistant", text: "y".repeat(50000) }] }];
  const out = compactChatsForStorage(chats);
  const stored = String((out[0].messages[0] as { text: string }).text);
  assert.ok(stored.length < 50000);
  assert.strictEqual(hasLocalTruncation(stored), true, "Marker fehlt: " + stored.slice(-80));
});

test("lokaler Text mit Kürzungsmarker → wird durch Server-Volltext ersetzt", () => {
  const full = "A".repeat(30000) + " ENDE";
  const local = [
    { id: "u1", role: "user", text: "lange Antwort bitte" },
    { id: "a1", role: "assistant", text: "A".repeat(12000) + LOCAL_TRUNC_MARKER },
  ];
  const server = [
    { id: "s1", role: "user", text: "lange Antwort bitte" },
    { id: "s2", role: "assistant", text: full },
  ];
  const out = healTruncatedMessages(local, server);
  assert.ok(out, "gekappter Text muss geheilt werden");
  assert.strictEqual(out![1].text, full);
  assert.strictEqual(hasLocalTruncation(out![1].text), false);
  // unveränderter Verlauf → null (kein Re-Render/Endlos-Patch)
  assert.strictEqual(healTruncatedMessages([{ id: "a1", role: "assistant", text: full }], server), null);
});

test("forceOpen bleibt nach Remount erhalten (pro Chat + Message-ID)", async () => {
  const mem = new Map<string, string>();
  const store = {
    getItem: async (k: string) => mem.get(k) ?? null,
    setItem: async (k: string, v: string) => { mem.set(k, v); },
  };
  const first = createOpenedRegistry(store);
  await first.remember("chat-1", "m-42");
  // "Remount": neue Instanz, derselbe Storage
  const second = createOpenedRegistry(store);
  const ids = await second.load("chat-1");
  assert.deepStrictEqual(ids, ["m-42"]);
  assert.strictEqual(await second.isOpen("chat-1", "m-42"), true);
  // anderer Chat bleibt unberührt; Mehrfach-Merken erzeugt keine Dublette
  assert.strictEqual(await second.isOpen("chat-2", "m-42"), false);
  await second.remember("chat-1", "m-42");
  assert.deepStrictEqual(await second.load("chat-1"), ["m-42"]);
  // kaputter Storage-Inhalt crasht nicht
  mem.set("pi.opened.v1.chat-3", "{nicht json");
  assert.deepStrictEqual(await second.load("chat-3"), []);
});

test("Server hat 300 msgs, lokal 240 → älteste 60 werden nachgezogen", () => {
  const server = Array.from({ length: 300 }, (_, i) => ({
    id: "s" + i,
    role: i % 2 === 0 ? "user" : "assistant",
    text: "Nachricht " + i,
  }));
  const local = server.slice(60).map((m) => ({ ...m }));
  const out = mergeServerTail(local, server);
  assert.ok(out, "ältere Nachrichten müssen nachgezogen werden");
  assert.strictEqual(out!.length, 300);
  assert.strictEqual(out![0].id, "s0");
  assert.strictEqual(out![59].id, "s59");
  assert.strictEqual(out![60].id, "s60");
  // der letzte lokale Eintrag bleibt an derselben Stelle (keine Verschiebung)
  assert.strictEqual(out![299].id, "s299");
  // bereits vollständig lokal → nichts tun (kein doppelter Verlauf)
  assert.strictEqual(mergeServerTail(server, server), null);
});

// ── sanitizeLoadedMessages: persistierte Fehlerkarten beim Start verwerfen ──
test("sanitizeLoadedMessages entfernt gespeicherte Fehlerkarten (Chat wird nicht dauerhaft rot)", () => {
  const messages = [
    { id: "u1", role: "user", text: "hallo" },
    { id: "a1", role: "assistant", text: "", error: { type: "aborted", retryable: true } },
  ];
  const out = sanitizeLoadedMessages(messages);
  assert.strictEqual(out.length, 1); // leere Fehler-Bubble ist weg
  assert.strictEqual(out[0].id, "u1");
});

test("sanitizeLoadedMessages behält die Antwort, wenn Text da ist (nur error fällt weg)", () => {
  const messages = [
    { id: "u1", role: "user", text: "hallo" },
    { id: "a1", role: "assistant", text: "Antwort kam an", error: { type: "network", retryable: true } },
  ];
  const out = sanitizeLoadedMessages(messages);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].error, undefined);
  assert.strictEqual(out[1].text, "Antwort kam an");
  assert.strictEqual(messages[1].error.type, "network"); // Original unverändert
});

test("sanitizeLoadedMessages behält den Resume-Anker (letzte leere Bubble)", () => {
  const messages = [
    { id: "u1", role: "user", text: "hallo" },
    { id: "a1", role: "assistant", text: "", error: { type: "network", retryable: true } },
  ];
  const out = sanitizeLoadedMessages(messages, "a1");
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].error, undefined);
});

test("sanitizeLoadedMessages lässt inhaltsvolle Nachrichten unangetastet", () => {
  const messages = [
    { id: "u1", role: "user", text: "frage" },
    { id: "a1", role: "assistant", text: "antwort" },
    { id: "a2", role: "assistant", text: "", activity: [{ tool: "bash" }] },
    { id: "a3", role: "assistant", text: "", dil: [{ type: "Table" }] },
  ];
  assert.deepStrictEqual(sanitizeLoadedMessages(messages), messages);
});

// ── stripErrorFlags: Speichern ohne Fehlerkarten, Text bleibt ──
test("isFallbackReply erkennt die Notausgang-Texte des Servers", () => {
  assert.strictEqual(isFallbackReply("Fertig — das Modell hat eine leere Antwort geliefert. Bitte erneut senden."), true);
  assert.strictEqual(isFallbackReply("Fertig — es kam keine Textantwort vom Modell, nur Werkzeug-Aufrufe (3×). Sag mach weiter, dann fasse ich das Ergebnis in Worte."), true);
  assert.strictEqual(isFallbackReply("Fertig – das Modell hat eine leere Antwort geliefert. Bitte erneut senden."), true);
  assert.strictEqual(isFallbackReply("Normale Antwort"), false);
  assert.strictEqual(isFallbackReply(""), false);
  assert.strictEqual(isFallbackReply(undefined), false);
});

test("sanitizeLoadedMessages wirft gespeicherte Fallback-Texte raus", () => {
  const msgs = [
    { id: "u1", role: "user", text: "reha" },
    { id: "a1", role: "assistant", text: "Fertig — das Modell hat eine leere Antwort geliefert. Bitte erneut senden." },
    { id: "a2", role: "assistant", text: "Echte Antwort" },
  ];
  const out = sanitizeLoadedMessages(msgs);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map((m: any) => m.id), ["u1", "a2"]);
});

test("stripErrorFlags entfernt nur das error-Flag, Text bleibt stehen", () => {
  const msgs = [
    { id: "u1", role: "user", text: "hallo" },
    { id: "a1", role: "assistant", text: "halbe Antwor", error: { type: "502", retryable: true } },
  ];
  const out = stripErrorFlags(msgs);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].error, undefined);
  assert.strictEqual(out[1].text, "halbe Antwor");
  assert.deepStrictEqual(out[0], msgs[0]);
});

test("stripErrorFlags ist robust gegen kaputte Eingaben", () => {
  assert.deepStrictEqual(stripErrorFlags([]), []);
  assert.deepStrictEqual(stripErrorFlags(null as unknown as []), []);
  const keep = [{ id: "x", role: "assistant", text: "ok" }];
  assert.deepStrictEqual(stripErrorFlags(keep), keep);
});

test("sanitizeLoadedMessages ist robust gegen leere/kaputte Einträge", () => {
  assert.deepStrictEqual(sanitizeLoadedMessages([]), []);
  assert.deepStrictEqual(sanitizeLoadedMessages([{ id: "x", role: "user", text: "" }]).length, 1);
  assert.strictEqual(sanitizeLoadedMessages(null as unknown as []).length, 0);
});

// Reha: Wochentag kommt aus dem Datum, nicht aus dem Index. Der Server liefert
// weekday 0-basiert (0 = Montag), alte Staende ISO (1 = Montag) -> frueher hiess
// Mittwoch "Dienstag" und das Lagebild zeigte den Plan vom Vortag.
test("rehaTagName liest den Wochentag aus dem Datum", () => {
  assert.strictEqual(rehaTagName({ today: "2026-11-16", weekday: 0 }), "Montag");
  assert.strictEqual(rehaTagName({ today: "2026-11-17", weekday: 1 }), "Dienstag");
  assert.strictEqual(rehaTagName({ today: "2026-11-18", weekday: 2 }), "Mittwoch");
  assert.strictEqual(rehaTagName({ today: "2026-11-21", weekday: 5 }), "Samstag");
  assert.strictEqual(rehaTagName({ today: "2026-11-22", weekday: 6 }), "Sonntag");
});

test("rehaTagName ignoriert einen falschen weekday-Index", () => {
  // Datum gewinnt: 2026-11-18 ist Mittwoch, auch wenn weekday=1 (Dienstag) kommt
  assert.strictEqual(rehaTagName({ today: "2026-11-18", weekday: 1 }), "Mittwoch");
  // Alt-Server-Format (ISO): weekday=3 = Mittwoch, Datum sagt auch Mittwoch
  assert.strictEqual(rehaTagName({ today: "2026-11-18", weekday: 3 }), "Mittwoch");
});

test("rehaTagName faellt ohne Datum auf den 0-basierten Index zurueck", () => {
  assert.strictEqual(rehaTagName({ weekday: 0 }), "Montag");
  assert.strictEqual(rehaTagName({ weekday: 6 }), "Sonntag");
});

test("rehaTagName ist null-sicher", () => {
  assert.strictEqual(rehaTagName(null), "");
  assert.strictEqual(rehaTagName(undefined), "");
  assert.strictEqual(rehaTagName({}), "");
  assert.strictEqual(rehaTagName({ today: "18.11.2026" }), "");
  assert.strictEqual(rehaTagName({ today: "2026-11-18", weekday: Number.NaN }), "Mittwoch");
});

test("Speicher-Deckel bleibt klein (Performance: AES-GCM im JS-Thread)", () => {
  // Regression: 8 MB Bestand kostete 331-664 ms AES-GCM pro Speichern (gemessen) und
  // blockierte die UI. Der Deckel muss deutlich darunter bleiben.
  assert.ok(MAX_STORAGE_CHARS <= 1_000_000, "MAX_STORAGE_CHARS zu gross: " + MAX_STORAGE_CHARS);
  assert.ok(MAX_STORED_MESSAGES <= 500, "MAX_STORED_MESSAGES zu gross: " + MAX_STORED_MESSAGES);
  const big = Array.from({ length: 40 }, (_, c) => ({
    id: "c" + c,
    updatedAt: c,
    messages: Array.from({ length: 400 }, (_, i) => ({ id: "m" + i, role: "user", text: "y".repeat(900) })),
  }));
  const out = trimChatsForStorage(big);
  const chars = JSON.stringify(out).length;
  assert.ok(chars <= MAX_STORAGE_CHARS * 1.2, "gespeicherter Bestand zu gross: " + chars);
  for (const c of out) assert.ok(c.messages.length <= MAX_STORED_MESSAGES, "Chat " + c.id + " hat " + c.messages.length + " Nachrichten");
});

test("filterChatsBySource trennt lokale, Server-, WhatsApp- und Terminal-Chats", () => {
  const list = [
    { id: "l1", source: "app" as const },                            // lokal
    { id: "r1", source: "app" as const, remote: true },              // nur Server
    { id: "w1", source: "whatsapp" as const, remote: true },
    { id: "t1", source: "terminal" as const, remote: true },
    { id: "x1" },                                                    // source fehlt = app
  ];
  assert.deepStrictEqual(filterChatsBySource(list, "all").map((c) => c.id), ["l1", "r1", "w1", "t1", "x1"]);
  assert.deepStrictEqual(filterChatsBySource(list, "app").map((c) => c.id), ["l1", "x1"]);
  assert.deepStrictEqual(filterChatsBySource(list, "server").map((c) => c.id), ["r1"]);
  assert.deepStrictEqual(filterChatsBySource(list, "whatsapp").map((c) => c.id), ["w1"]);
  assert.deepStrictEqual(filterChatsBySource(list, "terminal").map((c) => c.id), ["t1"]);
});

test("chatSourceCounts zählt jede Ansicht (Summe der Teile = alle)", () => {
  const list = [
    { source: "app" }, { source: "app", remote: true }, { source: "app", remote: true },
    { source: "whatsapp" }, { source: "terminal" }, { source: "terminal" },
  ];
  const c = chatSourceCounts(list);
  assert.strictEqual(c.all, 6);
  assert.strictEqual(c.app, 1);
  assert.strictEqual(c.server, 2);
  assert.strictEqual(c.whatsapp, 1);
  assert.strictEqual(c.terminal, 2);
  assert.strictEqual(c.app + c.server + c.whatsapp + c.terminal, c.all);
});

test("chatSourceCounts: leere Liste und fremde source-Werte kippen nichts", () => {
  assert.deepStrictEqual(chatSourceCounts([]), { all: 0, app: 0, server: 0, whatsapp: 0, terminal: 0 });
  const c = chatSourceCounts([{ source: "unbekannt" }, { source: "" }]);
  assert.strictEqual(c.all, 2);
  assert.strictEqual(c.app, 1); // "" → app
  assert.strictEqual(chatSourceCounts([{ source: "unbekannt" }]).app, 0);
});


// --- Nachladen nach Server-Neustart (22.11.2026) -----------------------------
// Befund: Turns, die "Server wurde neu gestartet" meldeten, blieben als leere bzw.
// abgebrochene Blase stehen, obwohl der Server die Teilantwort gespeichert hatte.
test("isRestartErrorKind erkennt die Neustart-Fehlerarten", () => {
  assert.equal(isRestartErrorKind("server_restart"), true);
  assert.equal(isRestartErrorKind("engine_down"), true);
  assert.equal(isRestartErrorKind("SERVER_RESTART"), true);
  assert.equal(isRestartErrorKind(" server_restart "), true);
  assert.equal(isRestartErrorKind("timeout"), false);
  assert.equal(isRestartErrorKind("rate_limit"), false);
  assert.equal(isRestartErrorKind(""), false);
});

test("isRestartErrorKind/isRestartErrorText greifen auch ohne kind-Feld", () => {
  const msg = "Server wurde neu gestartet, bevor die Antwort fertig war — bitte Nachricht erneut senden.";
  assert.equal(isRestartErrorKind("", msg), true);
  assert.equal(isRestartErrorText(msg), true);
  assert.equal(isRestartErrorText("Server nicht bereit"), true);
  assert.equal(isRestartErrorText("Zeitüberschreitung"), false);
  // Robust gegen fehlende/kaputte Werte (kein Throw)
  for (const bad of ["", "   ", "Kontext zu lang", "Limit erreicht"]) {
    assert.equal(isRestartErrorText(bad), false);
  }
  assert.equal(isRestartErrorText(undefined), false);
  assert.equal(isRestartErrorKind(undefined as unknown as string), false);
});

test("RESTART_RELOAD_DELAYS_MS: erster Versuch sofort, zweiter nach 3 s", () => {
  assert.deepEqual([...RESTART_RELOAD_DELAYS_MS], [0, 3000]);
});

// ── Turn-Volltext: eine Blase pro Turn (23.11.2026) ────────────────────────
test("turnKeyOf bestimmt den Turn: User-ID, turnId-Anker, replyTo oder Fallback", () => {
  assert.strictEqual(turnKeyOf({ id: "u1", role: "user", text: "frage" }), "u1");
  assert.strictEqual(turnKeyOf({ id: "a1", role: "assistant", turnId: "u1" }), "u1");
  assert.strictEqual(turnKeyOf({ id: "a1", role: "assistant", replyTo: "u1" }), "u1");
  assert.strictEqual(turnKeyOf({ id: "a1", role: "assistant", replyTo: { id: "u2" } }), "u2");
  assert.strictEqual(turnKeyOf({ id: "a1", role: "assistant" }), "a1");
  assert.strictEqual(turnKeyOf({ id: "a1", role: "assistant" }, "u9"), "u9");
  assert.strictEqual(turnKeyOf(null, "u9"), "u9");
});

test("joinTurnSegments fügt ALLE Assistant-Segmente eines Turns zusammen (Trenner: Leerzeile)", () => {
  const text = joinTurnSegments([
    { role: "assistant", text: "Ich prüfe das.", tools: ["bash"] },
    { role: "assistant", text: "Ergebnis: 42" },
    { role: "assistant", text: "Fertig." },
  ]);
  // Werkzeug-Zeile steht VOR dem Text ihres Segments, Segmente durch Leerzeile getrennt
  assert.strictEqual(text, "· Werkzeug: bash\n\nIch prüfe das.\n\nErgebnis: 42\n\nFertig.");
  assert.ok(text.startsWith(TURN_TOOL_PREFIX), "Werkzeug-Zeile beginnt mit dem Prefix");
  assert.strictEqual(text.split(TURN_SEGMENT_SEP).length, 4);
  // Setting „Werkzeug-Zeilen aus": nur Text
  const plain = joinTurnSegments(
    [{ role: "assistant", text: "Ich prüfe das.", tools: ["bash"] }, { role: "assistant", text: "Ergebnis: 42" }],
    { includeTools: false },
  );
  assert.strictEqual(plain, "Ich prüfe das.\n\nErgebnis: 42");
  // leerer/fehlender Input crasht nicht
  assert.strictEqual(joinTurnSegments([]), "");
  assert.strictEqual(joinTurnSegments(null as unknown as []), "");
});

test("longestTurnText: der LÄNGERE Text gewinnt (Server darf nie verkürzen)", () => {
  const local = "kurz";
  const full = "A".repeat(500);
  assert.strictEqual(longestTurnText(local, full), full);
  assert.strictEqual(longestTurnText(full, local), full, "nie kürzer überschreiben");
  assert.strictEqual(longestTurnText(full, full), full); // Gleichstand → a
  assert.strictEqual(longestTurnText(undefined, "x"), "x");
  assert.strictEqual(longestTurnText("x", null), "x");
  // zusammengesetzter Server-Text (3 Segmente) schlägt lokalen Einzeltext
  const joined = joinTurnSegments([{ text: "eins" }, { text: "zwei" }, { text: "drei" }]);
  assert.strictEqual(longestTurnText("eins", joined), joined);
});

test("mergeServerTail fügt fehlende Segmente MITTEN im Turn ein (Summe statt letztem Segment)", () => {
  const local = [
    { id: "u1", role: "user", text: "prüfe das" },
    { id: "a1", role: "assistant", text: "Teil 1" },
  ];
  const server = [
    { id: "s1", role: "user", text: "prüfe das" },
    { id: "s2", role: "assistant", text: "Teil 1" },
    { id: "s3", role: "assistant", text: "Teil 2" },
    { id: "s4", role: "assistant", text: "Teil 3" },
  ];
  const out = mergeServerTail(local, server);
  assert.ok(out, "Server hat mehr Segmente → es muss etwas eingefügt werden");
  const segs = out!.filter((m) => m.role === "assistant");
  assert.strictEqual(segs.length, 3, "nach Merge 3 Segmente (vorher brach der Merge ab)");
  assert.strictEqual(joinTurnSegments(segs), "Teil 1\n\nTeil 2\n\nTeil 3");
  assert.strictEqual(out!.length, 4);
  // ältere Nachricht bleibt vorne, User-Nachricht unverändert
  assert.strictEqual(out![0].id, "u1");
  assert.strictEqual(turnTextOfLastTurn(out!), "Teil 1\n\nTeil 2\n\nTeil 3");

  // Segment in der MITTE fehlt (Segment 1 und 3 lokal, 2 nur auf dem Server)
  const local2 = [
    { id: "u1", role: "user", text: "prüfe das" },
    { id: "a1", role: "assistant", text: "Teil 1" },
    { id: "a3", role: "assistant", text: "Teil 3" },
  ];
  const out2 = mergeServerTail(local2, server);
  assert.ok(out2);
  assert.deepStrictEqual(out2!.map((m) => m.text), ["prüfe das", "Teil 1", "Teil 2", "Teil 3"]);
});

test("unvollständiger Turn wird markiert (incomplete:true) und bleibt EINE Blase", () => {
  const server = [
    { id: "s1", role: "user", text: "lange Antwort" },
    { id: "s2", role: "assistant", text: "Teil 1" },
    { id: "s3", role: "assistant", text: "Teil 2", incomplete: true },
  ];
  const text = turnTextOfLastTurn(server);
  assert.match(text, /Teil 1\n\nTeil 2/);
  assert.match(text, /Abgebrochen/, "abgebrochener Turn muss als unvollständig markiert sein");
  // Abschaltbar (Setting)
  assert.doesNotMatch(turnTextOfLastTurn(server, { incompleteHint: false }), /Abgebrochen/);
  // collapseTurnBubbles: aus zwei Segmenten wird EINE Blase mit der Summe
  const merged = collapseTurnBubbles([
    { id: "u1", role: "user", text: "lange Antwort" },
    { id: "s2", role: "assistant", text: "Teil 1", turnId: "u1", activity: [{ id: "t1", tool: "bash" }] },
    { id: "s3", role: "assistant", text: "Teil 2", turnId: "u1", incomplete: true },
  ]);
  assert.ok(merged, "aus 2 Segmenten muss 1 Blase werden");
  assert.strictEqual(merged!.length, 2);
  assert.strictEqual(merged![1].id, "s2", "die erste Segment-ID bleibt (stabile Keys)");
  assert.strictEqual(merged![1].text, "· Werkzeug: bash\n\nTeil 1\n\nTeil 2\n\n" + INCOMPLETE_TURN_HINT.replace(/<[^>]*>/g, "").trim());
  // ohne expliziten Anker (Server-Segmente!) werden Segmente ebenfalls gebündelt
  const noAnchor = collapseTurnBubbles([
    { id: "u1", role: "user", text: "frage" },
    { id: "s2", role: "assistant", text: "Teil 1" },
    { id: "s3", role: "assistant", text: "Teil 2" },
  ]);
  assert.ok(noAnchor, "Segmente ohne turnId müssen zu einer Blase werden");
  assert.strictEqual(noAnchor!.length, 2);
  assert.strictEqual(noAnchor![1].text, "Teil 1\n\nTeil 2");
  // keine Änderung → null (kein Re-Render/Endlos-Patch)
  assert.strictEqual(collapseTurnBubbles([{ id: "u1", role: "user", text: "x" }, { id: "a1", role: "assistant", text: "y" }]), null);
  // Fehlerkarte bleibt eine eigene Blase
  const withErr = collapseTurnBubbles([
    { id: "u1", role: "user", text: "x" },
    { id: "a1", role: "assistant", text: "Teil 1", turnId: "u1" },
    { id: "a2", role: "assistant", text: "", turnId: "u1", error: { type: "aborted" } },
  ]);
  assert.strictEqual(withErr, null, "Blasen mit Fehlerkarte werden nicht verschmolzen");
});

// --- chatScrollPlan: Chat öffnet sich immer unten (Befund 26.11.2026) ---------
test("chatScrollPlan: Stick-Modus nach dem Öffnen klebt am Ende, egal was onScroll meldet", () => {
  const p = chatScrollPlan({ now: 1000, autoScrollUntil: 0, sticking: true, nearBottom: false });
  assert.deepStrictEqual(p, { measure: false, pin: true, debounce: false },
    "im Stick-Modus: pin, nie measure/debounce");
});

test("chatScrollPlan: programmatischer Sprung klingt nach (onScroll darf nicht kippen)", () => {
  const p = chatScrollPlan({ now: 1500, autoScrollUntil: 1700, sticking: false, nearBottom: true });
  assert.strictEqual(p.measure, false, "Messwerte während des Sprungs sind Zwischenstände");
  assert.strictEqual(p.pin, false);
  assert.strictEqual(p.debounce, true, "Höhenänderung darf trotzdem ans Ende ziehen");
});

test("chatScrollPlan: nach dem Sprung misst onScroll wieder (Nutzer scrollt hoch → kein Auto-Scroll)", () => {
  const p = chatScrollPlan({ now: 2000, autoScrollUntil: 1700, sticking: false, nearBottom: false });
  assert.deepStrictEqual(p, { measure: true, pin: false, debounce: false },
    "oben gelesen: weder pin noch debounce, sonst reißt es den Nutzer nach unten");
});

test("chatScrollPlan: unten stehend → debounce springt ans Ende", () => {
  const p = chatScrollPlan({ now: 5000, autoScrollUntil: 0, sticking: false, nearBottom: true });
  assert.deepStrictEqual(p, { measure: true, pin: false, debounce: true });
});

test("chatScrollPlan: Grenze exakt am Sprung-Ende misst wieder (now === autoScrollUntil)", () => {
  const p = chatScrollPlan({ now: 1700, autoScrollUntil: 1700, sticking: false, nearBottom: true });
  assert.strictEqual(p.measure, true);
});
