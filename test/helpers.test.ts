import { test } from "node:test";
import assert from "node:assert";
import { classifyError, isRetryable, deriveTitle } from "../lib.ts";

test("classifyError: 401/403 → Zugriff verweigert", () => {
  assert.strictEqual(classifyError("HTTP 401 Unauthorized"), "Zugriff verweigert");
  assert.strictEqual(classifyError("403 Forbidden"), "Zugriff verweigert");
});

test("classifyError: 429/rate limit → Limit erreicht", () => {
  assert.strictEqual(classifyError("HTTP 429 Too Many Requests"), "Limit erreicht");
  assert.strictEqual(classifyError("rate limit reached"), "Limit erreicht");
});

test("classifyError: quota/billing → Konto/Guthaben", () => {
  assert.strictEqual(classifyError("out of credits"), "Konto/Guthaben");
});

test("classifyError: timeout → Zeitüberschreitung", () => {
  assert.strictEqual(classifyError("request timed out"), "Zeitüberschreitung");
});

test("classifyError: context length → Kontext zu lang", () => {
  assert.strictEqual(classifyError("maximum context length exceeded"), "Kontext zu lang");
});

test("classifyError: network → Netzwerk unterbrochen", () => {
  assert.strictEqual(classifyError("fetch failed: connection lost"), "Netzwerk unterbrochen");
});

test("classifyError: unbekannt → Fehler", () => {
  assert.strictEqual(classifyError("etwas völlig anderes"), "Fehler");
});

test("isRetryable: Netzwerk-/Timeout-Fehler sind retrybar", () => {
  assert.strictEqual(isRetryable("fetch failed"), true);
  assert.strictEqual(isRetryable("request timed out"), true);
});

test("isRetryable: Auth/Quota/Kontext sind NICHT retrybar", () => {
  assert.strictEqual(isRetryable("HTTP 401 Unauthorized"), false);
  assert.strictEqual(isRetryable("quota exceeded"), false);
  assert.strictEqual(isRetryable("maximum context length"), false);
});

test("deriveTitle: kurzer Titel bleibt unverändert", () => {
  assert.strictEqual(deriveTitle("Hallo Welt"), "Hallo Welt");
});

test("deriveTitle: langer Titel wird an Wortgrenze gekürzt + Ellipse", () => {
  const title = deriveTitle("Das ist ein sehr langer Titel der gekürzt werden muss");
  assert.ok(title.length <= 23, `Titel zu lang: ${title}`);
  assert.ok(title.endsWith("…"), `keine Ellipse: ${title}`);
});

test("deriveTitle: leer/Whitespace → leerer String", () => {
  assert.strictEqual(deriveTitle(""), "");
  assert.strictEqual(deriveTitle("   "), "");
});

test("deriveTitle: kollabiert Whitespace", () => {
  assert.strictEqual(deriveTitle("  Hallo   Welt  "), "Hallo Welt");
});

test("classifyError: overload/busy → Server ausgelastet", () => {
  assert.strictEqual(classifyError("server overloaded"), "Server ausgelastet");
  assert.strictEqual(classifyError("system busy"), "Server ausgelastet");
});

test("classifyError: Priorität — rate limit gewinnt vor quota", () => {
  assert.strictEqual(classifyError("429 out of credits"), "Limit erreicht");
});

test("deriveTitle: einzelnes überlanges Wort wird hart geschnitten", () => {
  const long = "A".repeat(50);
  const title = deriveTitle(long);
  assert.ok(title.length <= 23, `zu lang: ${title}`);
  assert.ok(title.endsWith("…"), `keine Ellipse: ${title}`);
});
