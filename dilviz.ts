// Reine, RN-unabhängige Helfer für DIL-Visualisierungen (Charts, Diff, Math-Erkennung).
// Bewusst OHNE react-native/react-native-svg-Import, damit sie in
// `node --experimental-strip-types --test` direkt testbar sind.

// ───────────────────────────── Typen ─────────────────────────────

export interface ChartPoint {
  label: string;
  value: number;
}

export interface PieSlice {
  label: string;
  value: number;
  startDeg: number;
  endDeg: number;
  pct: number; // 0..100
}

export type DiffLineType = "added" | "removed" | "unchanged";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export type MathSegment =
  | { kind: "text"; value: string }
  | { kind: "math"; value: string; display: boolean }; // display: true = $$..$$, false = $..$

// ───────────────────────────── Mini-Helfer (kein Import aus Dil.tsx wegen RN) ─────────────────────────────

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (v == null) return fallback;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

// ───────────────────────────── Chart-Daten-Normalisierung ─────────────────────────────

/** Robust gegenüber data=Array<{label,value}> | Array<[label,value]> | Array<number>. */
export function normalizeChart(data: unknown): ChartPoint[] {
  if (!Array.isArray(data)) return [];
  const out: ChartPoint[] = [];
  const items = data.slice(0, 500); // Cap gegen DoS (Riesen-Datenarray)
  for (const d of items) {
    if (typeof d === "number") {
      out.push({ label: String(out.length + 1), value: d });
    } else if (Array.isArray(d)) {
      out.push({ label: str(d[0], "?"), value: num(d[1], 0) });
    } else if (d && typeof d === "object") {
      const o = d as Record<string, unknown>;
      const value = num(o.value ?? o.y, 0);
      const label = str(o.label ?? o.name ?? o.x ?? o.key, String(out.length + 1));
      out.push({ label, value });
    }
  }
  return out;
}

// ───────────────────────────── Pie-Slice-Winkel ─────────────────────────────

/**
 * Zerlegt normalisierte Daten in Kreissegmente (Winkel in Grad, 0° = 12-Uhr/oben, im Uhrzeigersinn —
 * entspricht `polar()` in Dil.tsx). `startAngle`/`endAngle` definieren den Sweep (Default 0..360),
 * `paddingAngle` (Grad) den Abstand zwischen Slices. Summe der Slice-Winkel + padding*Anzahl ≈ Sweep.
 * Werte <= 0 werden ignoriert (recharts-Konvention: Pie zeigt nur positive Anteile).
 */
export function computePieSlices(
  points: ChartPoint[],
  opts: { startAngle?: number; endAngle?: number; paddingAngle?: number } = {},
): PieSlice[] {
  const startAngle = typeof opts.startAngle === "number" ? opts.startAngle : 0;
  const endAngle = typeof opts.endAngle === "number" ? opts.endAngle : 360;
  const paddingAngle = Math.max(0, typeof opts.paddingAngle === "number" ? opts.paddingAngle : 0);
  const positive = points.filter((p) => Number.isFinite(p.value) && p.value > 0);
  if (!positive.length) return [];
  const total = positive.reduce((s, p) => s + p.value, 0);
  if (!Number.isFinite(total) || total <= 0) return [];
  const sweep = endAngle - startAngle;
  const paddingTotal = paddingAngle * positive.length;
  const usable = Math.max(0, sweep - paddingTotal);
  const out: PieSlice[] = [];
  let cursor = startAngle + paddingAngle / 2;
  for (const p of positive) {
    const frac = p.value / total;
    const sliceSweep = usable * frac;
    const start = cursor;
    const end = start + sliceSweep;
    out.push({ label: p.label, value: p.value, startDeg: start, endDeg: end, pct: frac * 100 });
    cursor = end + paddingAngle;
  }
  return out;
}

// ───────────────────────────── Diff-Zeilenklassifikation ─────────────────────────────

/** O(m·n)-Schutz: LCS-Tabelle nur für die ersten N Zeilen je Seite (LLM-Output ist unvertraut). */
const MAX_DIFF_LINES = 1000;

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function toLines(text: string): string[] {
  const s = (text ?? "").replace(/\r\n?/g, "\n");
  const lines = s.split("\n");
  // Eine einzelne, durch den finalen Newline entstandene leere Zeile ist kein echter Inhalt.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Zeilenweiser Vergleich (LCS) → einheitlicher Diff:
 * nur in `new` = "added", nur in `old` = "removed", in beiden = "unchanged".
 * Eingabe wird auf MAX_DIFF_LINES Zeilen gekappt, um O(m·n)-Speicher/Zeit gegen
 * unvertrautes LLM-Output zu begrenzen.
 */
export function classifyDiff(oldText: string, newText: string): DiffLine[] {
  let a = toLines(oldText);
  let b = toLines(newText);
  if (a.length > MAX_DIFF_LINES) a = a.slice(0, MAX_DIFF_LINES);
  if (b.length > MAX_DIFF_LINES) b = b.slice(0, MAX_DIFF_LINES);
  const dp = lcsTable(a, b);
  const out: DiffLine[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && dp[i - 1][j - 1] + 1 === dp[i][j]) {
      out.push({ type: "unchanged", text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.push({ type: "added", text: b[j - 1] });
      j--;
    } else if (i > 0) {
      out.push({ type: "removed", text: a[i - 1] });
      i--;
    }
  }
  return out.reverse();
}

// ───────────────────────────── Math-Erkennung ($..$ / $$..$$) ─────────────────────────────

/** Findet das schließende `$` ab Position `from`, überspringt dabei escapete `\$`. */
function findClosingDollar(s: string, from: number): number {
  for (let k = from; k < s.length; k++) {
    if (s[k] === "\\" && s[k + 1] === "$") {
      k++;
      continue;
    }
    if (s[k] === "$") return k;
  }
  return -1;
}

/**
 * Zerlegt Text in Text- und Math-Segmente. Erkennt `$$..$$` (Block, display=true) zuerst,
 * dann `$..$` (inline, display=false). `\$` wird als escapet Literal behandelt.
 * Inline-Math verlangt: kein Newline, nicht leer, und das Zeichen nach dem öffnenden `$`
 * darf keine Ziffer/Leerzeichen sein (vermeidet False-Positives wie "$5 und $10").
 */
export function splitMathSegments(text: string): MathSegment[] {
  const s = text ?? "";
  const out: MathSegment[] = [];
  const n = s.length;
  let i = 0;
  let textStart = 0;
  const flushText = (end: number) => {
    if (end > textStart) {
      // \$ → $ (escapet Dollar ist ein Literal, kein Math-Delimiter)
      out.push({ kind: "text", value: s.slice(textStart, end).replace(/\\\$/g, "$") });
    }
  };
  while (i < n) {
    if (s[i] === "\\" && s[i + 1] === "$") {
      i += 2; // escapet \$ → bleibt Text (wird unten mit ausgegeben)
      continue;
    }
    if (s[i] === "$" && s[i + 1] === "$") {
      const close = s.indexOf("$$", i + 2);
      if (close === -1) {
        i++;
        continue; // ungeschlossen → als Text belassen
      }
      flushText(i);
      out.push({ kind: "math", value: s.slice(i + 2, close), display: true });
      i = close + 2;
      textStart = i;
      continue;
    }
    if (s[i] === "$") {
      const next = s[i + 1];
      const okNext = next !== undefined && next !== "\n" && next !== " " && next !== "\t" && !(next >= "0" && next <= "9");
      if (okNext) {
        const close = findClosingDollar(s, i + 1);
        if (close !== -1 && close > i + 1 && s.slice(i + 1, close).indexOf("\n") === -1) {
          flushText(i);
          out.push({ kind: "math", value: s.slice(i + 1, close), display: false });
          i = close + 1;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  flushText(n);
  return out;
}

// ───────────────────────────── Math-Schutz vor Markdown-Parsing ─────────────────────────────
// markdown-it würde `*`/`_`/`` ` ``/`[`/`]` INNERHALB von $..$-Math als Emphasis/Code/Link
// interpretieren (z. B. `$x*y*z$` → `$x` + <em>y</em> + `z$`). Wir escapen diese Metazeichen
// im Math-Quelltext, damit sie als Literale erhalten bleiben. `$`-Delimiter bleiben unangetastet
// (renderInline erkennt sie dann wieder via splitMathSegments).

function escapeMetaChars(s: string): string {
  return s
    .replace(/\\/g, "\\\\") // Backslash zuerst: schützt LaTeX-Escapes (\$, \%, \frac, \\) vor markdown-it-Unescape
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

/** Escapet Markdown-Metazeichen innerhalb von $..$/$$..$$ — außerhalb bleibt der Text unverändert. */
export function escapeInlineMathMeta(text: string): string {
  const segs = splitMathSegments(text);
  if (!segs.some((s) => s.kind === "math")) return text;
  let out = "";
  for (const seg of segs) {
    if (seg.kind === "math") {
      out += seg.display ? `$$${seg.value}$$` : `$${escapeMetaChars(seg.value)}$`;
    } else {
      out += seg.value;
    }
  }
  return out;
}
