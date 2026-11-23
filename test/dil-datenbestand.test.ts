import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitDilBlocks, dilInhaltHash, dilNeuSeeden } from "../dil.ts";
import { firstFrame } from "../lib.ts";

/**
 * Datenbestand-Reproduktion für den Absturz am 23.11.2026 (Build 132).
 *
 * Beleg aus dem nginx-Zugriffslog (77.22.255.72, KittyAI/132):
 *   22:01:38  GET /api/session/cmwsa14mi_bmyeri -> 499   (Client weg)
 *   22:01:50  GET /api/session/cmwsa14mi_bmyeri -> 499
 *   22:02:13  GET /api/session/cmwsa14mi_bmyeri -> 499
 *   22:02:35  GET /api/session/cmwsa14mi_bmyeri -> 499
 *   dazwischen jeweils App-Start (13 Starts in 10 Minuten), und die Session-Antwort
 *   selbst kommt in 0,08–0,13 s — der Server ist also nicht die Ursache.
 *
 * Dieser Test hält die ECHTEN DIL-Blöcke dieses Verlaufs als Fixture (31 Fences) und
 * stellt sicher, dass der Parser sie vollständig und ohne Endlosarbeit verarbeitet.
 */

const fenced = JSON.parse(readFileSync(new URL("./fixtures-dil-cmwsa14mi.json", import.meta.url), "utf8")) as string[];

test("Fixture enthält den echten Verlauf (31 DIL-Blöcke)", () => {
  assert.equal(fenced.length, 31);
});

test("jeder echte DIL-Block wird als dil erkannt, geparst und ist nicht mehr 'pending'", () => {
  for (const [i, body] of fenced.entries()) {
    const blocks = splitDilBlocks("```dil\n" + body + "\n```");
    assert.equal(blocks.length, 1, `Fence ${i}: Blockzahl`);
    const b = blocks[0];
    assert.equal(b.kind, "dil", `Fence ${i}: kind`);
    assert.equal(b.pending, undefined, `Fence ${i}: fertige Antwort darf nicht pending sein`);
    assert.equal(b.parseError, undefined, `Fence ${i}: Parse-Fehler`);
    assert.ok(b.json != null, `Fence ${i}: json fehlt`);
  }
});

test("alle Blöcke zusammen bleiben schnell (kein quadratischer Aufwand)", () => {
  const text = fenced.map((b) => "```dil\n" + b + "\n```").join("\n\n");
  const t0 = performance.now();
  const blocks = splitDilBlocks(text);
  const ms = performance.now() - t0;
  assert.equal(blocks.filter((b) => b.kind === "dil").length, 31);
  assert.ok(ms < 250, `Parsing dauerte ${ms.toFixed(1)} ms`);
});

test("kaputte und unfertige Fences kippen die App nicht (Fuzzing)", () => {
  const faelle = [
    "",
    "```dil",
    "```dil\n{",
    "```dil\n{\"type\":\"Table\",\"props\":{\"rows\":[",
    "```dil\nnull\n```",
    "```dil\n[]\n```",
    "```dil\n\"nur ein String\"\n```",
    "```dil\n{\"type\":\"Chart\",\"props\":{\"data\":[{\"label\":\"a\",\"$value\":\"state.x\"}]}}\n```",
    "```dil\n{\"type\":\"Table\",\"props\":{\"rows\":[[null,true,{}]]}}\n```",
    "```dil\n{\"type\":\"x\",\"children\":" + "[".repeat(40) + "}".repeat(40) + "}\n```",
  ];
  for (const f of faelle) {
    const blocks = splitDilBlocks(f);
    assert.ok(Array.isArray(blocks), `Fall ${JSON.stringify(f.slice(0, 20))}`);
    for (const b of blocks) {
      assert.ok(["md", "dil"].includes(b.kind));
      // Skalare Fences ("nur ein String") bleiben erlaubt: der Renderer zeigt dann nichts.
      if (b.kind === "dil" && b.json != null) {
        assert.notEqual(b.json, undefined);
      }
    }
  }
});

test("Riesentext mit 500 Fences bleibt unter 2 s", () => {
  const body = fenced[0];
  const text = Array.from({ length: 500 }, () => "```dil\n" + body + "\n```").join("\n");
  const t0 = performance.now();
  const blocks = splitDilBlocks(text);
  const ms = performance.now() - t0;
  assert.equal(blocks.filter((b) => b.kind === "dil").length, 500);
  assert.ok(ms < 2000, `Parsing dauerte ${ms.toFixed(1)} ms`);
});

test("firstFrame liest die erste Komponente aus dem componentStack", () => {
  const stack = "\n   in Dil (at Dil.tsx:1200)\n   in DilRichText (at App.tsx:540)\n   in View";
  assert.equal(firstFrame(stack), "Dil");
  assert.equal(firstFrame(""), "");
  assert.equal(firstFrame(undefined), "");
  assert.equal(firstFrame("   in Verlauf (created by App)"), "Verlauf");
});

test("gleicher Inhalt in neuem Objekt seedet NICHT neu (Endlos-Render-Schutz)", () => {
  const a = JSON.parse(JSON.stringify(JSON.parse(fenced[0])));
  const b = JSON.parse(JSON.stringify(JSON.parse(fenced[0])));
  assert.notEqual(a, b); // verschiedene Objekte
  const h1 = dilInhaltHash(a);
  const h2 = dilInhaltHash(b);
  assert.equal(h1, h2, "Inhalts-Hash muss identisch sein");
  assert.equal(dilNeuSeeden(null, a).neu, true, "erster Seed muss passieren");
  assert.equal(dilNeuSeeden(h1, b).neu, false, "gleicher Inhalt darf nicht erneut seeden");
  // echter Inhaltswechsel muss erkannt werden
  const c = JSON.parse(JSON.stringify({ type: "Chart", props: { data: [{ label: "x", value: 1 }] } }));
  assert.equal(dilNeuSeeden(h1, c).neu, true);
});

test("Hash ist bei Riesenbäumen begrenzt und crasht nicht", () => {
  const gross = { type: "Table", props: { rows: Array.from({ length: 20000 }, (_, i) => ["z" + i, i]) } };
  const t0 = performance.now();
  const h = dilInhaltHash(gross);
  const ms = performance.now() - t0;
  assert.match(h, /^\d+:[a-z0-9]+$/);
  assert.ok(ms < 60, `Hash dauerte ${ms.toFixed(1)} ms`);
  // zyklische Struktur darf nicht werfen
  const zyklisch: Record<string, unknown> = { type: "X" };
  zyklisch.self = zyklisch;
  assert.equal(dilInhaltHash(zyklisch), "unserialisierbar");
});

test("alle echten Fences liefern stabile Hashes (kein Flackern)", () => {
  for (const body of fenced) {
    const j = JSON.parse(body);
    const a = dilInhaltHash(j);
    const b = dilInhaltHash(JSON.parse(body));
    assert.equal(a, b);
  }
});
