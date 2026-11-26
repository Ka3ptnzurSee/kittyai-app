// Render-Fenster für lange Verläufe (Chats mit 100+ Nachrichten sollen beim Öffnen
// nicht den ganzen Verlauf layouten). Geprüft werden Grenzen, Nachladen und Müll.
import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_WINDOW_INIT, CHAT_WINDOW_STEP, chatWindowHidden, chatWindowSlice } from "../lib.ts";

const reihe = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);

test("kurze Verläufe bleiben vollständig", () => {
  const m = reihe(10);
  assert.equal(chatWindowSlice(m, CHAT_WINDOW_INIT).length, 10);
  assert.equal(chatWindowHidden(m, CHAT_WINDOW_INIT), 0);
});

test("lange Verläufe zeigen nur das Ende, in Originalreihenfolge", () => {
  const m = reihe(200);
  const v = chatWindowSlice(m, CHAT_WINDOW_INIT);
  assert.equal(v.length, CHAT_WINDOW_INIT);
  assert.equal(v[v.length - 1], "m199"); // letzte Nachricht muss sichtbar sein
  assert.equal(v[0], "m140");
  assert.equal(chatWindowHidden(m, CHAT_WINDOW_INIT), 140);
});

test("Nachladen deckt den Verlauf schrittweise auf", () => {
  const m = reihe(200);
  let w = CHAT_WINDOW_INIT;
  const gesehen: number[] = [];
  while (chatWindowHidden(m, w) > 0) {
    w += CHAT_WINDOW_STEP;
    gesehen.push(chatWindowHidden(m, w));
  }
  assert.deepEqual(gesehen, [80, 20, 0]);
  assert.equal(chatWindowSlice(m, w).length, 200);
});

test("gleiche Grenze ist bei exakt voller Fenstergröße ein No-Op", () => {
  const m = reihe(60);
  assert.equal(chatWindowSlice(m, 60), m); // Identität, kein Kopieren
  assert.equal(chatWindowHidden(m, 60), 0);
});

test("feindliche Eingaben crashen nicht", () => {
  assert.deepEqual(chatWindowSlice([], 60), []);
  assert.deepEqual(chatWindowSlice(null as unknown as string[], 60), []);
  assert.deepEqual(chatWindowSlice(undefined as unknown as string[], 60), []);
  assert.equal(chatWindowSlice(reihe(5), NaN).length, 5);
  assert.equal(chatWindowSlice(reihe(5), 0).length, 5); // 0 = kein Fenster, alles zeigen
  assert.equal(chatWindowSlice(reihe(5), -3).length, 5);
  assert.equal(chatWindowSlice(reihe(5), Infinity).length, 5);
  assert.equal(chatWindowHidden("kaputt" as unknown as string[], 60), 0);
  assert.equal(chatWindowHidden(reihe(5), Number.NaN), 0);
});
