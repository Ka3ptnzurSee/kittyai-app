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
  sliderWert,
  cellWert,
} from "../dil.ts";
import { absoluteImageUri } from "../lib.ts";

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

test("isSafeImageSrc blockt IPv6-/IP-Notations-Bypässe (Review Runde 2)", () => {
  // IPv4-mapped IPv6 → eingebettete IPv4 ist Loopback/private
  assert.strictEqual(isSafeImageSrc("https://[::ffff:127.0.0.1]/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://[::ffff:10.0.0.1]/a.png"), false);
  // IPv6-Literal: loopback/unspec/link-local/ULA
  assert.strictEqual(isSafeImageSrc("https://[::1]/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://[::]/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://[fe80::1]/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://[fc00::1]/a.png"), false);
  // Integer/Hex/Oktal-Notation normalisiert zu Loopback (WHATWG)
  assert.strictEqual(isSafeImageSrc("https://2130706433/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://0x7f000001/a.png"), false);
  // trailing dot + „this host" + CGNAT
  assert.strictEqual(isSafeImageSrc("https://localhost.:8080/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://0.0.0.0/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://100.64.0.1/a.png"), false);
  // IPv4-eingebettete IPv6 (IPv4-compatible/translated/NAT64) + DNS-Rebinding (Review Runde 3)
  assert.strictEqual(isSafeImageSrc("https://[::127.0.0.1]/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://[::10.0.0.1]/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://[::ffff:0:127.0.0.1]/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://[64:ff9b::127.0.0.1]/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://[64:ff9b::10.0.0.1]/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://lvh.me/a.png"), false);
  assert.strictEqual(isSafeImageSrc("https://localtest.me/a.png"), false);
  // globales IPv6 bleibt erlaubt (kein Embedding-Präfix, auch wenn low-32-Bits privat wären)
  assert.strictEqual(isSafeImageSrc("https://[2001:db8::1]/a.png"), true);
  assert.strictEqual(isSafeImageSrc("https://[2001:db8::7f00:1]/a.png"), true);
});

test("Each: itemName/indexName '__proto__' wird auf Default zurückgewiesen", () => {
  const nodes = resolveDilRoot(
    { type: "Each", items: ["a", "b"], itemName: "__proto__", children: [{ type: "Text", "$value": "item" }] },
    {}
  );
  // itemName fällt auf "item" zurück → $value="item" löst gegen die Items auf (kein Prototype-Set).
  const texts = nodes.filter((n) => n.kind === "widget" && (n as { type: string }).type === "Text").map((n) => (n as { props: Record<string, unknown> }).props.$value);
  assert.deepStrictEqual(texts, ["a", "b"]);
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

// ── Slider-Rechnung (Befund 23.11.2026: Slider war reine Anzeige) ──
test("sliderWert: klemmt, rundet auf Schritt, vertraegt Unsinn", () => {
  assert.strictEqual(sliderWert(0, 100, 1, 0.5), 50);
  assert.strictEqual(sliderWert(0, 100, 10, 0.44), 40);
  assert.strictEqual(sliderWert(0, 100, 10, 1.7), 100); // ueber das Ende gezogen
  assert.strictEqual(sliderWert(0, 100, 10, -3), 0); // vor den Anfang gezogen
  assert.strictEqual(sliderWert(0, 100, 1, NaN), 0); // kaputte Position
  assert.strictEqual(sliderWert(5, 5, 1, 0.5), 5); // min === max
  assert.strictEqual(sliderWert(0, 100, 0, 0.5), 50); // Schritt 0 -> 1
});

test("sliderWert: Raster liegt auf min + n*schritt (Linksanschlag erreichbar)", () => {
  assert.strictEqual(sliderWert(1, 5, 2, 0), 1); // vorher 2 - min war unerreichbar
  assert.strictEqual(sliderWert(1, 5, 2, 1), 5);
  assert.strictEqual(sliderWert(1, 5, 2, 0.5), 3);
});

test("sliderWert: Float-Schritte ohne 0.30000000000000004", () => {
  assert.strictEqual(sliderWert(0, 1, 0.1, 0.3), 0.3);
  assert.strictEqual(sliderWert(0, 1, 0.1, 0.75), 0.8);
  assert.strictEqual(sliderWert(0, 1, 0.25, 0.5), 0.5);
});

test("absoluteImageUri: relative /generated/-Pfade werden zur Server-URL", () => {
  assert.strictEqual(absoluteImageUri("/generated/a.jpg", "https://api.example.de"), "https://api.example.de/generated/a.jpg");
  assert.strictEqual(absoluteImageUri("/generated/a.jpg", "https://api.example.de/"), "https://api.example.de/generated/a.jpg");
  assert.strictEqual(absoluteImageUri("/etc/passwd", "https://api.example.de"), "https://api.example.de/etc/passwd");
  assert.strictEqual(absoluteImageUri("/generated/a b.jpg", "https://api.example.de"), null); // Leerzeichen = kein Bildpfad
});

// ── $ -Bindungen in verschachtelten Props (Slider soll Diagramme steuern) ──
test("resolveDil loest $-Werte in data-Arrays auf (state-getrieben)", () => {
  const nodes = resolveDil(
    {
      type: "Chart",
      props: {
        type: "bar",
        data: [
          { label: "10 Jahre", $value: "state.bier * 520" },
          { label: "20 Jahre", $value: "state.bier * 1040" },
        ],
      },
    },
    { state: { bier: 4 } },
  );
  const p = (nodes[0] as { props: { data: { value: number }[] } }).props;
  assert.strictEqual(p.data[0].value, 2080);
  assert.strictEqual(p.data[1].value, 4160);
});

test("resolveDil: defekter $ -Ausdruck in data bleibt roh (kein Crash)", () => {
  const nodes = resolveDil(
    { type: "Chart", props: { data: [{ label: "x", $value: "state.+" }] } },
    { state: {} },
  );
  const p = (nodes[0] as { props: { data: { value: string }[] } }).props;
  assert.strictEqual(p.data[0].value, "state.+");
});

// ── cellWert: $-aufgelöste Zellen ({"value": 5}) dürfen nicht leer bleiben ──
test("cellWert liest Knoten ohne props direkt", () => {
  assert.strictEqual(cellWert({ value: 5 }), "5");
  assert.strictEqual(cellWert({ label: "x", value: 10400 }), "10400");
  assert.strictEqual(cellWert("roh"), "roh");
});
