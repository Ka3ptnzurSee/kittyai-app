import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import markdown from "highlight.js/lib/languages/markdown";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import swift from "highlight.js/lib/languages/swift";
import kotlin from "highlight.js/lib/languages/kotlin";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import diff from "highlight.js/lib/languages/diff";
import plaintext from "highlight.js/lib/languages/plaintext";
// Claude-Grammatiksatz (highlight.js 11.11.2, alle 34 in bash.peg) — 18.11.2026 ergänzt:
import csharp from "highlight.js/lib/languages/csharp";
import dart from "highlight.js/lib/languages/dart";
import graphql from "highlight.js/lib/languages/graphql";
import handlebars from "highlight.js/lib/languages/handlebars";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import objectivec from "highlight.js/lib/languages/objectivec";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import scss from "highlight.js/lib/languages/scss";
import { aiFontFamily, colors, monoFontFamily } from "./theme";
import { MathView } from "./MathView";
import { splitMathSegments, escapeInlineMathMeta } from "./dilviz";
import { breakLongLines, breakUnbreakable, absoluteImageUri, getImageBaseUrl, isGeneratedFileHref, fileExtOf } from "./lib";
import { BildMitVollbild } from "./BildAnsicht";

// --- Syntax-Highlighting (highlight.js, nur Core + gängige Sprachen → schlankes Bundle) ---

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("java", java);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("dart", dart);
hljs.registerLanguage("graphql", graphql);
hljs.registerLanguage("handlebars", handlebars);
hljs.registerLanguage("less", less);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("makefile", makefile);
hljs.registerLanguage("objectivec", objectivec);
hljs.registerLanguage("perl", perl);
hljs.registerLanguage("php", php);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("r", r);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("scss", scss);

// Übliche LLM-Sprach-Labels auf registrierte Sprachen mappen.
hljs.registerAliases("js", { languageName: "javascript" });
hljs.registerAliases("ts", { languageName: "typescript" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["toml", "cfg", "conf"], { languageName: "ini" });
hljs.registerAliases(["c++", "cc"], { languageName: "cpp" });
hljs.registerAliases(["golang"], { languageName: "go" });
hljs.registerAliases(["rs"], { languageName: "rust" });
hljs.registerAliases(["kt"], { languageName: "kotlin" });
hljs.registerAliases(["txt", "text"], { languageName: "plaintext" });
hljs.registerAliases(["cs", "c#"], { languageName: "csharp" });
hljs.registerAliases(["objc", "obj-c", "objective-c"], { languageName: "objectivec" });
hljs.registerAliases(["ps1", "pwsh", "ps"], { languageName: "powershell" });
hljs.registerAliases(["hbs", "mustache"], { languageName: "handlebars" });
hljs.registerAliases(["rb"], { languageName: "ruby" });
hljs.registerAliases(["gql"], { languageName: "graphql" });
hljs.registerAliases(["mk", "make"], { languageName: "makefile" });
hljs.registerAliases(["pl"], { languageName: "perl" });

// GitHub-Light-Farbtöne für hljs-Klassen (dezent, passend zum warmen Claude-Theme).
const HLJS_COLORS: Record<string, string> = {
  "hljs-keyword": "#cf222e",
  "hljs-string": "#0a3069",
  "hljs-number": "#0550ae",
  "hljs-title": "#6f42c1",
  "hljs-built_in": "#0550ae",
  "hljs-type": "#953800",
  "hljs-comment": "#6e7781",
  "hljs-literal": "#0550ae",
  "hljs-attr": "#8250df",
  "hljs-attribute": "#0a3069",
  "hljs-variable": "#953800",
  "hljs-params": "#24292f",
  "hljs-function": "#8250df",
  "hljs-selector": "#0550ae",
  "hljs-regexp": "#0a3069",
  "hljs-meta": "#0550ae",
  "hljs-symbol": "#e36209",
  "hljs-bullet": "#0550ae",
  "hljs-section": "#0550ae",
  "hljs-name": "#953800",
  "hljs-tag": "#116329",
  "hljs-addition": "#1a7f37",
  "hljs-deletion": "#82071e",
  "hljs-doctag": "#0550ae",
  "hljs-template-variable": "#953800",
  "hljs-quote": "#6e7781",
  "hljs-link": "#0a3069",
  "hljs-selector-tag": "#0550ae",
  "hljs-selector-id": "#6f42c1",
  "hljs-selector-class": "#6f42c1",
  "hljs-class": "#6f42c1",
};

function hljsColorFor(className: string): string | undefined {
  const parts = className.split(/\s+/);
  for (const p of parts) {
    if (HLJS_COLORS[p]) return HLJS_COLORS[p];
  }
  return undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, "&");
}

// hljs liefert einen HTML-String aus <span class="hljs-…">…</span>.
// Wir zerlegen ihn in RN-Text-Spans mit Farben. Kein echtes HTML-Parsing nötig,
// aber die Ausgabe KANN verschachtelt sein (z. B. xml/html: <span class="hljs-tag">&lt;<span class="hljs-name">div</span>…</span>).
function htmlToSpans(html: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /<span class="([^"]*)">|<\/span>/g;
  let lastIndex = 0;
  const classStack: string[] = [];
  let currentText = "";
  let keyIdx = 0;
  const flush = () => {
    if (currentText) {
      const currentClass = classStack.length > 0 ? classStack[classStack.length - 1] : null;
      const color = currentClass ? hljsColorFor(currentClass) : undefined;
      nodes.push(
        <Text key={`${keyPrefix}-s${keyIdx++}`} style={color ? { color } : undefined}>
          {decodeEntities(currentText)}
        </Text>,
      );
      currentText = "";
    }
  };
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    currentText += html.slice(lastIndex, match.index);
    if (match[1] !== undefined) {
      flush();
      classStack.push(match[1]);
    } else {
      flush();
      classStack.pop();
    }
    lastIndex = re.lastIndex;
  }
  currentText += html.slice(lastIndex);
  flush();
  return nodes;
}

function highlightCode(code: string, lang: string): ReactNode[] {
  const clean = code.replace(/\n$/, "");
  const language = lang && hljs.getLanguage(lang) ? lang : null;
  if (language) {
    try {
      const result = hljs.highlight(clean, { language });
      if (result && result.value) return htmlToSpans(result.value, "hl");
    } catch {
      // Fallback auf Plaintext unten
    }
  }
  return [<Text key="hl-plain">{clean}</Text>];
}

// --- Markdown-Parser (einmal instanziiert) ---

const md = new MarkdownIt({
  html: false, // kein rohes HTML rendern (Sicherheit)
  linkify: true,
  breaks: true,
  typographer: false,
});

// --- Inline-Renderer (Text, strong, em, code, links, …) ---

function renderInline(tokens: Token[], keyPrefix: string): ReactNode {
  const children: ReactNode[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const key = `${keyPrefix}-i${i}`;
    if (t.type === "text") {
      const segs = splitMathSegments(t.content);
      segs.forEach((seg, si) => {
        if (seg.kind === "math") {
          // Inline-Math: Quelltext sauber als markierter Mono-Span (kein Rohtext mit $).
          children.push(
            <Text key={`${key}-m${si}`} style={styles.inlineMath}>
              {breakUnbreakable(seg.value)}
            </Text>,
          );
        } else if (seg.value) {
          children.push(breakUnbreakable(seg.value));
        }
      });
    } else if (t.type === "softbreak" || t.type === "hardbreak") {
      children.push("\n");
    } else if (t.type === "code_inline") {
      children.push(
        <Text key={key} style={styles.inlineCode}>
          {breakUnbreakable(t.content)}
        </Text>,
      );
    } else if (t.type === "strong_open" || t.type === "em_open" || t.type === "s_open") {
      const closeType = t.type === "strong_open" ? "strong_close" : t.type === "em_open" ? "em_close" : "s_close";
      const style = t.type === "strong_open" ? styles.strong : t.type === "em_open" ? styles.em : styles.strike;
      let j = i + 1;
      const inner: Token[] = [];
      while (j < tokens.length && tokens[j].type !== closeType) {
        inner.push(tokens[j]);
        j++;
      }
      children.push(
        <Text key={key} style={style}>
          {renderInline(inner, key)}
        </Text>,
      );
      i = j;
    } else if (t.type === "link_open") {
      const raw = t.attrGet("href") || "#";
      // Relative Server-Pfade (/generated/…) absolut machen, sonst nicht öffnbar.
      const resolved = /^\/generated\//i.test(raw) ? absoluteImageUri(raw, getImageBaseUrl()) || raw : raw;
      // Nur sichere Schemas verlinken – blockt javascript:/data:/file: (adversarial)
      const safe = /^(https?:|mailto:|tel:)/i.test(resolved);
      let j = i + 1;
      const inner: Token[] = [];
      while (j < tokens.length && tokens[j].type !== "link_close") {
        inner.push(tokens[j]);
        j++;
      }
      children.push(
        <Text
          key={key}
          style={safe ? styles.link : undefined}
          onPress={safe ? () => Linking.openURL(resolved).catch(() => {}) : undefined}
        >
          {renderInline(inner, key)}
        </Text>,
      );
      i = j;
    } else if (t.type === "image") {
      children.push(t.content || "🖼");
    }
    i++;
  }
  return <>{children}</>;
}

// --- Code-Block mit Sprach-Label + Copy-Button ---

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  // Überlange Zeilen (> 500) vor dem Rendern brechen: verhindert den iOS-Bug,
  // bei dem eine einzige kilometerlange Zeile im horizontalen ScrollView die
  // Zellenhöhe aufbläst („unendlicher weißer Balken“). Copy nutzt weiter den
  // unveränderten Original-String.
  const displayCode = useMemo(() => breakLongLines(code, 500), [code]);
  const highlighted = useMemo(() => highlightCode(displayCode, lang), [displayCode, lang]);
  const copy = () => {
    Clipboard.setStringAsync(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHeader}>
        <Text style={styles.codeLang}>{lang || "code"}</Text>
        <Pressable onPress={copy} hitSlop={8}>
          <Text style={styles.codeCopy}>{copied ? "✓ Kopiert" : "⧉ Kopieren"}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
        <Text style={styles.codeText}>{highlighted}</Text>
      </ScrollView>
    </View>
  );
}

// --- Bilder (Markdown `![alt](url)`) ---
//
// In React Native darf ein <Image> NICHT in einem <Text> stecken — deshalb wird ein
// Absatz, der nur aus Bildern besteht, auf Block-Ebene als echtes Bild gerendert.
// Erlaubt sind ausschließlich https-URLs und data:image/*-Base64 (kein file://, kein
// http://, keine Steuerzeichen). Alles andere bleibt der bisherige Platzhalter.
function MdImage({ uri, alt }: { uri: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState<number | null>(null);
  if (failed) {
    return (
      <Text selectable style={styles.imageFallback} onPress={() => Linking.openURL(uri).catch(() => {})}>
        🖼 {breakUnbreakable(alt || uri)}
      </Text>
    );
  }
  return (
    <BildMitVollbild
      uri={uri}
      alt={alt || "Bild"}
      resizeMode="contain"
      height={220}
      radius={10}
      style={{
        ...styles.mdImage,
        ...(ratio ? { height: undefined, aspectRatio: Math.min(3, Math.max(0.4, ratio)) } : null),
      }}
      onLoad={(e) => {
        const s = (e as { nativeEvent?: { source?: { width?: number; height?: number } } })?.nativeEvent?.source;
        if (s?.width && s?.height) setRatio(s.width / s.height);
      }}
      onError={() => setFailed(true)}
    />
  );
}

// --- Datei-Karten (`[Titel](/generated/bericht.docx)`) ---
//
// Erzeugte Dokumente (Word/PPT/Excel/PDF) lassen sich in der App oeffnen. Eine
// <View> darf nicht in einem <Text> stecken, deshalb wird ein Absatz, der nur aus
// einem solchen Link besteht, auf Block-Ebene als Karte gerendert (wie MdImage).
const isFileHref = isGeneratedFileHref;

// Absichtlich tolerant: Dateinamen mit "%" (z. B. "50%_Rabatt.pdf") sind
// gueltige URLs, aber kein gueltiges Prozent-Encoding — decodeURIComponent
// wuerde dann einen URIError werfen und die ganze Nachricht unrenderbar machen.
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function MdFile({ uri, label }: { uri: string; label: string }) {
  const ext = fileExtOf(uri);
  const icon = ext === "pdf" ? "📄" : ext === "xlsx" ? "📊" : ext === "pptx" ? "📽️" : ext === "docx" ? "📝" : "📎";
  const name = label.trim() || safeDecode(uri.split("/").pop() || "") || "Datei";
  return (
    <Pressable
      style={styles.fileCard}
      onPress={() => Linking.openURL(uri).catch(() => {})}
      accessibilityRole="button"
      accessibilityLabel={`Datei öffnen: ${name}`}
    >
      <Text style={styles.fileIcon}>{icon}</Text>
      <View style={styles.fileMeta}>
        <Text style={styles.fileName} numberOfLines={2}>
          {breakUnbreakable(name)}
        </Text>
        <Text style={styles.fileHint}>{(ext || "Datei").toUpperCase()} · zum Öffnen tippen</Text>
      </View>
      <Text style={styles.fileOpen}>Öffnen ›</Text>
    </Pressable>
  );
}

// --- Block-Renderer ---

function renderBlocks(tokens: Token[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const key = `${keyPrefix}-b${i}`;
    if (t.type === "inline") {
      const kids = t.children || [];
      // Absatz besteht NUR aus Bildern (+ Leerraum) → Block-Bild statt Platzhalter.
      const imgs = kids.filter((c) => c.type === "image");
      const rest = kids.filter((c) => c.type !== "image" && !(c.type === "text" && !String(c.content || "").trim()));
      if (imgs.length && rest.length === 0) {
        imgs.forEach((img, n) => {
          const uri = absoluteImageUri(img.attrGet("src") || "", getImageBaseUrl());
          const alt = img.content || "";
          if (uri) {
            out.push(<MdImage key={`${key}-img${n}`} uri={uri} alt={alt} />);
          } else {
            out.push(
              <Text key={`${key}-img${n}`} selectable style={styles.imageFallback}>
                🖼 {breakUnbreakable(alt || "Bild")}
              </Text>,
            );
          }
        });
        i++;
        continue;
      }
      // Absatz besteht NUR aus einem Link auf eine generierte Datei → Datei-Karte.
      const openIdx = kids.findIndex((c) => c.type === "link_open");
      const closeIdx = kids.findIndex((c) => c.type === "link_close");
      if (openIdx >= 0 && closeIdx > openIdx) {
        const outside = [...kids.slice(0, openIdx), ...kids.slice(closeIdx + 1)];
        const cleanOutside = outside.every((c) => c.type === "text" && !String(c.content || "").trim());
        const href = kids[openIdx].attrGet("href") || "";
        if (cleanOutside && isFileHref(href)) {
          const uri = absoluteImageUri(href, getImageBaseUrl());
          if (uri) {
            const label = kids.slice(openIdx + 1, closeIdx).map((c) => String(c.content || "")).join("");
            out.push(<MdFile key={`${key}-file`} uri={uri} label={label} />);
            i++;
            continue;
          }
        }
      }
      out.push(
        <Text key={key} selectable style={styles.paragraph}>
          {renderInline(t.children || [], key)}
        </Text>,
      );
    } else if (t.type === "heading_open") {
      const level = parseInt(t.tag.slice(1), 10) || 1;
      const headingStyle =
        level === 1 ? styles.h1 : level === 2 ? styles.h2 : level === 3 ? styles.h3 : styles.h4;
      const inlineTok = tokens[i + 1];
      out.push(
        <Text key={key} selectable style={headingStyle}>
          {inlineTok && inlineTok.type === "inline" ? renderInline(inlineTok.children || [], key) : null}
        </Text>,
      );
      i += 2; // inline + heading_close überspringen
    } else if (t.type === "fence" || t.type === "code_block") {
      const lang = t.type === "fence" ? (t.info || "").trim().split(/\s+/)[0] : "";
      out.push(<CodeBlock key={key} code={t.content || ""} lang={lang} />);
    } else if (t.type === "bullet_list_open" || t.type === "ordered_list_open") {
      const ordered = t.type === "ordered_list_open";
      const closeType = ordered ? "ordered_list_close" : "bullet_list_close";
      const items: ReactNode[] = [];
      let j = i + 1;
      let itemIdx = 0;
      while (j < tokens.length && tokens[j].type !== closeType) {
        if (tokens[j].type === "list_item_open") {
          let k = j + 1;
          const itemTokens: Token[] = [];
          while (k < tokens.length && tokens[k].type !== "list_item_close") {
            itemTokens.push(tokens[k]);
            k++;
          }
          const bullet = ordered ? `${itemIdx + 1}.` : "•";
          items.push(
            <View key={`${key}-li${itemIdx}`} style={styles.listItem}>
              <Text style={styles.listBullet}>{bullet}</Text>
              <View style={styles.listItemContent}>{renderBlocks(itemTokens, `${key}-li${itemIdx}`)}</View>
            </View>,
          );
          itemIdx++;
          j = k + 1;
        } else {
          j++;
        }
      }
      out.push(
        <View key={key} style={styles.list}>
          {items}
        </View>,
      );
      i = j;
    } else if (t.type === "blockquote_open") {
      let j = i + 1;
      const inner: Token[] = [];
      while (j < tokens.length && tokens[j].type !== "blockquote_close") {
        inner.push(tokens[j]);
        j++;
      }
      out.push(
        <View key={key} style={styles.blockquote}>
          {renderBlocks(inner, key)}
        </View>,
      );
      i = j;
    } else if (t.type === "hr") {
      out.push(<View key={key} style={styles.hr} />);
    } else if (t.type === "table_open") {
      let j = i + 1;
      const rows: Token[][][] = [];
      let currentRow: Token[][] = [];
      let totalRows = 0;
      // Obergrenze gegen den iOS-Bug „unendlicher weißer Balken“: eine riesige
      // Markdown-Tabelle (z. B. Daten-Dump mit 500 Zeilen) bläht die Bubble sonst
      // unbegrenzt auf. Mehr als MAX_TABLE_ROWS Zeilen werden ausgeblendet.
      const MAX_TABLE_ROWS = 50;
      while (j < tokens.length && tokens[j].type !== "table_close") {
        const tok = tokens[j];
        if (tok.type === "tr_open") {
          currentRow = [];
        } else if (tok.type === "th_open" || tok.type === "td_open") {
          const close = tok.type === "th_open" ? "th_close" : "td_close";
          let k = j + 1;
          const cellTokens: Token[] = [];
          while (k < tokens.length && tokens[k].type !== close) {
            cellTokens.push(tokens[k]);
            k++;
          }
          currentRow.push(cellTokens);
          j = k;
        } else if (tok.type === "tr_close") {
          totalRows++;
          if (rows.length < MAX_TABLE_ROWS) rows.push(currentRow);
        }
        j++;
      }
      out.push(
        <View key={key} style={styles.table}>
          {rows.map((row, ri) => (
            <View key={`${key}-r${ri}`} style={styles.tableRow}>
              {row.map((cell, ci) => {
                const inlineTok = cell.find((c) => c.type === "inline");
                return (
                  <View key={`${key}-r${ri}-c${ci}`} style={styles.tableCell}>
                    <Text style={styles.tableCellText} numberOfLines={3}>
                      {inlineTok ? renderInline(inlineTok.children || [], `${key}-r${ri}-c${ci}`) : null}
                    </Text>
                  </View>
                );
              })}
            </View>
          ))}
          {totalRows > rows.length ? (
            <Text style={styles.tableNote}>{totalRows - rows.length} weitere Zeilen ausgeblendet</Text>
          ) : null}
        </View>,
      );
      i = j;
    }
    i++;
  }
  return out;
}

// --- Öffentliche Komponente ---

/** Maskiert ```...```/~~~...~~~-Fences, damit `$$` in Code-Blöcken nicht als Math erkannt wird. */
function maskFencedBlocks(text: string): { masked: string; restore: (s: string) => string } {
  const fences: string[] = [];
  const masked = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => {
    fences.push(m);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });
  const restore = (s: string) => s.replace(/\u0000FENCE(\d+)\u0000/g, (_m, idx) => fences[Number(idx)] ?? "");
  return { masked, restore };
}

export function Markdown({ text }: { text: string }) {
  const rendered = useMemo(() => {
    if (!text) return null;
    try {
      // Fences (Code-Blöcke) maskieren, damit $/$$ dort unangetastet bleiben.
      const { masked, restore } = maskFencedBlocks(text);
      const segs = splitMathSegments(masked);
      const hasMath = segs.some((s) => s.kind === "math");
      if (!hasMath) {
        const tokens = md.parse(text, {});
        return renderBlocks(tokens, "md");
      }
      // Math vorhanden: $$..$$ als KaTeX-Block, $..$ inline (Meta-escaped, renderInline splittet erneut).
      const nodes: ReactNode[] = [];
      let mdText = "";
      const flush = () => {
        if (!mdText) return;
        nodes.push(...renderBlocks(md.parse(mdText, {}), "md"));
        mdText = "";
      };
      for (const seg of segs) {
        if (seg.kind === "math" && seg.display) {
          flush();
          nodes.push(<MathView key={`mb${nodes.length}`} value={seg.value} display />);
        } else if (seg.kind === "math") {
          mdText += escapeInlineMathMeta(`$${seg.value}$`);
        } else {
          mdText += restore(seg.value);
        }
      }
      flush();
      return nodes;
    } catch {
      // Fallback: roher Text
      return (
        <Text selectable style={styles.paragraph}>
          {breakUnbreakable(text)}
        </Text>
      );
    }
  }, [text]);
  return <View style={styles.root}>{rendered}</View>;
}

const styles = StyleSheet.create({
  root: { gap: 2 },
  paragraph: { color: colors.text, fontSize: 17, lineHeight: 26, fontFamily: aiFontFamily },
  mdImage: {
    alignSelf: "stretch",
    maxWidth: "100%",
    height: 220,
    maxHeight: 460,
    borderRadius: 12,
    backgroundColor: "transparent",
    marginVertical: 6,
  },
  imageFallback: { color: colors.muted, fontSize: 15, fontStyle: "italic", marginVertical: 4 },
  fileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginVertical: 6,
  },
  fileIcon: { fontSize: 22 },
  fileMeta: { flex: 1 },
  fileName: { color: colors.text, fontSize: 14, fontWeight: "600" },
  fileHint: { color: colors.muted, fontSize: 11, marginTop: 2 },
  fileOpen: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  h1: { color: colors.text, fontSize: 24, lineHeight: 30, fontWeight: "700", fontFamily: aiFontFamily, marginTop: 10, marginBottom: 2 },
  h2: { color: colors.text, fontSize: 21, lineHeight: 27, fontWeight: "700", fontFamily: aiFontFamily, marginTop: 8, marginBottom: 2 },
  h3: { color: colors.text, fontSize: 18, lineHeight: 24, fontWeight: "700", fontFamily: aiFontFamily, marginTop: 6, marginBottom: 1 },
  h4: { color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: "700", fontFamily: aiFontFamily, marginTop: 4, marginBottom: 1 },
  strong: { fontWeight: "700" },
  em: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  inlineCode: {
    fontFamily: monoFontFamily,
    backgroundColor: colors.surface2,
    color: colors.accentHover,
    paddingHorizontal: 4,
    borderRadius: 4,
    fontSize: 15,
  },
  inlineMath: {
    fontFamily: monoFontFamily,
    backgroundColor: colors.accentSoft,
    color: colors.accentHover,
    paddingHorizontal: 4,
    borderRadius: 4,
    fontSize: 15,
    fontStyle: "italic",
  },
  link: { color: colors.link, textDecorationLine: "underline" },
  list: { gap: 4, marginVertical: 4 },
  listItem: { flexDirection: "row", gap: 8 },
  listBullet: { color: colors.muted, fontFamily: aiFontFamily, fontSize: 17, lineHeight: 26 },
  listItemContent: { flex: 1, minWidth: 0 },
  blockquote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: 12, marginVertical: 4 },
  hr: { height: 1, backgroundColor: colors.border, marginVertical: 10 },
  codeBlock: {
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    marginVertical: 6,
    overflow: "hidden",
  },
  codeHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  codeLang: { fontSize: 12, color: colors.muted, fontFamily: monoFontFamily },
  codeCopy: { fontSize: 12, color: colors.accent, fontWeight: "600" },
  codeText: { fontFamily: monoFontFamily, fontSize: 13, lineHeight: 19, color: colors.text, padding: 10 },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, marginVertical: 6, overflow: "hidden", maxWidth: "100%" },
  tableRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border },
  tableCell: { flex: 1, padding: 6, minWidth: 0 },
  tableCellText: { fontSize: 14, lineHeight: 20, color: colors.text, fontFamily: aiFontFamily },
  tableNote: { fontSize: 12, color: colors.muted, fontFamily: aiFontFamily, padding: 6, fontStyle: "italic" },
});
