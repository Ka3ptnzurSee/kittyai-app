import { test } from "node:test";
import assert from "node:assert";
import { takeSentences, cleanForSpeech } from "../voice.ts";

test("cleanForSpeech entfernt Markdown, URLs und Emoji", () => {
  const out = cleanForSpeech("**Fett** und `code` und https://example.com/x?y=1 🎉 fertig");
  assert.ok(!out.includes("**"), out);
  assert.ok(!out.includes("`"), out);
  assert.ok(!out.includes("https://"), out);
  assert.ok(!out.includes("🎉"), out);
  assert.ok(out.includes("Fett"), out);
});

test("Datum bleibt ein Satz (kein Split nach Ordnungszahl)", () => {
  const { sentences } = takeSentences("Es ist Samstag, der 21. November 2026, kurz nach elf. ", true);
  assert.strictEqual(sentences.length, 1, JSON.stringify(sentences));
  assert.ok(sentences[0].includes("21. November"), sentences[0]);
});

test("Uhrzeit mit Punkt wird nicht zerschnitten", () => {
  const { sentences } = takeSentences("Der Termin ist um 11. 30 Uhr im Buero. ", true);
  assert.strictEqual(sentences.length, 1, JSON.stringify(sentences));
});

test("Initiale ist kein Satzende", () => {
  const { sentences } = takeSentences("Das hat P. Heinemann gemacht. ", true);
  assert.strictEqual(sentences.length, 1, JSON.stringify(sentences));
});

test("klein geschriebenes Folgewort ist kein neuer Satz", () => {
  const { sentences } = takeSentences("Das war's. der Rest kommt spaeter. ", true);
  assert.strictEqual(sentences.length, 1, JSON.stringify(sentences));
});

test("echte Satzgrenzen werden weiter getrennt", () => {
  const { sentences } = takeSentences("Erster Satz hier. Zweiter Satz dort. Dritter Satz. ", true);
  assert.strictEqual(sentences.length, 3, JSON.stringify(sentences));
  assert.strictEqual(sentences[0], "Erster Satz hier.");
});

test("Abkuerzung beendet keinen Satz", () => {
  const { sentences } = takeSentences("Das ist z. B. ein Test. ", true);
  assert.strictEqual(sentences.length, 1, JSON.stringify(sentences));
});

test("force gibt den Rest ohne Punkt am Ende aus", () => {
  const { sentences, rest } = takeSentences("Ein Satz ohne Punkt am Ende", true);
  assert.strictEqual(rest, "");
  assert.strictEqual(sentences.length, 1);
  assert.strictEqual(sentences[0], "Ein Satz ohne Punkt am Ende");
});

test("ohne force bleibt unfertiger Text im Puffer", () => {
  const { sentences, rest } = takeSentences("Fertig. und noch offen", false);
  assert.strictEqual(sentences.length, 0, JSON.stringify(sentences));
  assert.ok(rest.startsWith("Fertig."), rest);
});

test("lange Saetze werden an Wortgrenzen geteilt", () => {
  const lang = "wort ".repeat(80).trim() + ".";
  const { sentences } = takeSentences(lang, true);
  assert.ok(sentences.length >= 2, JSON.stringify(sentences.map((s) => s.length)));
  for (const s of sentences) assert.ok(s.length <= 200, String(s.length));
});

// --- Spracherkennung: 209/216 & Co. sind Session-Ende, kein Fehler ----------
import { isSpeechSessionEnd, speechErrorText, SPEECH_LANG, SPEECH_RESTART_MS, SPEECH_SESSION_CAP_MS, coalesceForSpeech, SPEECH_MIN_UNIT, SPEECH_MAX_UNIT } from "../voice.ts";

test("kAFAssistantErrorDomain 216 (gemeldeter Fall) = Session-Ende", () => {
  const ev = { error: "audio-capture", message: "The operation couldn’t be completed. (kAFAssistantErrorDomain error 216.)" };
  assert.strictEqual(isSpeechSessionEnd(ev), true);
  assert.strictEqual(speechErrorText(ev), null); // nichts anzeigen
});

test("kAFAssistantErrorDomain 209 = Session-Ende", () => {
  const ev = { error: "audio-capture", message: "The operation couldn’t be completed. (kAFAssistantErrorDomain error 209.)" };
  assert.strictEqual(speechErrorText(ev), null);
});

test("1100/1101/1107/203/1110 werden ebenfalls geschluckt", () => {
  for (const code of [203, 1100, 1101, 1107, 1110]) {
    const ev = { error: "audio-capture", message: `The operation couldn't be completed. (kAFAssistantErrorDomain error ${code}.)` };
    assert.strictEqual(speechErrorText(ev), null, `Code ${code}`);
  }
});

test("Lifecycle-Codes per error-Feld: no-speech/aborted/busy/interrupted", () => {
  for (const e of ["no-speech", "aborted", "busy", "interrupted"]) {
    assert.strictEqual(isSpeechSessionEnd({ error: e }), true, e);
  }
});

test("echte Fehler werden weiter gemeldet (Berechtigung/Netz/Mikrofon)", () => {
  assert.strictEqual(
    speechErrorText({ error: "not-allowed", message: "Request is not authorized." }),
    "Request is not authorized.",
  );
  assert.strictEqual(speechErrorText({ error: "network", message: "Connection lost." }), "Connection lost.");
  // audio-capture OHNE bekannten Code = echtes Mikrofonproblem -> anzeigen
  assert.strictEqual(
    speechErrorText({ error: "audio-capture", message: "Failed to start audio capture." }),
    "Failed to start audio capture.",
  );
});

test("feindliche/kaputte Events crashen nicht", () => {
  for (const bad of [null, undefined, {}, { error: "" }, { message: "" }, { error: null, message: null }]) {
    assert.doesNotThrow(() => speechErrorText(bad as any));
  }
  // Nichts Brauchbares -> nicht als Fehler anzeigen
  assert.strictEqual(speechErrorText(null), null);
  assert.strictEqual(speechErrorText({}), null);
  // falsche Typen (Zahl/Objekt/Emoji) dürfen nicht werfen
  assert.doesNotThrow(() => speechErrorText({ error: 216 as any, message: { a: 1 } as any }));
  assert.doesNotThrow(() => speechErrorText({ message: "🎙️" }));
  // sehr langer Muell
  assert.strictEqual(speechErrorText({ message: "x".repeat(100000) })?.length, 100000);
});

test("Restart-Pause deckt das iOS-Teardown ab (>= 800 ms)", () => {
  assert.ok(SPEECH_RESTART_MS >= 800, String(SPEECH_RESTART_MS));
});

test("Session-Cap liegt unter dem iOS-Limit von ~60 s", () => {
  assert.ok(SPEECH_SESSION_CAP_MS > 10000, String(SPEECH_SESSION_CAP_MS));
  assert.ok(SPEECH_SESSION_CAP_MS < 60000, String(SPEECH_SESSION_CAP_MS));
});

test("Diktat-Sprache ist gesetzt", () => {
  assert.match(SPEECH_LANG, /^[a-z]{2}-[A-Z]{2}$/);
});

// ---- coalesceForSpeech: kurze Einheiten buendeln (Edge-Handshake-Kosten) ----

test("coalesceForSpeech: kurz + kurz verschmilzt", () => {
  const out = coalesceForSpeech(["Ja.", "Gern."]);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0], "Ja. Gern.");
});

test("coalesceForSpeech: langer Satz bleibt allein", () => {
  const long = "Das ist ein ausreichend langer Satz, der die Mindestlaenge deutlich ueberschreitet.";
  assert.ok(long.length >= SPEECH_MIN_UNIT, String(long.length));
  const out = coalesceForSpeech([long, "Ok."]);
  assert.strictEqual(out.length, 2, JSON.stringify(out));
  assert.strictEqual(out[0], long);
  assert.strictEqual(out[1], "Ok.");
});

test("coalesceForSpeech: SPEECH_MAX_UNIT wird nie ueberschritten", () => {
  // Viele kurze Einheiten: greedy verschmelzen, aber nie ueber den Deckel.
  const units = Array.from({ length: 20 }, (_, i) => `Satz ${i} kurz.`);
  const out = coalesceForSpeech(units);
  assert.ok(out.length > 0, "leer");
  for (const u of out) assert.ok(u.length <= SPEECH_MAX_UNIT, `zu lang: ${u.length} ${u}`);
  // nichts verloren: Woerter aller Einheiten stecken in den Ergebnis-Einheiten
  const joined = out.join(" ");
  for (let i = 0; i < units.length; i++) assert.ok(joined.includes(`Satz ${i} kurz.`), `fehlt ${i}`);
  // ein einzelnes ueberlanges next bleibt eigenstaendig und unveraendert
  const giant = "x".repeat(SPEECH_MAX_UNIT + 50);
  const out2 = coalesceForSpeech(["Kurz.", giant]);
  assert.deepStrictEqual(out2, ["Kurz.", giant]);
});

test("coalesceForSpeech: leere Einheiten fallen weg", () => {
  const out = coalesceForSpeech(["", "   ", "Hallo.", "", "Welt."]);
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0], "Hallo. Welt.");
  assert.deepStrictEqual(coalesceForSpeech([]), []);
  assert.deepStrictEqual(coalesceForSpeech(["", "  "]), []);
});
