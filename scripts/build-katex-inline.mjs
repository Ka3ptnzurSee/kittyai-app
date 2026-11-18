#!/usr/bin/env node
/**
 * build-katex-inline.mjs — erzeugt assets/katex/katex-inline.ts aus einem KaTeX-dist-Verzeichnis.
 *
 * Warum: MathView.tsx lud KaTeX bisher von cdn.jsdelivr.net. Ohne Netz (oder mit
 * CDN-Sperre) blieb die Formel roher LaTeX-Text. Claude bettet seine Math-Font ein
 * (latinmodern-math.otf, 734 KB) — wir betten KaTeX-JS + CSS + woff2-Fonts als
 * base64 in ein TS-Modul ein: keine Netzabhängigkeit, kein originWhitelist-Loch.
 *
 * Nutzung:
 *   npm pack katex@0.16.9 --pack-destination /tmp && tar xzf /tmp/katex-0.16.9.tgz -C /tmp
 *   node scripts/build-katex-inline.mjs /tmp/package/dist
 *
 * Das Ergebnis (~700 KB) wird versioniert; dieses Skript nur bei KaTeX-Updates nötig.
 */
import fs from "node:fs";
import path from "node:path";

const distDir = process.argv[2] || "/tmp/package/dist";
const outFile = path.join(import.meta.dirname, "..", "assets", "katex", "katex-inline.ts");

const jsPath = path.join(distDir, "katex.min.js");
const cssPath = path.join(distDir, "katex.min.css");
const fontDir = path.join(distDir, "fonts");

for (const p of [jsPath, cssPath, fontDir]) {
  if (!fs.existsSync(p)) {
    console.error(`FEHLER: ${p} fehlt. Erst 'npm pack katex@0.16.9' entpacken (siehe Kopf dieser Datei).`);
    process.exit(2);
  }
}

const js = fs.readFileSync(jsPath, "utf8");
let css = fs.readFileSync(cssPath, "utf8");

// Alle von der CSS referenzierten woff2-Dateien als data-URI einsetzen.
const refs = [...new Set([...css.matchAll(/url\(["']?([^"')]+\.woff2)["']?\)/g)].map((m) => m[1]))];
let inlined = 0;
for (const ref of refs) {
  const file = path.join(fontDir, path.basename(ref));
  if (!fs.existsSync(file)) {
    console.error(`FEHLER: referenzierte Font fehlt: ${path.basename(ref)}`);
    process.exit(2);
  }
  const b64 = fs.readFileSync(file).toString("base64");
  css = css.split(ref).join(`data:font/woff2;base64,${b64}`);
  inlined++;
}

// Sicherheitsnetz 1: JS/CSS werden roh in <style>/<script> eingebettet (MathView.tsx).
// Ein "</script" oder "</style" im Quelltext würde aus dem Block ausbrechen und die
// Formel-WebView zu beliebigem HTML machen -> harter Abbruch statt stiller Fehler.
for (const [label, text, closer] of [["katex.min.js", js, "</script"], ["katex.min.css", css, "</style"]]) {
  if (text.toLowerCase().includes(closer)) {
    console.error(`FEHLER: ${label} enthält "${closer}" — kann nicht inline eingebettet werden.`);
    process.exit(2);
  }
}
if (js.includes("<!--")) {
  console.error('FEHLER: katex.min.js enthält "<!--" (HTML-Kommentar-Ausbruch).');
  process.exit(2);
}

// Sicherheitsnetz 2: keine externen URLs mehr in der CSS.
const leftover = css.match(/url\(["']?(https?:)?\/\//g);
if (leftover) {
  console.error(`FEHLER: CSS enthält weiterhin externe URLs (${leftover.length})`);
  process.exit(2);
}

const emit = (name, value) => `export const ${name} = ${JSON.stringify(value)};\n`;
const header = `// AUTO-GENERIERT von scripts/build-katex-inline.mjs — NICHT von Hand editieren.\n// Quelle: katex@0.16.9 (dist/katex.min.js + katex.min.css, ${inlined} woff2-Fonts als data-URI).\n// Zweck: Formeln rendern ohne CDN/Netz (MathView.tsx).\n\n`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, header + emit("KATEX_JS_INLINE", js) + emit("KATEX_CSS_INLINE", css));

const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log(`geschrieben: ${outFile}`);
console.log(`  JS  ${kb(js.length)}   CSS+Fonts ${kb(css.length)}   Fonts: ${inlined}`);
