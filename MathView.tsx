import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { colors, monoFontFamily } from "./theme";
import { KATEX_CSS_INLINE, KATEX_JS_INLINE } from "./assets/katex/katex-inline";

// ───────────────────────────── Math-Rendering (KaTeX via WebView, OFFLINE) ─────────────────────────────
// ChatGPTs math_jax.dec-Ansatz: LaTeX wird clientseitig mit KaTeX zu HTML gerendert.
// Wir rendern KaTeX in einer kleinen WebView (react-native-webview).
//
// WICHTIG (18.11.2026): KaTeX kommt NICHT mehr von jsDelivr. JS + CSS + 20 woff2-Fonts
// sind als base64 in assets/katex/katex-inline.ts eingebettet (erzeugt von
// scripts/build-katex-inline.mjs). Damit rendert eine Formel auch im Flugmodus und
// ohne CDN — vorher blieb der rohe LaTeX-Text stehen.
// Das HTML enthält deshalb keine externen URLs; originWhitelist ist auf about:blank begrenzt.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** LaTeX sicher als JS-String-Literal einbetten (kein eval, keine </script>-Injection). */
function jsString(s: string): string {
  return JSON.stringify(s).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function buildHtml(latex: string, display: boolean): string {
  const displayBool = display ? "true" : "false";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>${KATEX_CSS_INLINE}</style>
<style>
  html, body { margin:0; padding:0; background:transparent; }
  body { display:flex; align-items:center; justify-content:${display ? "center" : "flex-start"}; }
  #math { font-family: ${monoFontFamily}, monospace; color:#0D0D0D; font-size:15px; padding:${display ? "12px 8px" : "0 2px"}; }
  .katex { font-size:1.05em; }
</style>
</head>
<body>
<div id="math">${escapeHtml(latex)}</div>
<script>${KATEX_JS_INLINE}</script>
<script>
  (function(){
    var el = document.getElementById('math');
    var latex = ${jsString(latex)};
    try {
      if (window.katex) { katex.render(latex, el, { displayMode: ${displayBool}, throwOnError: false, strict: false, trust: false }); }
    } catch (e) { el.textContent = latex; }
    function report(){
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ h: document.body.scrollHeight }));
      }
    }
    report();
    // Fonts sind data-URIs: nach dem Decode kann sich die Hoehe noch aendern.
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) { document.fonts.ready.then(report).catch(function(){}); }
    setTimeout(report, 120);
  })();
</script>
</body>
</html>`;
}

/** Entfernt umgebende $/$-Delimiter und entscheidet Block vs. Inline. */
function normalizeMathInput(value: string, displayHint: boolean): { latex: string; display: boolean } {
  let v = (value ?? "").trim();
  let display = displayHint;
  if (v.startsWith("$$") && v.endsWith("$$") && v.length >= 4) {
    v = v.slice(2, -2).trim();
    display = true;
  } else if (v.startsWith("$") && v.endsWith("$") && v.length >= 2) {
    v = v.slice(1, -1).trim();
    display = false;
  } else if (v.startsWith("\\(") && v.endsWith("\\)")) {
    v = v.slice(2, -2).trim();
    display = false;
  } else if (v.startsWith("\\[") && v.endsWith("\\]")) {
    v = v.slice(2, -2).trim();
    display = true;
  } else if (/\\begin\{/.test(v)) {
    display = true; // \begin{...}\end{...} ist immer Display-Math
  }
  return { latex: v, display };
}

/**
 * Echtes LaTeX-Rendering. `display` = Block-Formel (zentriert), sonst Inline.
 * Fallback: schlägt die WebView fehl, bleibt der rohe LaTeX-Quelltext im #math-Div sichtbar.
 */
export function MathView({ value, display = false }: { value: string; display?: boolean }) {
  const { latex, display: isBlock } = useMemo(() => normalizeMathInput(value, display), [value, display]);
  const [height, setHeight] = useState(isBlock ? 56 : 28);
  const html = useMemo(() => buildHtml(latex, isBlock), [latex, isBlock]);
  // Stabile `source`-Identität: ein bei jedem Render neu gebautes {html}-Objekt lässt
  // react-native-webview die (650 kB grosse, base64-eingebettete) KaTeX-Seite neu laden.
  const source = useMemo(() => ({ html }), [html]);
  if (!latex) return null;
  return (
    <View style={isBlock ? styles.block : styles.inline}>
      <WebView
        originWhitelist={["about:blank"]}
        source={source}
        scrollEnabled={false}
        javaScriptEnabled
        domStorageEnabled={false}
        style={{ height, backgroundColor: "transparent", width: "100%" }}
        onMessage={(e) => {
          try {
            const d = JSON.parse(e.nativeEvent.data);
            if (d && typeof d.h === "number" && Number.isFinite(d.h) && d.h > 0) {
              setHeight(Math.min(1200, Math.ceil(d.h)));
            }
          } catch {
            /* Ignorieren */
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  block: { alignSelf: "stretch", marginVertical: 4 },
  inline: { alignSelf: "center", marginHorizontal: 2, maxWidth: "100%" },
});
