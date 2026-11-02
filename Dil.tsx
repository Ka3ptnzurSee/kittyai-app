import { useMemo, useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  Animated,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ResolvedNode } from "./dil";
import { splitDilBlocks, resolveDilRoot, isSafeImageSrc } from "./dil";
import { Markdown } from "./Markdown";
import { MathView } from "./MathView";
import Svg, { Path, Polyline, Circle, Line as SvgLine, Text as SvgText } from "react-native-svg";
import { normalizeChart, computePieSlices, classifyDiff } from "./dilviz";
import type { ChartPoint } from "./dilviz";
import { aiFontFamily, colors, monoFontFamily, oaicolors } from "./theme";
import { breakUnbreakable } from "./lib";

// Obergrenze für Medien in Widgets: ein Modell kann height: 100000 liefern — ohne Cap
// wächst die Zelle zur „unendlich langen weißen Nachricht".
const MAX_MEDIA_H = 460;

// Text aus (Modell-gelieferten) DIL-Props: Steuerzeichen raus, unbrechbare Riesen-Läufe
// umbrechen. Ohne das sprengt ein einziger 5000-Zeichen-String das iOS-Layout.
function t(v: unknown, fallback = ""): string {
  return breakUnbreakable(str(v, fallback));
}

// ───────────────────────────── RN-Renderer für DIL (GenUI) ─────────────────────────────
// Wandelt den von `resolveDilRoot` erzeugten Baum in native Widgets um.
// MVP-Widgets (siehe docs/kittyai-perfektion.md Phase A): Layout, Text, Formular,
// Badge/Card/List/Table/Image + Balken-Chart. v2 (`code`) wird NICHT ausgeführt.

type Props = Record<string, unknown>;

// Properties können statisch (`gap`) oder bereits aufgelöst als `$gap` vorliegen
// (resolveDil setzt den Key mit `$`-Präfix). Wir lesen beides.
function getProp(props: Props, name: string, fallback?: unknown): unknown {
  if (Object.prototype.hasOwnProperty.call(props, name)) return props[name];
  if (Object.prototype.hasOwnProperty.call(props, "$" + name)) return props["$" + name];
  return fallback;
}

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

function bool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return fallback;
}

function color(v: unknown, fallback: string): string {
  const s = str(v, "");
  if (!s) return fallback;
  if (s.startsWith("#") || s.startsWith("rgb") || s.startsWith("hsl")) return s;
  // semantische Tokens auf die Palette mappen (Claude-Theme)
  const map: Record<string, string> = {
    "color-surface": colors.surface,
    "color-surface-2": colors.surface2,
    "color-gray-050": colors.bg,
    "color-gray-100": colors.surface2,
    "color-gray-200": colors.border,
    "color-gray-500": colors.muted,
    "color-gray-950": colors.text,
    "color-clay": colors.accent,
    "color-error": colors.danger,
    "color-mineral": colors.success,
    "color-switch-on": colors.link,
    "alpha-05": "rgba(0,0,0,0.05)",
    "alpha-10": "rgba(0,0,0,0.1)",
  };
  return map[s] ?? fallback;
}

// Layout-Props, die Box/Col/Row/Card gemeinsam haben.
function boxStyle(props: Props): Record<string, unknown> {
  const pad = num(getProp(props, "padding"), 0);
  const radius = num(getProp(props, "radius"), 0);
  const border = num(getProp(props, "border"), 0);
  const align = str(getProp(props, "align"), "");
  const justify = str(getProp(props, "justify"), "");
  const bg = str(getProp(props, "background"), "");
  const w = Math.max(0, num(getProp(props, "width"), 0));
  const h = Math.max(0, num(getProp(props, "height"), 0));
  const flex = num(getProp(props, "flex"), 0);
  const maxW = Math.max(0, num(getProp(props, "maxWidth"), 0));
  const s: Record<string, unknown> = {};
  if (pad) s.padding = pad;
  if (radius) s.borderRadius = radius;
  if (border) { s.borderWidth = border; s.borderColor = colors.border; }
  if (bg) s.backgroundColor = color(bg, colors.surface2);
  if (w) s.width = w;
  if (h) s.height = h;
  if (flex) s.flex = flex;
  if (maxW) s.maxWidth = maxW;
  if (align === "center") s.alignItems = "center";
  else if (align === "end" || align === "right") s.alignItems = "flex-end";
  else if (align === "start" || align === "left") s.alignItems = "flex-start";
  if (justify === "center") s.justifyContent = "center";
  else if (justify === "between") s.justifyContent = "space-between";
  else if (justify === "end") s.justifyContent = "flex-end";
  else if (justify === "around") s.justifyContent = "space-around";
  return s;
}

function textStyle(props: Props): Record<string, unknown> {
  const align = str(getProp(props, "textAlign"), "");
  const s: Record<string, unknown> = {};
  if (align === "center" || align === "right" || align === "left") s.textAlign = align;
  return s;
}

// ── Formular-Widgets als EIGENE Komponenten (Rules of Hooks: useState darf nicht
//    bedingt im switch der Widget-Komponente aufgerufen werden). ──
function InputWidget({ props, multiline }: { props: Props; multiline: boolean }) {
  const [val, setVal] = useState(str(getProp(props, "value"), str(getProp(props, "defaultValue"), "")));
  const multi = multiline || bool(getProp(props, "multiline"), false);
  const valueProp = getProp(props, "value");
  useEffect(() => {
    // Externe value-Änderungen übernehmen (sonst stale UI bei Prop-Update).
    if (typeof valueProp === "string") setVal(valueProp);
  }, [valueProp]);
  return (
    <TextInput
      value={val}
      onChangeText={setVal}
      placeholder={str(getProp(props, "placeholder"), "")}
      placeholderTextColor={colors.muted}
      multiline={multi}
      editable={!bool(getProp(props, "disabled"), false)}
      style={[styles.input, multi && { minHeight: 80, textAlignVertical: "top" }]}
    />
  );
}

function CheckboxWidget({ props }: { props: Props }) {
  const [checked, setChecked] = useState(bool(getProp(props, "checked"), bool(getProp(props, "defaultChecked"), false)));
  const checkedProp = getProp(props, "checked");
  useEffect(() => {
    if (typeof checkedProp === "boolean") setChecked(checkedProp);
  }, [checkedProp]);
  return (
    <Pressable style={styles.checkboxRow} onPress={() => setChecked((c) => !c)}>
      <View style={[styles.checkbox, checked && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
        {checked ? <Text style={{ color: "#fff", fontSize: 12, lineHeight: 16 }}>✓</Text> : null}
      </View>
      <Text style={styles.checkboxLabel}>{t(getProp(props, "label"))}</Text>
    </Pressable>
  );
}

function RadioGroupWidget({ props }: { props: Props }) {
  const options = Array.isArray(getProp(props, "options")) ? (getProp(props, "options") as unknown[]).slice(0, 200) : [];
  const [value, setValue] = useState(str(getProp(props, "value"), str(getProp(props, "defaultValue"), "")));
  const valueProp = getProp(props, "value");
  useEffect(() => {
    if (typeof valueProp === "string") setValue(valueProp);
  }, [valueProp]);
  const direction = str(getProp(props, "direction"), "column");
  return (
    <View style={{ gap: 8, flexDirection: direction === "row" ? "row" : "column", flexWrap: "wrap" }}>
      {options.map((o, i) => {
        const label = typeof o === "string" ? o : str((o as Record<string, unknown>)?.label, String(o));
        const val = typeof o === "string" ? o : str((o as Record<string, unknown>)?.value, label);
        const active = value === val;
        return (
          <Pressable key={i} style={styles.checkboxRow} onPress={() => setValue(val)}>
            <View style={[styles.radio, active && { borderColor: colors.accent }]}>
              {active ? <View style={styles.radioDot} /> : null}
            </View>
            <Text style={styles.checkboxLabel}>{breakUnbreakable(label)}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function PulseIndicatorWidget({ props }: { props: Props }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.6, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const size = Math.max(0, num(getProp(props, "size"), 8));
  const c = color(str(getProp(props, "color"), ""), colors.accent);
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: c,
        transform: [{ scale: pulse }],
        opacity: 0.7,
        alignSelf: "flex-start",
      }}
    />
  );
}

function LoadingWidget({ props }: { props: Props }) {
  const op = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(op, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [op]);
  const w = Math.max(0, num(getProp(props, "width"), 0));
  const h = Math.max(0, num(getProp(props, "height"), num(getProp(props, "size"), 12)));
  const radius = Math.max(0, num(getProp(props, "radius"), 6));
  return <Animated.View style={{ width: w || "100%", height: h, borderRadius: radius, backgroundColor: colors.surface2, opacity: op }} />;
}

function Widget({ type, props, children }: { type: string; props: Props; children: ResolvedNode[] }) {
  switch (type) {
    // ── Layout ──
    case "Box":
      return <View style={boxStyle(props)}>{renderNodes(children)}</View>;
    case "Col":
      return (
        <View style={[boxStyle(props), { flexDirection: "column", gap: num(getProp(props, "gap"), 0) }]}>
          {renderNodes(children)}
        </View>
      );
    case "Row":
      return (
        <View style={[boxStyle(props), { flexDirection: "row", gap: num(getProp(props, "gap"), 0), flexWrap: str(getProp(props, "wrap"), "") === "wrap" ? "wrap" : "nowrap", alignItems: "center" }]}>
          {renderNodes(children)}
        </View>
      );
    case "Spacer":
      return <View style={{ height: Math.max(0, num(getProp(props, "minSize"), 8)) }} />;
    case "Divider":
      return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: color(getProp(props, "color"), colors.border), marginVertical: num(getProp(props, "spacing"), 8) }} />;

    // ── Text ──
    case "Text":
      return (
        <Text selectable style={[styles.text, textStyle(props)]}>
          {breakUnbreakable(str(getProp(props, "value"), ""))}
        </Text>
      );
    case "Markdown":
      return <Markdown text={str(getProp(props, "value"), "")} />;
    case "Math":
      return <MathView value={str(getProp(props, "value"), "")} display />;

    // ── Formular/Interaktion ──
    case "Button": {
      const label = str(getProp(props, "label"), "");
      const disabled = bool(getProp(props, "disabled"), false);
      const loading = bool(getProp(props, "loading"), false);
      const variant = str(getProp(props, "variant"), "");
      const bg = variant === "secondary" || variant === "ghost" ? colors.surface2 : colors.accent;
      const fg = variant === "secondary" || variant === "ghost" ? colors.text : "#ffffff";
      return (
        <Pressable
          disabled={disabled || loading}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: bg, borderRadius: bool(getProp(props, "pill"), false) ? 999 : 10, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Text style={{ color: fg, fontWeight: "600", fontSize: 15 }}>{loading ? "…" : label}</Text>
        </Pressable>
      );
    }
    case "Input":
    case "Textarea":
      return <InputWidget props={props} multiline={type === "Textarea"} />;
    case "Checkbox":
      return <CheckboxWidget props={props} />;
    case "Select": {
      const options = Array.isArray(getProp(props, "options")) ? (getProp(props, "options") as unknown[]).slice(0, 50) : [];
      const opts = options.map((o) => (typeof o === "string" ? o : (o as Record<string, unknown>)?.label ?? (o as Record<string, unknown>)?.value ?? String(o)));
      return (
        <View style={styles.select}>
          {opts.map((o, i) => (
            <Text key={i} style={styles.selectItem}>{t(o, "?")}</Text>
          ))}
        </View>
      );
    }
    case "Slider": {
      const val = num(getProp(props, "value"), num(getProp(props, "defaultValue"), 0));
      const min = num(getProp(props, "min"), 0);
      const max = num(getProp(props, "max"), 100);
      const pct = max > min ? Math.max(0, Math.min(1, (val - min) / (max - min))) : 0;
      return (
        <View style={styles.sliderTrack}>
          <View style={[styles.sliderFill, { width: `${Math.round(pct * 100)}%` }]} />
          <Text style={styles.sliderValue}>{val}</Text>
        </View>
      );
    }

    // ── Inhalt ──
    case "Image": {
      const src = str(getProp(props, "src"), str(getProp(props, "url"), ""));
      const w = Math.max(0, num(getProp(props, "width"), 0));
      const h = Math.max(0, num(getProp(props, "height"), 0));
      const radius = Math.max(0, num(getProp(props, "radius"), 12));
      if (!src) return null;
      // Schema-Allowlist: nur https + whitelistete data:image/* (kein file:///http:///Tracking).
      if (!isSafeImageSrc(src)) return null;
      return (
        <Image
          source={{ uri: src }}
          resizeMode="cover"
          style={{ width: w || "100%", maxWidth: "100%", height: Math.min(h || 220, MAX_MEDIA_H), borderRadius: radius, backgroundColor: colors.surface2 }}
        />
      );
    }
    case "Badge": {
      const label = str(getProp(props, "label"), "");
      const c = color(str(getProp(props, "color"), ""), colors.accent);
      // Alpha-Suffix ("22") nur bei 6-stelligem Hex — sonst (rgb()/hsl()/#abc/#rrggbbaa) unverändert.
      const bg = /^#[0-9a-f]{6}$/i.test(c) ? c + "22" : c;
      return (
        <View style={[styles.badge, { backgroundColor: bg, borderColor: c }]}>
          <Text style={{ color: c, fontWeight: "700", fontSize: 12 }}>{breakUnbreakable(label)}</Text>
        </View>
      );
    }
    case "Card":
      return (
        <View style={[styles.card, boxStyle(props)]}>
          {renderNodes(children)}
        </View>
      );
    case "List": {
      const items = Array.isArray(getProp(props, "items")) ? (getProp(props, "items") as unknown[]).slice(0, 50) : [];
      if (items.length) {
        return (
          <View style={styles.list}>
            {items.map((it, i) => (
              <View key={i} style={styles.listRow}>
                <Text style={styles.listMarker}>•</Text>
                <Text style={styles.listText}>
                  {typeof it === "string" ? breakUnbreakable(it) : str((it as Record<string, unknown>)?.label, String(it))}
                </Text>
              </View>
            ))}
          </View>
        );
      }
      return (
        <View style={styles.list}>
          {renderNodes(children)}
        </View>
      );
    }
    case "ListItem":
      return (
        <View style={styles.listRow}>
          <Text style={styles.listMarker}>{t(getProp(props, "marker"), "•")}</Text>
          <Text style={styles.listText}>{t(getProp(props, "label"))}</Text>
        </View>
      );
    case "Table": {
      const allRows = Array.isArray(getProp(props, "rows")) ? (getProp(props, "rows") as unknown[]) : [];
      const columns = Array.isArray(getProp(props, "columns")) ? (getProp(props, "columns") as unknown[]).slice(0, 50) : [];
      const rows = allRows.slice(0, 50);
      const headers = columns.map((c) => str((c as Record<string, unknown>)?.label ?? (c as Record<string, unknown>)?.header, String(c)));
      const keys = columns.map((c) => str((c as Record<string, unknown>)?.key, ""));
      return (
        <View style={styles.table}>
          {headers.some((h) => h) ? (
            <View style={styles.tableRow}>
              {headers.map((h, i) => (
                <Text key={i} style={styles.tableHeaderCell} numberOfLines={2}>{breakUnbreakable(h)}</Text>
              ))}
            </View>
          ) : null}
          {rows.map((r, ri) => {
            if (r == null) return null; // null/undefined-Zeile überspringen statt crash
            const row = (typeof r === "object" && !Array.isArray(r)) ? r as Record<string, unknown> : { value: r };
            const cells = keys.length
              ? keys.map((k) => str(row[k], ""))
              : Array.isArray(r) ? (r as unknown[]).map((c) => str(c, "")) : Object.values(row).map((v) => str(v, ""));
            return (
              <View key={ri} style={styles.tableRow}>
                {cells.map((c, ci) => (
                  <Text key={ci} style={styles.tableCell} numberOfLines={3}>{breakUnbreakable(c)}</Text>
                ))}
              </View>
            );
          })}
          {allRows.length > rows.length ? (
            <Text style={styles.tableNote}>{allRows.length - rows.length} weitere Zeilen ausgeblendet</Text>
          ) : null}
        </View>
      );
    }
    case "Chart":
    case "ValdiChart":
      return <ChartWidget props={props} />;
    case "PieChart":
    case "ValdiPieChart":
      return <PieChartWidget props={props} />;
    case "Diff":
      return <DiffWidget props={props} />;

    // ── Erweiterter Katalog (Radio/Icon/Loading/Grid/Form/Video/Svg/…) ──
    case "RadioGroup":
      return <RadioGroupWidget props={props} />;
    case "Radio":
      return <CheckboxWidget props={{ ...props, label: getProp(props, "label") }} />;
    case "Icon": {
      const name = str(getProp(props, "name"), "");
      const size = Math.max(0, num(getProp(props, "size"), 18));
      const c = color(str(getProp(props, "color"), ""), colors.text);
      const icon = str(getProp(props, "icon"), name);
      return <Text style={{ fontSize: size, color: c }}>{icon || "◆"}</Text>;
    }
    case "LoadingDot":
    case "LoadingBlock":
      return <LoadingWidget props={props} />;
    case "PulseIndicator":
      return <PulseIndicatorWidget props={props} />;
    case "Grid":
    case "Flow":
      return (
        <View style={[boxStyle(props), { flexDirection: "row", flexWrap: "wrap", gap: num(getProp(props, "gap"), num(getProp(props, "columnGap"), 8)) }]}>
          {renderNodes(children)}
        </View>
      );
    case "GridItem":
    case "FlowItem":
      return <View style={boxStyle(props)}>{renderNodes(children)}</View>;
    case "Form":
      return (
        <View style={[boxStyle(props), { flexDirection: "column", gap: num(getProp(props, "gap"), 8) }]}>
          {renderNodes(children)}
        </View>
      );
    case "YouTubeEmbed": {
      const videoId = str(getProp(props, "videoId"), "");
      const title = str(getProp(props, "title"), "Video");
      return (
        <View style={styles.youtube}>
          <Text style={{ color: colors.muted, fontSize: 13 }}>▶ {title}{videoId ? ` (${videoId})` : ""}</Text>
        </View>
      );
    }
    case "Svg":
    case "AnimatedSvg":
    case "Lottie":
      return (
        <View style={styles.svgFallback}>
          <Text style={{ color: colors.muted, fontSize: 13 }}>◈</Text>
        </View>
      );
    case "Favicon": {
      const url = str(getProp(props, "url"), "");
      const size = Math.max(0, num(getProp(props, "size"), 16));
      if (url && isSafeImageSrc(url)) {
        return <Image source={{ uri: url }} style={{ width: size, height: size, borderRadius: size / 4 }} />;
      }
      return <Text style={{ fontSize: size, color: colors.muted }}>◈</Text>;
    }
    case "DatePicker":
      return <InputWidget props={{ ...props, inputType: "date" }} multiline={false} />;
    case "Pressable": {
      const label = str(getProp(props, "label"), str(getProp(props, "value"), ""));
      return (
        <Pressable style={({ pressed }) => [styles.button, { backgroundColor: colors.surface2, opacity: pressed ? 0.8 : 1 }]}>
          <Text style={{ color: colors.text, fontWeight: "600", fontSize: 15 }}>{label || "…"}</Text>
        </Pressable>
      );
    }
    case "Carousel":
    case "VideoCarousel":
    case "OverflowRow":
      return (
        <View style={{ flexDirection: "row", gap: 8, overflow: "scroll" }}>
          {renderNodes(children)}
        </View>
      );
    case "TableHeader":
    case "TableCell":
      return <Text style={styles.text}>{t(getProp(props, "label"), str(getProp(props, "header"), ""))}</Text>;
    case "SearchImage": {
      const src = str(getProp(props, "src"), str(getProp(props, "searchImage"), ""));
      if (!src || !isSafeImageSrc(src)) return null;
      return (
        <Image
          source={{ uri: src }}
          resizeMode="cover"
          style={{ width: Math.max(0, num(getProp(props, "width"), 0)) || "100%", maxWidth: "100%", height: Math.min(Math.max(0, num(getProp(props, "height"), 0)) || 220, MAX_MEDIA_H), borderRadius: Math.max(0, num(getProp(props, "radius"), 12)), backgroundColor: colors.surface2 }}
        />
      );
    }
    case "HorizontalSwipeSurface":
    case "FlashcardFlip":
    case "FlashcardFlipStack":
    case "Tooltip":
    case "Popover":
      return <View style={boxStyle(props)}>{renderNodes(children)}</View>;

    // v2 / unbekannt → sicherer Fallback (kein Crash, kein Sandbox-Code ausführen).
    case "ClientDefinedWidget":
    case "WebWidget":
      return (
        <View style={styles.fallback}>
          <Text style={styles.fallbackText}>
            {t(getProp(props, "fallback"), "Interaktive Ansicht (nicht verfügbar)")}
          </Text>
        </View>
      );
    default:
      // Unbekanntes Widget: Kinder rendern (falls vorhanden), sonst Label/Text als Fallback.
      const kids = renderNodes(children);
      if (kids.length) return <View style={boxStyle(props)}>{kids}</View>;
      const label = str(getProp(props, "label"), str(getProp(props, "value"), ""));
      return label ? <Text style={styles.text}>{breakUnbreakable(label)}</Text> : null;
  }
}

// ── Chart-Daten (normalizeChart ist in dilviz.ts, RN-unabhängig & getestet) ──
interface ChartData {
  points: ChartPoint[];
  type: string; // aus series[0].type (recharts-Konvention)
}

function resolveChartData(data: unknown, series: unknown): ChartData {
  if (Array.isArray(series)) {
    const first = (series as unknown[])[0] as Record<string, unknown> | undefined;
    if (first && typeof first === "object") {
      const type = str(first.type, "");
      if (Array.isArray(first.data)) return { points: normalizeChart(first.data), type };
    }
  }
  return { points: normalizeChart(data), type: "" };
}

// ── Chart / ValdiChart (bar | line | area) ──
function ChartWidget({ props }: { props: Props }) {
  const { points, type: seriesType } = useMemo(
    () => resolveChartData(getProp(props, "data"), getProp(props, "series")),
    [props],
  );
  const explicitType = str(getProp(props, "type"), "").toLowerCase();
  const kind = explicitType || seriesType.toLowerCase();
  if (!points.length) return null;
  if (kind === "line" || kind === "area") {
    return <LineChart points={points} area={kind === "area"} />;
  }
  const horizontal = str(getProp(props, "layout"), "") === "vertical";
  return <BarChart points={points} horizontal={horizontal} />;
}

// ── Balken-Chart (View-basiert) ──
function BarChart({ points, horizontal }: { points: ChartPoint[]; horizontal?: boolean }) {
  if (!points.length) return null;
  const max = Math.max(1, ...points.map((p) => p.value));
  const barColor = colors.accent;
  if (horizontal) {
    return (
      <View style={styles.chart}>
        {points.map((p, i) => (
          <View key={i} style={styles.hBarRow}>
            <Text style={styles.chartLabel} numberOfLines={1}>{p.label}</Text>
            <View style={styles.hBarTrack}>
              <View style={[styles.hBarFill, { width: `${Math.round((p.value / max) * 100)}%`, backgroundColor: barColor }]} />
            </View>
            <Text style={styles.chartValue}>{p.value}</Text>
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.chart}>
      <View style={styles.vBarArea}>
        {points.map((p, i) => (
          <View key={i} style={styles.vBarCol}>
            <View style={styles.vBarTrack}>
              <View style={[styles.vBarFill, { height: `${Math.min(100, Math.max(0, Math.round(((Number.isFinite(p.value) ? p.value : 0) / max) * 100)))}%`, backgroundColor: barColor }]} />
            </View>
            <Text style={styles.chartLabel} numberOfLines={1}>{p.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ── Linien-/Flächen-Chart (SVG via react-native-svg) ──
function LineChart({ points, area }: { points: ChartPoint[]; area?: boolean }) {
  if (points.length < 2) return <BarChart points={points} />;
  const shown = points.slice(0, 60); // Rendering-Cap (Daten-Cap liegt bei 500 in normalizeChart)
  const W = 320;
  const H = 180;
  const padL = 34;
  const padR = 12;
  const padT = 12;
  const padB = 26;
  const max = Math.max(1, ...shown.map((p) => p.value));
  const min = Math.min(0, ...shown.map((p) => p.value));
  const range = max - min || 1;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const coords = shown.map((p, i) => ({
    x: padL + (i / (shown.length - 1)) * innerW,
    y: padT + innerH - ((p.value - min) / range) * innerH,
  }));
  const line = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const baseY = padT + innerH;
  const areaPath = `M ${coords[0].x},${baseY} L ${coords.map((c) => `${c.x},${c.y}`).join(" L ")} L ${coords[coords.length - 1].x},${baseY} Z`;
  const lineColor = colors.accent;
  const areaColor = "rgba(2,133,255,0.2)";
  return (
    <View style={styles.chart}>
      <Svg width={W} height={H}>
        <SvgLine x1={padL} y1={baseY} x2={W - padR} y2={baseY} stroke={colors.border} strokeWidth={1} />
        {area ? <Path d={areaPath} fill={areaColor} stroke="none" /> : null}
        <Polyline points={line} fill="none" stroke={lineColor} strokeWidth={2} />
        {coords.map((c, i) => (
          <Circle key={i} cx={c.x} cy={c.y} r={2.5} fill={lineColor} />
        ))}
        <SvgText x={2} y={padT + 4} fontSize={9} fill={colors.muted}>{max}</SvgText>
        <SvgText x={2} y={baseY - 2} fontSize={9} fill={colors.muted}>{min}</SvgText>
      </Svg>
      {shown.length <= 12 ? (
        <View style={styles.axisRow}>
          {shown.map((p, i) => (
            <Text key={i} style={styles.chartLabel} numberOfLines={1}>{p.label}</Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ── Pie / ValdiPieChart (echtes Kreisdiagramm via react-native-svg) ──
const PIE_COLORS = ["#0285FF", "#04B84C", "#FB6A22", "#AD7BF9", "#FFC300", "#339CFF", "#E25507", "#8046D9", "#00A240", "#0169CC"];

/** innerRadius (recharts: px oder "50%") → Bruchteil des Radius (0..1). */
function innerRadiusFrac(v: unknown): number {
  const s = str(v, "0");
  if (s.endsWith("%")) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n / 100)) : 0;
  }
  const n = num(v, 0);
  if (n <= 0) return 0;
  if (n <= 1) return n;
  return Math.max(0, Math.min(1, n / 100));
}

/** Polarkoordinaten: 0° = oben (12 Uhr), im Uhrzeigersinn (Screen-Koordinaten, y↓). */
function polar(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function slicePath(cx: number, cy: number, R: number, r: number, a0: number, a1: number): string {
  const p0 = polar(cx, cy, R, a0);
  const p1 = polar(cx, cy, R, a1);
  const largeArc = a1 - a0 > 180 ? 1 : 0;
  if (r <= 0.01) {
    return `M ${p0.x},${p0.y} A ${R},${R} 0 ${largeArc} 1 ${p1.x},${p1.y} L ${cx},${cy} Z`;
  }
  const p2 = polar(cx, cy, r, a1);
  const p3 = polar(cx, cy, r, a0);
  return `M ${p0.x},${p0.y} A ${R},${R} 0 ${largeArc} 1 ${p1.x},${p1.y} L ${p2.x},${p2.y} A ${r},${r} 0 ${largeArc} 0 ${p3.x},${p3.y} Z`;
}

function PieChartWidget({ props }: { props: Props }) {
  const { points } = useMemo(
    () => resolveChartData(getProp(props, "data"), getProp(props, "series")),
    [props],
  );
  const innerRadius = innerRadiusFrac(getProp(props, "innerRadius"));
  const paddingAngle = Math.max(0, num(getProp(props, "paddingAngle"), 0));
  const startAngle = num(getProp(props, "startAngle"), 0);
  const endAngle = num(getProp(props, "endAngle"), 360);
  // Hooks immer vor Early-Return aufrufen (Rules of Hooks) — computePieSlices([]) ist billig.
  const slices = useMemo(
    () => computePieSlices(points, { startAngle, endAngle, paddingAngle }),
    [points, startAngle, endAngle, paddingAngle],
  );
  if (!points.length) return null;
  const SIZE = 180;
  const R = SIZE / 2 - 4;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const r = innerRadius * R;
  return (
    <View style={styles.chart}>
      <View style={styles.pieRow}>
        <Svg width={SIZE} height={SIZE}>
          {slices.map((s, i) => (
            <Path key={i} d={slicePath(cx, cy, R, r, s.startDeg, s.endDeg)} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke={colors.surface} strokeWidth={1} />
          ))}
        </Svg>
        <View style={styles.pieLegend}>
          {slices.map((s, i) => (
            <View key={i} style={styles.pieLegendRow}>
              <View style={[styles.pieLegendDot, { backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }]} />
              <Text style={styles.chartLabel} numberOfLines={1}>{s.label}</Text>
              <Text style={styles.chartValue}>{s.pct.toFixed(1)}%</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

// ── Diff-Ansicht (markdown_diff.dec) ──
function DiffWidget({ props }: { props: Props }) {
  const oldText = str(getProp(props, "old"), str(getProp(props, "before"), ""));
  const newText = str(getProp(props, "new"), str(getProp(props, "after"), ""));
  const all = useMemo(() => classifyDiff(oldText, newText), [oldText, newText]);
  if (!all.length) return null;
  const lines = all.slice(0, 200); // Cap gegen DoS bei riesigen Diffs
  const hidden = all.length - lines.length;
  return (
    <View style={styles.diff}>
      <View style={styles.diffHeader}>
        <Text style={styles.diffStat}>
          {all.filter((l) => l.type === "added").length} hinzugefügt · {all.filter((l) => l.type === "removed").length} entfernt
        </Text>
      </View>
      {lines.map((l, i) => (
        <View
          key={i}
          style={[
            styles.diffRow,
            l.type === "added" ? styles.diffAddedRow : l.type === "removed" ? styles.diffRemovedRow : null,
          ]}
        >
          <Text
            style={[
              styles.diffMarker,
              l.type === "added"
                ? { color: oaicolors.textStatusSuccess }
                : l.type === "removed"
                  ? { color: oaicolors.textStatusError }
                  : { color: colors.muted },
            ]}
          >
            {l.type === "added" ? "+" : l.type === "removed" ? "−" : " "}
          </Text>
          <Text
            style={[
              styles.diffText,
              l.type === "added"
                ? { color: oaicolors.textStatusSuccess }
                : l.type === "removed"
                  ? { color: oaicolors.textStatusError }
                  : undefined,
            ]}
          >
            {l.text || " "}
          </Text>
        </View>
      ))}
      {hidden > 0 ? <Text style={styles.tableNote}>{hidden} weitere Zeilen ausgeblendet</Text> : null}
    </View>
  );
}

function renderNodes(nodes: ResolvedNode[]): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.kind === "text") {
      return (
        <Text key={i} selectable style={styles.text}>
          {breakUnbreakable(n.text)}
        </Text>
      );
    }
    return <Widget key={i} type={n.type} props={n.props} children={n.children} />;
  });
}

// ───────────────────────────── Öffentliche Komponente ─────────────────────────────

/** Eine DIL-Antwort (bereits geparstes JSON) rendern. */
export function Dil({ json }: { json: unknown }) {
  const nodes = useMemo(() => {
    try {
      return resolveDilRoot(json);
    } catch {
      return [];
    }
  }, [json]);
  if (!nodes.length) return null;
  return <View style={styles.root}>{renderNodes(nodes)}</View>;
}

/**
 * Antworttext rendern: zerlegt ihn in Markdown- und ```dil```-Blöcke.
 * DIL-JSON → Widgets, restlicher Text → Markdown. Kaputtes DIL → Code-Block-Fallback.
 */
export function DilRichText({ text }: { text: string }) {
  const blocks = useMemo(() => splitDilBlocks(text), [text]);
  if (!blocks.length) return <Markdown text={text} />;
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => {
        if (b.kind === "md") {
          return <Markdown key={i} text={b.text} />;
        }
        if (b.parseError || b.json == null) {
          return (
            <View key={i} style={styles.fallback}>
              <Text style={styles.fallbackText}>⚠️ Interaktive Ansicht fehlerhaft</Text>
              <Text style={styles.fallbackRaw} numberOfLines={6}>{b.raw}</Text>
            </View>
          );
        }
        return <Dil key={i} json={b.json} />;
      })}
    </View>
  );
}

// ───────────────────────────── Styles ─────────────────────────────

const styles = StyleSheet.create({
  root: { gap: 8 },
  text: { color: colors.text, fontSize: 17, lineHeight: 26, fontFamily: aiFontFamily },
  button: { alignSelf: "flex-start", paddingHorizontal: 16, paddingVertical: 10 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  checkboxRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 2, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  checkboxLabel: { color: colors.text, fontSize: 15, flex: 1 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  youtube: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, backgroundColor: colors.surface2 },
  svgFallback: { width: 48, height: 48, borderRadius: 10, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center", alignSelf: "flex-start" },
  select: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, gap: 4, backgroundColor: colors.surface },
  selectItem: { color: colors.text, fontSize: 14, paddingVertical: 2 },
  sliderTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surface2, justifyContent: "center", marginVertical: 8 },
  sliderFill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
  sliderValue: { color: colors.muted, fontSize: 12, marginTop: 4 },
  badge: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 12, gap: 6 },
  list: { gap: 4, marginVertical: 2 },
  listRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  listMarker: { color: colors.muted, fontSize: 15, lineHeight: 24 },
  listText: { color: colors.text, fontSize: 15, lineHeight: 24, flex: 1, fontFamily: aiFontFamily },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: "hidden" },
  tableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tableHeaderCell: { flex: 1, padding: 8, fontSize: 13, fontWeight: "700", color: colors.text, backgroundColor: colors.surface2 },
  tableCell: { flex: 1, padding: 8, fontSize: 13, color: colors.text },
  tableNote: { color: colors.muted, fontSize: 11, padding: 6, textAlign: "center" },
  chart: { gap: 6, marginVertical: 4 },
  vBarArea: { flexDirection: "row", alignItems: "flex-end", gap: 6, height: 140 },
  vBarCol: { flex: 1, alignItems: "center", gap: 4 },
  vBarTrack: { width: "100%", height: 110, justifyContent: "flex-end" },
  vBarFill: { width: "100%", borderRadius: 4, minHeight: 2 },
  hBarRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  hBarTrack: { flex: 1, height: 14, backgroundColor: colors.surface2, borderRadius: 7, overflow: "hidden" },
  hBarFill: { height: "100%", borderRadius: 7 },
  chartLabel: { color: colors.muted, fontSize: 11, flex: 1 },
  chartValue: { color: colors.text, fontSize: 12, fontFamily: monoFontFamily, minWidth: 30, textAlign: "right" },
  axisRow: { flexDirection: "row", gap: 2, marginTop: 2 },
  pieRow: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  pieLegend: { flex: 1, minWidth: 120, gap: 4 },
  pieLegendRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  pieLegendDot: { width: 10, height: 10, borderRadius: 3 },
  diff: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: "hidden", backgroundColor: colors.surface },
  diffHeader: { paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface2 },
  diffStat: { color: colors.muted, fontSize: 11, fontFamily: monoFontFamily },
  diffRow: { flexDirection: "row", alignItems: "flex-start" },
  diffAddedRow: { backgroundColor: oaicolors.bgStatusSuccess },
  diffRemovedRow: { backgroundColor: oaicolors.bgStatusError },
  diffMarker: { width: 20, paddingVertical: 3, paddingLeft: 6, fontFamily: monoFontFamily, fontSize: 12, lineHeight: 18, textAlign: "center" },
  diffText: { flex: 1, paddingVertical: 3, paddingRight: 8, fontSize: 13, lineHeight: 18, fontFamily: monoFontFamily, color: colors.text },
  fallback: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, gap: 4 },
  fallbackText: { color: colors.muted, fontSize: 13 },
  fallbackRaw: { color: colors.muted, fontSize: 11, fontFamily: monoFontFamily },
});
