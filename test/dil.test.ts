import { test } from "node:test";
import assert from "node:assert";
import {
  parseDil,
  resolveDilRoot,
  resolveDil,
  evalCel,
  resolveValueAtPath,
  isKnownWidget,
  isDilV2,
  WIDGET_PROPS,
  CONTROL_FLOW_WIDGETS,
  splitDilBlocks,
  DilCelError,
  isSafeImageSrc,
} from "../dil.ts";

test("parseDil erkennt Text-Knoten", () => {
  assert.strictEqual(parseDil("hallo"), "hallo");
  assert.strictEqual(parseDil(42), "42");
  assert.strictEqual(parseDil(null), "");
});

test("parseDil erkennt v2 (code/compiledDil)", () => {
  const v2 = parseDil({ code: "function render(){ return 1 }", appData: { x: 1 } });
  assert.deepStrictEqual(v2, { kind: "v2", code: "function render(){ return 1 }", compiledDil: undefined, appData: { x: 1 }, constants: undefined, clientDefinedWidgets: undefined, requiredComponents: undefined });
});

test("parseDil liest props-Block und reservierte Keys", () => {
  const node = parseDil({ type: "Box", props: { gap: 8 }, children: ["a"], id: "n1", key: "k1" });
  assert.deepStrictEqual(node, { type: "Box", props: { gap: 8 }, children: ["a"], id: "n1", key: "k1" });
});

test("parseDil übernimmt flache Props neben props-Block", () => {
  const node = parseDil({ type: "Button", label: "OK", props: { variant: "primary" } }) as Record<string, unknown>;
  assert.strictEqual(node.label, "OK");
  assert.deepStrictEqual(node.props, { variant: "primary" });
});

test("resolveDil rendert Text und verschachtelte Widgets", () => {
  const tree = resolveDilRoot({ type: "Col", props: { gap: 8 }, children: ["Hallo", { type: "Text", value: "Welt" }] });
  assert.deepStrictEqual(tree, [
    { kind: "widget", type: "Col", props: { gap: 8 }, children: [
      { kind: "text", text: "Hallo" },
      { kind: "widget", type: "Text", props: { value: "Welt" }, children: [] },
    ] },
  ]);
});

test("resolveDil löst $prop via CEL gegen den Scope auf", () => {
  const tree = resolveDilRoot(
    { type: "Text", $value: "item.name" },
    { item: { name: "Per" } },
  );
  assert.deepStrictEqual(tree, [{ kind: "widget", type: "Text", props: { $value: "Per" }, children: [] }]);
});

test("resolveDil: Show rendert Kinder nur wenn when wahr", () => {
  const on = resolveDilRoot({ type: "Show", when: true, children: ["sichtbar"] });
  assert.deepStrictEqual(on, [{ kind: "text", text: "sichtbar" }]);
  const off = resolveDilRoot({ type: "Show", when: false, children: ["unsichtbar"] });
  assert.deepStrictEqual(off, []);
});

test("resolveDil: Show löst dynamisches $when via CEL auf", () => {
  const on = resolveDilRoot({ type: "Show", when: "$flag", children: ["sichtbar"] }, { flag: true });
  assert.deepStrictEqual(on, [{ kind: "text", text: "sichtbar" }]);
  const off = resolveDilRoot({ type: "Show", when: "$flag", children: ["unsichtbar"] }, { flag: false });
  assert.deepStrictEqual(off, []);
});

test("resolveDil: Show konsumiert ShowElse (if/else-Semantik)", () => {
  const on = resolveDilRoot({ type: "Show", when: true, children: ["A", { type: "ShowElse", children: ["B"] }] });
  assert.deepStrictEqual(on, [{ kind: "text", text: "A" }]);
  const off = resolveDilRoot({ type: "Show", when: false, children: ["A", { type: "ShowElse", children: ["B"] }] });
  assert.deepStrictEqual(off, [{ kind: "text", text: "B" }]);
});

test("resolveDil: tief verschachteltes Each crasht nicht (Knoten-Budget)", () => {
  const arr = Array.from({ length: 40 }, (_, i) => i);
  let tree: ReturnType<typeof resolveDilRoot> = [];
  assert.doesNotThrow(() => {
    tree = resolveDilRoot({
      type: "Each", of: arr, children: [
        { type: "Each", of: arr, children: [
          { type: "Each", of: arr, children: [{ type: "Text", value: "x" }] },
        ] },
      ],
    });
  });
  assert.ok(tree.length > 0);
  assert.ok(tree.length <= 10_000);
});

test("resolveDil: verschachteltes Each mit leeren children umgeht Budget nicht", () => {
  // Iterationen müssen gegen das Budget zählen — sonst exponentieller Hang bei no-op-Kindern.
  const arr = Array.from({ length: 500 }, (_, i) => i);
  let tree: ReturnType<typeof resolveDilRoot> = [];
  assert.doesNotThrow(() => {
    tree = resolveDilRoot({
      type: "Each", of: arr, children: [
        { type: "Each", of: arr, children: [] },
      ],
    });
  });
  assert.ok(tree.length <= 500); // äußeres Each wird vom Budget gestoppt
});

test("resolveDil: defekter CEL-Ausdruck killt nicht den ganzen Block", () => {
  const tree = resolveDilRoot({ type: "Col", children: [
    { type: "Text", $value: "foo ?? bar" },
    { type: "Text", value: "ok" },
  ] });
  assert.strictEqual(tree.length, 1);
  const col = tree[0] as { kind: "widget"; type: string; children: unknown[] };
  assert.strictEqual(col.type, "Col");
  assert.strictEqual(col.children.length, 2); // defekter Ausdruck wird als Literal gezeigt, "ok" bleibt
});

test("isSafeImageSrc erlaubt nur https und data:image/*", () => {
  assert.strictEqual(isSafeImageSrc("https://x.de/b.jpg"), true);
  assert.strictEqual(isSafeImageSrc("data:image/png;base64,AAAA"), true);
  assert.strictEqual(isSafeImageSrc("http://x.de/b.jpg"), false);
  assert.strictEqual(isSafeImageSrc("file:///etc/passwd"), false);
  assert.strictEqual(isSafeImageSrc("data:image/svg+xml;base64,AAAA"), false);
  assert.strictEqual(isSafeImageSrc("https://127.0.0.1/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://localhost/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://192.168.1.1/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://169.254.169.254/a.png"), false);
  // userinfo-Trick + DNS-Rebinding-artige Hosts (Regression aus Review Runde 1)
  assert.strictEqual(isSafeImageSrc("https://irgendwas@127.0.0.1/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://user:pass@10.0.0.1/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://localhost.evil.com/a.png"), true); // echter öffentlicher Host bleibt erlaubt
});

test("resolveDil: Each iteriert und setzt item/index", () => {
  const tree = resolveDilRoot(
    { type: "Each", of: "$products", itemName: "p", children: [{ type: "Text", $value: "$p.name" }] },
    { products: [{ name: "A" }, { name: "B" }] },
  );
  assert.deepStrictEqual(tree, [
    { kind: "widget", type: "Text", props: { $value: "A" }, children: [] },
    { kind: "widget", type: "Text", props: { $value: "B" }, children: [] },
  ]);
});

test("resolveDil: Scope erweitert den Scope für Kinder", () => {
  const tree = resolveDilRoot(
    { type: "Scope", values: { x: 5 }, children: [{ type: "Text", $value: "$x * 2" }] },
  );
  assert.deepStrictEqual(tree, [{ kind: "widget", type: "Text", props: { $value: 10 }, children: [] }]);
});

test("resolveDil: unbekanntes Widget wird trotzdem gerendert (kein Crash)", () => {
  const tree = resolveDilRoot({ type: "GibtEsNicht", foo: 1 });
  assert.deepStrictEqual(tree, [{ kind: "widget", type: "GibtEsNicht", props: { foo: 1 }, children: [] }]);
});

test("resolveDilRoot: v2 wird als ClientDefinedWidget-Platzhalter gerendert", () => {
  const tree = resolveDilRoot({ code: "render()" });
  assert.strictEqual(tree[0].kind, "widget");
  assert.strictEqual(tree[0].type, "ClientDefinedWidget");
});

test("evalCel: Pfade, Arithmetik, Klammern", () => {
  const scope = { a: 2, b: 3, item: { x: 10 } };
  assert.strictEqual(evalCel("a + b", scope), 5);
  assert.strictEqual(evalCel("a * (b + 1)", scope), 8);
  assert.strictEqual(evalCel("item.x / 2", scope), 5);
  assert.strictEqual(evalCel("a % 2", scope), 0);
});

test("evalCel: Vergleich, Logik, Ternary", () => {
  const scope = { x: 5, y: 10 };
  assert.strictEqual(evalCel("x < y", scope), true);
  assert.strictEqual(evalCel("x == 5 && y > 5", scope), true);
  assert.strictEqual(evalCel("x > y || x == 5", scope), true);
  assert.strictEqual(evalCel("x > 3 ? 'ja' : 'nein'", scope), "ja");
  assert.strictEqual(evalCel("!x", scope), false);
});

test("evalCel: String-Literale und Negation", () => {
  assert.strictEqual(evalCel("'hallo' + ' welt'"), "hallo welt");
  assert.strictEqual(evalCel("-3 + 5"), 2);
});

test("resolveValueAtPath löst verschachtelte Pfade und Arrays auf", () => {
  const scope = { user: { name: "Per", tags: ["a", "b"] }, items: [{ id: 1 }, { id: 2 }] };
  assert.strictEqual(resolveValueAtPath(scope, "user.name"), "Per");
  assert.strictEqual(resolveValueAtPath(scope, "user.tags[1]"), "b");
  assert.strictEqual(resolveValueAtPath(scope, "items[0].id"), 1);
  assert.strictEqual(resolveValueAtPath(scope, "fehlt.ganz.tief"), undefined);
});

test("splitDilBlocks trennt Markdown und DIL-Fences", () => {
  const blocks = splitDilBlocks('Vorher\n```dil\n{"type":"Text","value":"hi"}\n```\nNachher');
  assert.strictEqual(blocks.length, 3);
  assert.deepStrictEqual(blocks[0], { kind: "md", text: "Vorher\n" });
  assert.strictEqual(blocks[1].kind, "dil");
  assert.deepStrictEqual((blocks[1] as { json: unknown }).json, { type: "Text", value: "hi" });
  assert.deepStrictEqual(blocks[2], { kind: "md", text: "\nNachher" });
});

test("splitDilBlocks fängt kaputtes JSON ab (parseError)", () => {
  const blocks = splitDilBlocks('```dil\n{kaputt}\n```');
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].kind, "dil");
  assert.ok((blocks[0] as { parseError?: string }).parseError);
});

test("splitDilBlocks ohne DIL liefert nur einen Markdown-Block", () => {
  const blocks = splitDilBlocks("nur text");
  assert.deepStrictEqual(blocks, [{ kind: "md", text: "nur text" }]);
});

test("evalCel: zu lange/tiefe Ausdrücke werfen DilCelError statt Stack-Overflow", () => {
  assert.throws(() => evalCel("x".repeat(1001)), DilCelError);
  assert.throws(() => evalCel("(".repeat(200) + "1" + ")".repeat(200)), DilCelError);
});

test("parseDil/collectProps verwerfen Prototype-Pollution-Keys", () => {
  const n = resolveDilRoot({ type: "Text", __proto__: { polluted: true }, value: "ok" });
  assert.strictEqual(n.length, 1);
  assert.deepStrictEqual(n[0].props, { value: "ok" });
});

test("Widget-Katalog enthält die Kern-Widgets und Kontrollfluss", () => {
  assert.ok(isKnownWidget("Box"));
  assert.ok(isKnownWidget("Button"));
  assert.ok(isKnownWidget("Chart"));
  assert.ok(isKnownWidget("Show"));
  assert.ok(isKnownWidget("Each"));
  assert.ok(!isKnownWidget("AbsolutUnbekannt"));
  assert.ok(Array.isArray(WIDGET_PROPS.Chart) && WIDGET_PROPS.Chart.length > 5);
  assert.ok(CONTROL_FLOW_WIDGETS.has("Scope"));
  assert.ok(WIDGET_PROPS.Button.includes("variant"));
});

test("isDilV2 erkennt code/compiledDil, sonst false", () => {
  assert.strictEqual(isDilV2({ code: "return 1" }), true);
  assert.strictEqual(isDilV2({ compiledDil: "return 1" }), true);
  assert.strictEqual(isDilV2({ type: "Box" }), false);
  assert.strictEqual(isDilV2("text"), false);
});

test("resolveDilRoot rendert v2-appData deklarativ (kein eval)", () => {
  const nodes = resolveDilRoot({
    code: "function render(){ /* sandbox */ }",
    appData: { type: "Text", value: "aus appData" },
    constants: { n: 3 },
  });
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(nodes[0].kind, "widget");
  assert.strictEqual((nodes[0] as { type: string }).type, "Text");
});

test("resolveDilRoot v2 ohne appData liefert sicheren Fallback (kein Crash)", () => {
  const nodes = resolveDilRoot({ code: "return 1", constants: { x: 1 } });
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual((nodes[0] as { type: string }).type, "ClientDefinedWidget");
});
