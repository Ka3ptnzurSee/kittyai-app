// nextFrom(): reine Regel, kein Netz — genau der Punkt, an dem am 23.11. eine
// Doppelnummer entstand, die Apple beim Upload still verworfen hat.
// Aufruf: node --experimental-strip-types --test test/next-build-number.test.ts
import { test } from "node:test";
import assert from "node:assert";
import { nextFrom } from "../scripts/next-build-number.mjs";

test("ASC liefert max 135 → 136", () => {
  assert.strictEqual(nextFrom({ ascMax: 135, committed: 130 }), 136);
});

test("committete Zahl ist höher als ASC (nie gebaut) → committete Zahl, nicht ASC+1", () => {
  assert.strictEqual(nextFrom({ ascMax: 135, committed: 138 }), 138);
});

test("ASC nicht erreichbar (ascMax 0/infinity) → committete Zahl", () => {
  assert.strictEqual(nextFrom({ ascMax: 0, committed: 42 }), 42);
  assert.strictEqual(nextFrom({ ascMax: NaN, committed: 42 }), 42);
});

test("nie 0/negativ, auch bei kaputten Eingaben", () => {
  assert.strictEqual(nextFrom({ ascMax: 0, committed: 0 }), 1);
  assert.strictEqual(nextFrom({ ascMax: -5, committed: NaN }), 1);
});

test("Ergebnis ist immer größer als der ASC-Maximalwert (keine Doppelnummer)", () => {
  for (const ascMax of [1, 5, 134, 135, 999]) {
    for (const committed of [1, 100, 135, 138]) {
      const n = nextFrom({ ascMax, committed });
      assert.ok(n > ascMax, `${n} muss > ${ascMax} sein (committed ${committed})`);
    }
  }
});
