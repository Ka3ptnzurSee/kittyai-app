import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { colors, monoFontFamily } from "./theme";

// ───────────────────────────── Math-Rendering (KaTeX via WebView) ─────────────────────────────
// ChatGPTs math_jax.dec-Ansatz: LaTeX wird clientseitig mit KaTeX zu HTML gerendert.
// Wir rendern KaTeX in einer kleinen WebView (react-native-webview) mit einem statischen
// HTML-String. KaTeX kommt über jsDelivr-CDN (gepinnte Version); schlägt das Laden fehl,
// zeigt die WebView den rohen LaTeX-Quelltext (kein Fake-Rendering, kein eval).

const KATEX_JS = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js";
const KATEX_CSS = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css";

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
<link rel="stylesheet" href="${KATEX_CSS}">
<style>
  html, body { margin:0; padding:0; background:transparent; }
  body { display:flex; align-items:center; justify-content:${display ? "center" : "flex-start"}; }
  #math { font-family: ${monoFontFamily}, monospace; color:#0D0D0D; font-size:15px; padding:${display ? "12px 8px" : "0 2px"}; }
  .katex { font-size:1.05em; }
</style>
</head>
<body>
<div id="math">${escapeHtml(latex)}</div>
<script>
  function renderMath(){
    var el = document.getElementById('math');
    var latex = ${jsString(latex)};
    try {
      if (window.katex) { katex.render(latex, el, { displayMode: ${displayBool}, throwOnError: false, strict: false, trust: false }); }
    } catch (e) { el.textContent = latex; }
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ h: document.body.scrollHeight }));
    }
  }
</script>
<script src="${KATEX_JS}" onload="renderMath()" onerror="renderMath()"></script>
<script>window.addEventListener('load', function(){ setTimeout(renderMath, 50); });</script>
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
  if (!latex) return null;
  return (
    <View style={isBlock ? styles.block : styles.inline}>
      <WebView
        originWhitelist={["about:blank", "https://cdn.jsdelivr.net"]}
        source={{ html }}
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
