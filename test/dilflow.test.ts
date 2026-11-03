// Golden-Path-Test: der komplette ChatGPT/Valdi-Loop headless durchgespielt.
//   1. Beispiel-Baum laden → Startwerte seeden
//   2. $-Bindings auflösen (Chart-Daten aus state)
//   3. Auswahl ändern (state-Zuweisung) → Bindings folgen
//   4. Chart-Klick → `event`
//   5. Follow-up-Button → Effekt "message" (das schickt die App als neuen Turn)
//   6. Streaming: offener ```dil-Fence bleibt ruhig (kein Fehler-Blitz)

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { evalCel, resolveDilRoot, splitDilBlocks } from "../dil.ts";
import { applyAction, createRuntime, runtimeScope, seedDefaults } from "../dilstate.ts";

const EXAMPLE_PATH = new URL("../examples/interactive-graph.dil.json", import.meta.url);
const example = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));

const evalx = (expr: string, scope: Record<string, unknown>) => evalCel(expr, scope);

function freshRuntime() {
  return { ...createRuntime(example.appData, example.constants), state: seedDefaults(example) };
}

/** Prop eines Widgets vom Typ `type` im aufgelösten Baum finden (Tiefensuche). */
function findWidget(nodes: ReturnType<typeof resolveDilRoot>, type: string): Record<string, unknown> | null {
  for (const n of nodes) {
    if (n.kind !== "widget") continue;
    if (n.type === type) return n as unknown as Record<string, unknown>;
    const hit = findWidget(n.children, type);
    if (hit) return hit;
  }
  return null;
}

function texts(nodes: ReturnType<typeof resolveDilRoot>): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.kind === "text") out.push(n.text);
    else {
      const props = (n.props ?? {}) as Record<string, unknown>;
      // statischer Text (`text`) oder dynamisch aufgelöst (`$text`)
      const txt = props.text ?? props.$text;
      if (typeof txt === "string") out.push(txt);
      out.push(...texts(n.children));
    }
  }
  return out;
}

test("1 — Beispiel-Baum ist valides DIL-JSON", () => {
  assert.equal(example.type, "Col");
  assert.ok(Array.isArray(example.children));
});

test("2 — seedDefaults setzt state.metric aus defaultValue", () => {
  const rt = freshRuntime();
  assert.equal(rt.state.metric, "sales");
});

test("3 — $-Binding liefert die Startserie der Chart-Daten", () => {
  const rt = freshRuntime();
  const nodes = resolveDilRoot(example, runtimeScope(rt));
  const chart = findWidget(nodes, "ValdiChart");
  assert.ok(chart, "ValdiChart muss im Baum sein");
  // `$data` = dynamische Property (Contract: das `$` sitzt am KEY, nicht am Wert).
  const data = (chart.props as Record<string, unknown>).$data;
  assert.ok(Array.isArray(data), "$data muss aufgelöst sein (kein CEL-String mehr)");
  assert.equal((data as Array<{ value: number }>).length, 5);
  assert.equal((data as Array<{ value: number }>)[0].value, 120);
});

test("4 — Auswahl (users) ändert die Chart-Daten ohne neuen Turn", () => {
  let rt = freshRuntime();
  const res = applyAction(rt, "state.metric = value", evalx, { value: "users" });
  assert.equal(res.error, undefined);
  rt = res.rt;
  const nodes = resolveDilRoot(example, runtimeScope(rt));
  const chart = findWidget(nodes, "ValdiChart");
  const data = (chart?.props as Record<string, unknown>).$data as Array<{ value: number }>;
  assert.equal(data[0].value, 800);
});

test("5 — Show/ShowElse: ohne Klick Hinweistext, mit Klick Detail-Card", () => {
  let rt = freshRuntime();
  let nodes = resolveDilRoot(example, runtimeScope(rt));
  assert.ok(texts(nodes).some((s) => s.includes("Tippe einen Balken an")), "Hinweis muss sichtbar sein");
  assert.ok(!texts(nodes).some((s) => s.includes("Ausgewählt:")), "Detail-Card darf noch fehlen");

  rt = applyAction(rt, "state.picked = event.label", evalx, { event: { label: "W3", value: 150, index: 2 } }).rt;
  nodes = resolveDilRoot(example, runtimeScope(rt));
  assert.ok(texts(nodes).some((s) => s.includes("Ausgewählt: W3")), "Detail-Card muss W3 zeigen");
  assert.ok(!texts(nodes).some((s) => s.includes("Tippe einen Balken an")), "Hinweis muss verschwinden");
});

test("6 — Follow-up-Button erzeugt exakt eine Modell-Nachricht", () => {
  let rt = freshRuntime();
  rt = applyAction(rt, "state.metric = value", evalx, { value: "churn" }).rt;
  const res = applyAction(
    rt,
    "invokeDILCallbackWithResult('askModel', 'Erkläre den Trend für ' + state.metric + ' und nenne 3 mögliche Ursachen.')",
    evalx,
  );
  assert.deepEqual(res.effects, [
    { kind: "message", name: "askModel", text: "Erkläre den Trend für churn und nenne 3 mögliche Ursachen." },
  ]);
});

test("7 — Streaming: offener Fence ist pending, kein parseError, geparster Teil rendert", () => {
  const full = "```dil\n" + JSON.stringify(example);
  const blocks = splitDilBlocks(full);
  assert.equal(blocks.length, 1);
  const b = blocks[0];
  assert.equal(b.kind, "dil");
  if (b.kind !== "dil") return;
  assert.equal(b.pending, true);
  assert.equal(b.parseError, undefined);
  assert.ok(b.json, "vollständiges aber ungeschlossenes JSON wird schon gerendert");
});

test("8 — Streaming: halbes JSON bleibt still (kein Fehler-Block)", () => {
  const half = '```dil\n{"type":"Col","children":[{"type":"Te';
  const b = splitDilBlocks(half)[0];
  assert.equal(b.kind, "dil");
  if (b.kind !== "dil") return;
  assert.equal(b.pending, true);
  assert.equal(b.json, null);
  assert.equal(b.parseError, undefined, "beim Streamen kein harter Fehler");
});

test("9 — geschlossener Fence ist nicht pending", () => {
  const b = splitDilBlocks('```dil\n{"type":"Text","props":{"text":"hi"}}\n```')[0];
  assert.equal(b.kind, "dil");
  if (b.kind !== "dil") return;
  assert.equal(b.pending, undefined);
  assert.deepEqual(b.json, { type: "Text", props: { text: "hi" } });
});

// ── Adversarial (panic_hunt): kaputte/feindliche Bäume dürfen nicht crashen ──

test("A1 — tief verschachtelter Baum: kein Stack-Overflow", () => {
  let node: Record<string, unknown> = { type: "Text", props: { text: "x" } };
  for (let i = 0; i < 300; i++) node = { type: "Col", children: [node] };
  const out = resolveDilRoot(node, {});
  assert.ok(Array.isArray(out));
});

test("A2 — zyklischer appData / Riesen-Options: kein Crash", () => {
  const cyclic: Record<string, unknown> = { series: [] };
  cyclic.self = cyclic;
  const rt = { ...createRuntime(cyclic, {}), state: {} };
  assert.ok(Array.isArray(resolveDilRoot({ type: "Text", props: { text: "ok" } }, runtimeScope(rt))));
  const big = { type: "SegmentedControl", props: { id: "m", options: Array.from({ length: 5000 }, (_, i) => ({ label: "o" + i })) } };
  assert.ok(Array.isArray(resolveDilRoot(big, runtimeScope(rt))));
});

test("A3 — gefährliche ids werden nicht in den State geseedet", () => {
  const tree = {
    type: "Col",
    children: [
      { type: "Input", props: { id: "__proto__", defaultValue: "x" } },
      { type: "Input", props: { id: "ok", defaultValue: "y" } },
    ],
  };
  const seeded = seedDefaults(tree);
  assert.deepEqual(Object.keys(seeded), ["ok"]);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

test("A4 — null/undefined/Array als Wurzel", () => {
  for (const bad of [null, undefined, 42, [], [1, 2], true]) {
    assert.ok(Array.isArray(resolveDilRoot(bad, {})));
  }
});

// ── Review-Fix: `===`/`!==` nur als Operator normalisieren, Literale unverfälscht ──

test("R1 — ===/!== funktionieren als Operator", () => {
  assert.equal(evalCel("1 === 1", {}), true);
  assert.equal(evalCel("1 !== 1", {}), false);
  assert.equal(evalCel("state.metric === 'sales'", { state: { metric: "sales" } }), true);
});

test("R2 — String-Literale mit === / !== bleiben unverfälscht", () => {
  assert.equal(evalCel("'a===b'", {}), "a===b");
  assert.equal(evalCel("'a !== b'", {}), "a !== b");
  const r = applyAction(createRuntime(), "askModel('Vergleich: a !== b')", evalx);
  assert.equal(r.effects[0].text, "Vergleich: a !== b");
});
