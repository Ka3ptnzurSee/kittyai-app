import { test } from "node:test";
import assert from "node:assert";
import MarkdownIt from "markdown-it";
import {
  normalizeChart,
  computePieSlices,
  classifyDiff,
  splitMathSegments,
  escapeInlineMathMeta,
} from "../dilviz.ts";

// ── normalizeChart ──

test("normalizeChart: Array<{label,value}>", () => {
  const pts = normalizeChart([
    { label: "a", value: 1 },
    { label: "b", value: 2 },
    { label: "c", value: 3 },
  ]);
  assert.deepStrictEqual(pts, [
    { label: "a", value: 1 },
    { label: "b", value: 2 },
    { label: "c", value: 3 },
  ]);
});

test("normalizeChart: Array<[label,value]>", () => {
  const pts = normalizeChart([
    ["x", 10],
    ["y", 20],
  ]);
  assert.deepStrictEqual(pts, [
    { label: "x", value: 10 },
    { label: "y", value: 20 },
  ]);
});

test("normalizeChart: Array<number> bekommt numerische Labels", () => {
  const pts = normalizeChart([5, 10, 15]);
  assert.deepStrictEqual(pts, [
    { label: "1", value: 5 },
    { label: "2", value: 10 },
    { label: "3", value: 15 },
  ]);
});

test("normalizeChart: kein Array → leer, Cap bei 500", () => {
  assert.deepStrictEqual(normalizeChart(null), []);
  assert.deepStrictEqual(normalizeChart("nix"), []);
  const big = Array.from({ length: 1000 }, (_, i) => i);
  assert.strictEqual(normalizeChart(big).length, 500);
});

// ── computePieSlices ──

test("computePieSlices: Summe der Slice-Winkel ≈ 360° und pct ≈ 100%", () => {
  const slices = computePieSlices(normalizeChart([
    { label: "a", value: 1 },
    { label: "b", value: 2 },
    { label: "c", value: 1 },
  ]));
  const angleSum = slices.reduce((s, x) => s + (x.endDeg - x.startDeg), 0);
  assert.ok(Math.abs(angleSum - 360) < 1e-6, `angleSum=${angleSum}`);
  const pctSum = slices.reduce((s, x) => s + x.pct, 0);
  assert.ok(Math.abs(pctSum - 100) < 1e-6, `pctSum=${pctSum}`);
});

test("computePieSlices: Verhältnisse stimmen (1:2:1 → 90°/180°/90°)", () => {
  const slices = computePieSlices(normalizeChart([
    { label: "a", value: 1 },
    { label: "b", value: 2 },
    { label: "c", value: 1 },
  ]));
  const sweeps = slices.map((s) => s.endDeg - s.startDeg);
  assert.ok(Math.abs(sweeps[0] - 90) < 1e-6, `s0=${sweeps[0]}`);
  assert.ok(Math.abs(sweeps[1] - 180) < 1e-6, `s1=${sweeps[1]}`);
  assert.ok(Math.abs(sweeps[2] - 90) < 1e-6, `s2=${sweeps[2]}`);
});

test("computePieSlices: leere Daten / Summe 0 → leer", () => {
  assert.deepStrictEqual(computePieSlices([]), []);
  assert.deepStrictEqual(computePieSlices(normalizeChart([{ label: "a", value: 0 }])), []);
});

// ── classifyDiff ──

test("classifyDiff: hinzugefügte/entfernte/unveränderte Zeilen", () => {
  const lines = classifyDiff("a\nb\nc", "a\nx\nc");
  assert.deepStrictEqual(lines, [
    { type: "unchanged", text: "a" },
    { type: "removed", text: "b" },
    { type: "added", text: "x" },
    { type: "unchanged", text: "c" },
  ]);
});

test("classifyDiff: nur Hinzufügen am Ende", () => {
  const lines = classifyDiff("a", "a\nb");
  assert.deepStrictEqual(lines, [
    { type: "unchanged", text: "a" },
    { type: "added", text: "b" },
  ]);
});

test("classifyDiff: identische Texte → alles unchanged, CRLF normalisiert", () => {
  const lines = classifyDiff("a\r\nb", "a\nb");
  assert.deepStrictEqual(lines, [
    { type: "unchanged", text: "a" },
    { type: "unchanged", text: "b" },
  ]);
});

// ── splitMathSegments ──

test("splitMathSegments: Block-Math $$..$$", () => {
  const segs = splitMathSegments("Vorher $$x^2$$ nachher");
  assert.deepStrictEqual(segs, [
    { kind: "text", value: "Vorher " },
    { kind: "math", value: "x^2", display: true },
    { kind: "text", value: " nachher" },
  ]);
});

test("splitMathSegments: Inline-Math $..$", () => {
  const segs = splitMathSegments("Wert $x = 1$ ok");
  assert.deepStrictEqual(segs, [
    { kind: "text", value: "Wert " },
    { kind: "math", value: "x = 1", display: false },
    { kind: "text", value: " ok" },
  ]);
});

test("splitMathSegments: $ vor Ziffer wird NICHT als Math erkannt (Währung)", () => {
  const segs = splitMathSegments("Kostet $5 und $10 total");
  assert.deepStrictEqual(segs, [{ kind: "text", value: "Kostet $5 und $10 total" }]);
});

test("splitMathSegments: escapet \\$ bleibt Text", () => {
  const segs = splitMathSegments("Preis \\$5 und $x$");
  assert.deepStrictEqual(segs, [
    { kind: "text", value: "Preis $5 und " },
    { kind: "math", value: "x", display: false },
  ]);
});

test("splitMathSegments: reiner Text ohne Math bleibt ein Segment", () => {
  assert.deepStrictEqual(splitMathSegments("nur text"), [{ kind: "text", value: "nur text" }]);
});

test("splitMathSegments: escapet \\$ INNERHALB von Math bleibt LaTeX-\\$5", () => {
  // `$\$5$` → Math-Wert ist das gültige LaTeX `\$5` (Dollar-Literal), kein verfrühter Schluss.
  assert.deepStrictEqual(splitMathSegments("$\\$5$"), [
    { kind: "math", value: "\\$5", display: false },
  ]);
});

// ── escapeInlineMathMeta ──

test("escapeInlineMathMeta: * / _ / ` in Inline-Math wird escaped, außerhalb nicht", () => {
  assert.strictEqual(escapeInlineMathMeta("$x*y*z$"), "$x\\*y\\*z$");
  assert.strictEqual(escapeInlineMathMeta("$a_i$"), "$a\\_i$");
  assert.strictEqual(escapeInlineMathMeta("*kursiv* $x$ bleibt"), "*kursiv* $x$ bleibt");
});

test("escapeInlineMathMeta: Block-Math $$..$$ bleibt unescaped", () => {
  assert.strictEqual(escapeInlineMathMeta("$$x*y$$"), "$$x*y$$");
});

test("escapeInlineMathMeta: LaTeX-Escape \\$ überlebt markdown-it-Roundtrip", () => {
  const md = new MarkdownIt({ html: false });
  const escaped = escapeInlineMathMeta("$a\\$b$");
  // `\` → `\\` schützt `\$` vor markdown-its Unescape: Ergebnis ist EIN Text-Token.
  const tokens = md.parse(escaped, {});
  const inline = tokens.find((t) => t.type === "inline");
  assert.ok(inline && inline.children && inline.children.length === 1, JSON.stringify(inline?.children));
  assert.strictEqual(inline.children[0].content, "$a\\$b$");
});

test("escapeInlineMathMeta: \\frac überlebt markdown-it-Roundtrip", () => {
  const md = new MarkdownIt({ html: false });
  const escaped = escapeInlineMathMeta("$\\frac{1}{2}$");
  const tokens = md.parse(escaped, {});
  const inline = tokens.find((t) => t.type === "inline");
  assert.ok(inline && inline.children && inline.children.length === 1, JSON.stringify(inline?.children));
  assert.strictEqual(inline.children[0].content, "$\\frac{1}{2}$");
});

// ── computePieSlices: negative Werte ──

test("computePieSlices: negative Werte werden ignoriert (recharts-Konvention)", () => {
  const slices = computePieSlices(normalizeChart([
    { label: "a", value: -5 },
    { label: "b", value: 10 },
    { label: "c", value: 0 },
  ]));
  assert.strictEqual(slices.length, 1);
  assert.strictEqual(slices[0].label, "b");
  assert.ok(Math.abs((slices[0].endDeg - slices[0].startDeg) - 360) < 1e-6);
  assert.ok(Math.abs(slices[0].pct - 100) < 1e-6);
});

// ── classifyDiff: O(m·n)-Cap ──

test("classifyDiff: große Eingaben (5000 Zeilen) crashen nicht und sind begrenzt", () => {
  const big = Array.from({ length: 5000 }, (_, i) => `zeile ${i}`).join("\n");
  const lines = classifyDiff(big, big + "\nextra");
  assert.ok(lines.length <= 2000);
  assert.ok(lines.length > 0);
});
