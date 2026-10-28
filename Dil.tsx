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
import { aiFontFamily, colors, monoFontFamily } from "./theme";
import { breakUnbreakable } from "./lib";

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
      <Text style={styles.checkboxLabel}>{str(getProp(props, "label"), "")}</Text>
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
            <Text style={styles.checkboxLabel}>{label}</Text>
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
      return (
        <Text selectable style={[styles.text, { fontFamily: monoFontFamily }]}>
          {str(getProp(props, "value"), "")}
        </Text>
      );

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
            <Text key={i} style={styles.selectItem}>{str(o, "?")}</Text>
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
          style={{ width: w || "100%", height: h || 220, borderRadius: radius, backgroundColor: colors.surface2 }}
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
          <Text style={{ color: c, fontWeight: "700", fontSize: 12 }}>{label}</Text>
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
          <Text style={styles.listMarker}>{str(getProp(props, "marker"), "•")}</Text>
          <Text style={styles.listText}>{str(getProp(props, "label"), "")}</Text>
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
                <Text key={i} style={styles.tableHeaderCell} numberOfLines={2}>{h}</Text>
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
                  <Text key={ci} style={styles.tableCell} numberOfLines={3}>{c}</Text>
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
      return <BarChart data={getProp(props, "data")} series={getProp(props, "series")} />;
    case "PieChart":
    case "ValdiPieChart":
      return <BarChart data={getProp(props, "data")} series={getProp(props, "series")} horizontal />;

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
      return <Text style={styles.text}>{str(getProp(props, "label"), str(getProp(props, "header"), ""))}</Text>;
    case "SearchImage": {
      const src = str(getProp(props, "src"), str(getProp(props, "searchImage"), ""));
      if (!src || !isSafeImageSrc(src)) return null;
      return (
        <Image
          source={{ uri: src }}
          resizeMode="cover"
          style={{ width: Math.max(0, num(getProp(props, "width"), 0)) || "100%", height: Math.max(0, num(getProp(props, "height"), 0)) || 220, borderRadius: Math.max(0, num(getProp(props, "radius"), 12)), backgroundColor: colors.surface2 }}
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
            {str(getProp(props, "fallback"), "Interaktive Ansicht (nicht verfügbar)")}
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

// ── Balken-Chart (View-basiert, kein externes Charting-Dep) ──
// Robust gegenüber data=Array<{label,value}> | Array<[label,value]> | Array<number>.
function normalizeChart(data: unknown): { label: string; value: number }[] {
  if (!Array.isArray(data)) return [];
  const out: { label: string; value: number }[] = [];
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

function BarChart({ data, series, horizontal }: { data?: unknown; series?: unknown; horizontal?: boolean }) {
  const points = useMemo(() => {
    if (Array.isArray(series)) {
      // series = [{ name, type, data:[...] }] — nimm die erste Serie.
      const first = (series as unknown[])[0] as Record<string, unknown> | undefined;
      if (first && Array.isArray(first.data)) return normalizeChart(first.data);
    }
    return normalizeChart(data);
  }, [data, series]);
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
              <View style={[styles.vBarFill, { height: `${Math.round((p.value / max) * 100)}%`, backgroundColor: barColor }]} />
            </View>
            <Text style={styles.chartLabel} numberOfLines={1}>{p.label}</Text>
          </View>
        ))}
      </View>
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
  fallback: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, gap: 4 },
  fallbackText: { color: colors.muted, fontSize: 13 },
  fallbackRaw: { color: colors.muted, fontSize: 11, fontFamily: monoFontFamily },
});
