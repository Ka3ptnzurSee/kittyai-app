// Tests für die DIL-Runtime (Action-Interpreter + State-Store).
// Läuft ohne Expo: node --experimental-strip-types --test

import test from "node:test";
import assert from "node:assert/strict";

import { evalCel } from "../dil.ts";
import {
  applyAction,
  createRuntime,
  getAtPath,
  setAtPath,
  runtimeScope,
  collectActionProps,
  isActionProp,
} from "../dilstate.ts";

const evalx = (expr: string, scope: Record<string, unknown>) => evalCel(expr, scope);

function run(action: string, ctx = {}, rt = createRuntime({ series: { sales: [{ label: "W1", value: 120 }] } })) {
  return applyAction(rt, action, evalx, ctx);
}

test("leere / ungültige Action ist ein No-op", () => {
  const rt = createRuntime();
  for (const a of ["", "   ", undefined, null, 42]) {
    const r = applyAction(rt, a as string, evalx);
    assert.deepEqual(r.effects, []);
    assert.equal(r.rt, rt);
  }
});

test("state-Zuweisung aus value", () => {
  const r = run("state.metric = value", { value: "users" });
  assert.equal(r.error, undefined);
  assert.equal(r.rt.state.metric, "users");
});

test("verschachtelter Pfad + Immutabilität", () => {
  const rt = createRuntime();
  const r = run("state.ui.tab = 'a'", {}, rt);
  assert.equal(getAtPath(r.rt.state, "ui.tab"), "a");
  assert.deepEqual(rt.state, {}, "Original darf nicht mutiert werden");
});

test("event-Objekt als Quelle", () => {
  const r = run("state.hover = event.point", { event: { point: { label: "W2", value: 5 } } });
  assert.deepEqual(r.rt.state.hover, { label: "W2", value: 5 });
});

test("+= / -= auf Zahlen", () => {
  let rt = run("state.count = 5").rt;
  rt = run("state.count += 2", {}, rt).rt;
  assert.equal(rt.state.count, 7);
  rt = run("state.count -= 10", {}, rt).rt;
  assert.equal(rt.state.count, -3);
});

test("+= auf Nicht-Zahl → Fehler, kein Crash", () => {
  const rt = run("state.s = 'abc'").rt;
  const r = run("state.s += 1", {}, rt);
  assert.match(String(r.error), /braucht Zahlen/);
  assert.equal(r.rt.state.s, "abc");
});

test("mehrere Statements mit Semikolon", () => {
  const r = run("state.a = 1; state.b = state.a + 1");
  assert.equal(r.rt.state.a, 1);
  assert.equal(r.rt.state.b, 2);
});

test("invokeDILCallbackWithResult erzeugt Follow-up-Effekt", () => {
  const rt = run("state.metric = 'sales'").rt;
  const r = run("invokeDILCallbackWithResult('askModel', 'Erkläre ' + state.metric)", {}, rt);
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].name, "askModel");
  assert.equal(r.effects[0].text, "Erkläre sales");
});

test("Kurzformen sendMessage / askModel", () => {
  const a = run("sendMessage('hi')");
  assert.equal(a.effects[0].text, "hi");
  // Leerer Callback-Text wird bewusst abgelehnt (kein leerer Turn an das Modell).
  const b = run("askModel(state.metric)", { value: "churn" });
  assert.deepEqual(b.effects, []);
  assert.match(String(b.error), /leer/);
  const c = run("askModel(value)", { value: "churn" });
  assert.equal(c.effects[0].text, "churn");
});

test("AppData-Referenz im Callback", () => {
  const r = run("invokeDILCallbackWithResult('askModel', appData.series.sales[0].value)");
  assert.equal(r.effects[0].text, "120");
});

test("gefährliche Statements werden abgelehnt, nicht ausgeführt", () => {
  const rt = createRuntime();
  for (const bad of [
    "fetch('https://evil')",
    "require('fs')",
    "globalThis.x = 1",
    "state.x = (function(){ return 1 })()",
    "while(true){}",
    "state.__proto__.polluted = 1",
  ]) {
    const r = applyAction(rt, bad, evalx);
    assert.ok(r.error, `muss Fehler liefern: ${bad}`);
    assert.deepEqual(r.rt.state, {}, `darf State nicht ändern: ${bad}`);
    assert.deepEqual(r.effects, [], `darf keinen Effekt erzeugen: ${bad}`);
  }
});

test("Prototype-Pollution über Pfad ist neutralisiert", () => {
  const r = applyAction(createRuntime(), "state.__proto__.x = 1", evalx);
  // kein Throw, kein echtes Prototype-Write
  assert.equal(({} as Record<string, unknown>).x, undefined);
  assert.match(String(r.error), /Unsicherer/);
  assert.deepEqual(r.rt.state, {});
});

test("überlange Action → Fehler statt Arbeit", () => {
  const r = run("state.a = '" + "x".repeat(5000) + "'");
  assert.match(String(r.error), /zu lang/);
});

test("zu tiefer Pfad wird abgelehnt", () => {
  const r = run("state.a.b.c.d.e.f.g = 1");
  assert.match(String(r.error), /Pfad/);
  assert.deepEqual(r.rt.state, {});
});

test("kaputte Quotes / unvollständige Klammern", () => {
  for (const bad of ["state.a = 'unterminated", "invokeDILCallbackWithResult(", "state.=1", "state.a ="]) {
    const r = run(bad);
    assert.ok(r.error, `muss Fehler liefern: ${bad}`);
  }
});

test("Unicode/Emoji im Callback-Text", () => {
  const r = run("askModel('Warum 📈? Größe: 3')");
  assert.equal(r.effects[0].text, "Warum 📈? Größe: 3");
});

test("Runtime-Scope enthält state/appData/constants", () => {
  const rt = createRuntime({ a: 1 }, { c: 2 });
  const scope = runtimeScope({ ...rt, state: { s: 3 } }, { value: "v", index: 0 });
  assert.equal(evalCel("state.s", scope), 3);
  assert.equal(evalCel("appData.a", scope), 1);
  assert.equal(evalCel("constants.c", scope), 2);
  assert.equal(evalCel("value", scope), "v");
});

test("setAtPath / getAtPath Randfälle", () => {
  assert.deepEqual(setAtPath({}, "", 1), {});
  assert.equal(getAtPath({ a: [1, 2] }, "a.1"), 2);
  assert.equal(getAtPath({ a: 1 }, "a.b.c"), undefined);
  assert.equal(getAtPath(null, "a"), undefined);
});

test("Action-Prop-Erkennung", () => {
  assert.equal(isActionProp("onClickAction"), true);
  assert.equal(isActionProp("onClick"), false);
  const props = { onClickAction: "state.a = 1", onChangeAction: "  ", label: "x", onHoverAction: "state.h = event" };
  assert.deepEqual(collectActionProps(props).map(([k]) => k), ["onClickAction", "onHoverAction"]);
  assert.deepEqual(collectActionProps(undefined), []);
});
