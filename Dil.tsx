import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Animated,
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ResolvedNode } from "./dil";
import { splitDilBlocks, resolveDilRoot, isSafeImageSrc, sliderWert, cellWert, dilNeuSeeden, dilInhaltHash } from "./dil";
import { absoluteImageUri, getImageBaseUrl } from "./lib";
import { BildMitVollbild } from "./BildAnsicht";
import { Markdown } from "./Markdown";
import { MathView } from "./MathView";
import Svg, { Path, Polyline, Circle, Line as SvgLine, Text as SvgText, Defs, LinearGradient, Stop } from "react-native-svg";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import { computePieSlices, classifyDiff, formatiereZahl, normalizeChart } from "./dilviz";
import type { ChartPoint } from "./dilviz";
import { aiFontFamily, colors, monoFontFamily, oaicolors } from "./theme";
import { breakUnbreakable } from "./lib";
import { applyAction, collectActionProps, createRuntime, runtimeScope, seedDefaults } from "./dilstate";
import type { DilActionContext, DilRuntime } from "./dilstate";
import { evalCel } from "./dil";

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

// ───────────────────────────── DIL-Runtime (State + Actions) ─────────────────────────────
// ChatGPT/Valdi-Vertrag: `gap` statisch, `$gap` CEL-Ausdruck, `gapAction` Sandbox-Callback.
// Wir führen Actions NICHT als Fremd-JS aus, sondern über den geprüften Interpreter in
// ./dilstate (nur state-Zuweisungen + Callbacks → Follow-up-Nachricht an das Modell).

type DilDispatch = (action: string, ctx?: DilActionContext) => void;

const DilRuntimeCtx = createContext<{ rt: DilRuntime; dispatch: DilDispatch } | null>(null);

/** Fallback, wenn ein Baum ohne Provider gerendert wird (z. B. einzelnes Widget im Test). */
const NOOP_DISPATCH: DilDispatch = () => {};

/** Dispatch aus dem Runtime-Kontext — `null`, wenn der Baum ohne Provider gerendert wird. */
function useDilDispatch(): DilDispatch | null {
  const ctx = useContext(DilRuntimeCtx);
  return ctx ? ctx.dispatch : null;
}

/** Sieht ein Prop-Wert wie eine DIL-Action aus? (`onClick`/`onChange` sind bei ChatGPT Callback-Namen.) */
function looksLikeAction(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /state\.[\w$.]+\s*(=|\+=|-=)|invokeDILCallbackWithResult\s*\(|sendMessage\s*\(|askModel\s*\(/.test(v)
  );
}

/** Action-Strings eines Widgets: alle `*Action`-Props + action-förmige `onChange`/`onClick`. */
function actionsOf(props: Props): string[] {
  const out = collectActionProps(props).map(([, a]) => a);
  for (const k of ["onChange", "onClick", "onSelect", "onValueChange", "onSubmit"]) {
    const v = props[k];
    if (looksLikeAction(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Wertänderung eines Formular-Widgets in die Runtime geben:
 * erst echte Actions, sonst Fallback `state.<id> = value` (wenn das Widget ein `id`/`name` hat).
 */
function fireControl(dispatch: DilDispatch | null, props: Props, value: unknown, ctx?: DilActionContext): void {
  if (!dispatch) return;
  const actions = actionsOf(props);
  if (actions.length) {
    for (const a of actions) dispatch(a, { ...ctx, value });
    return;
  }
  const id = str(props.id, str(props.name, ""));
  if (id && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(id)) dispatch(`state.${id} = value`, { value });
}

// Properties können statisch (`gap`) oder bereits aufgelöst als `$gap` vorliegen
// (resolveDil setzt den Key mit `$`-Präfix). Wir lesen beides.
function getProp(props: Props, name: string, fallback?: unknown): unknown {
  if (Object.prototype.hasOwnProperty.call(props, name)) return props[name];
  if (Object.prototype.hasOwnProperty.call(props, "$" + name)) return props["$" + name];
  return fallback;
}

// TableRow/TableCell-Bauform in rows/columns uebersetzen.
// Ohne das rendert eine Tabelle leer, die in children-Form gebaut wurde (Befund 23.11.2026).
// rowSpan/colSpan werden bewusst nicht uebernommen - die children-Form ist ein Fallback,
// echte Spaltenstruktur gehoert in props.rows.

export function tabelleAusKindern(kinder: unknown[], maxZeilen = 50): { columns: string[]; rows: string[][]; gesamt: number } {
  const alleZeilen = kinder.filter((k) => /^Table(Row|Header)$/.test(String((k as { type?: string })?.type || '')));
  // Header zuerst aus der GESAMTEN Liste ziehen - sonst geht er verloren, wenn er hinter dem Fenster liegt
  const kopfKnoten = alleZeilen.find((z) => String((z as { type?: string }).type) === 'TableHeader') as { children?: unknown[] } | undefined;
  const alleDaten = alleZeilen.filter((z) => String((z as { type?: string }).type) !== 'TableHeader');
  const zeilen = alleDaten.slice(0, maxZeilen);
  const grid = zeilen.map((z) => {
    const zk = Array.isArray((z as { children?: unknown[] }).children) ? (z as { children: unknown[] }).children : [];
    return zk.slice(0, 50).map((c) => cellWert(c));
  });
  const kopf = kopfKnoten && Array.isArray(kopfKnoten.children) ? kopfKnoten.children.slice(0, 50).map((c) => cellWert(c)) : [];
  return { columns: kopf, rows: grid, gesamt: alleDaten.length };
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
  const dispatch = useDilDispatch();
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
      onChangeText={(next) => {
        setVal(next);
        fireControl(dispatch, props, next);
      }}
      placeholder={str(getProp(props, "placeholder"), "")}
      placeholderTextColor={colors.muted}
      multiline={multi}
      editable={!bool(getProp(props, "disabled"), false)}
      style={[styles.input, multi && { minHeight: 80, textAlignVertical: "top" }]}
    />
  );
}

function CheckboxWidget({ props }: { props: Props }) {
  const dispatch = useDilDispatch();
  const [checked, setChecked] = useState(bool(getProp(props, "checked"), bool(getProp(props, "defaultChecked"), false)));
  const checkedProp = getProp(props, "checked");
  useEffect(() => {
    if (typeof checkedProp === "boolean") setChecked(checkedProp);
  }, [checkedProp]);
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} aria-checked={checked} accessibilityLabel={t(getProp(props, "label"), "Auswahl")}
      style={styles.checkboxRow}
      onPress={() => {
        const next = !checked;
        setChecked(next);
        fireControl(dispatch, props, next);
      }}
    >
      <View style={[styles.checkbox, checked && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
        {checked ? <Text style={{ color: "#fff", fontSize: 12, lineHeight: 16 }}>✓</Text> : null}
      </View>
      <Text style={styles.checkboxLabel}>{t(getProp(props, "label"))}</Text>
    </Pressable>
  );
}

function RadioGroupWidget({ props }: { props: Props }) {
  const dispatch = useDilDispatch();
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
          <Pressable accessibilityRole="radio" accessibilityState={{ selected: active }} aria-checked={active} accessibilityLabel={t(o, "?")}
            key={i}
            style={styles.checkboxRow}
            onPress={() => {
              setValue(val);
              fireControl(dispatch, props, val);
            }}
          >
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

/** Zahl mit fester Nachkommastellenzahl, ohne Float-Artefakte (0.3 statt 0.30000000000000004). */
function festeZahl(v: number, dez: number): string {
  if (!Number.isFinite(v)) return "0";
  return v.toFixed(dez);
}

function SliderWidget({ min, max, wert, dispatch, props }: { min: number; max: number; wert: number; dispatch: DilDispatch | null; props: Props }) {
  const [breite, setBreite] = useState(0);
  const [lokal, setLokal] = useState<number | null>(null);
  const [ziehen, setZiehen] = useState(false);
  const spanne = max > min ? max - min : 1;
  const anzeige = lokal ?? (Number.isFinite(wert) ? wert : min);
  const pct = Math.max(0, Math.min(1, (anzeige - min) / spanne));
  const schritt = num(getProp(props, "step"), 1) || 1;
  // Anzeige-Praezision aus dem Schritt ("0.1" -> 1 Nachkommastelle), max 3
  const dezimal = Math.min(3, (String(schritt).split(".")[1] || "").length);
  const label = str(getProp(props, "label"), "");
  const disabled = bool(getProp(props, "disabled"), false);
  const required = bool(getProp(props, "required"), false);

  // `marks` aus dem ChatGPT-Contract: [5, 10] oder [{value, label}] - Ticks + Tap-Ziele.
  const marksRoh = getProp(props, "marks");
  const marks = Array.isArray(marksRoh)
    ? marksRoh
        .slice(0, 12)
        .map((m) => {
          const o = m as Record<string, unknown> | null;
          const v = typeof m === "number" ? m : num(o?.value, NaN);
          return { value: v, label: typeof m === "number" ? festeZahl(m, dezimal) : str(o?.label, str(o?.value, "")) };
        })
        .filter((m) => Number.isFinite(m.value) && m.value >= min && m.value <= max)
    : [];
  const marken = marks.length
    ? marks
    : [{ value: min, label: festeZahl(min, dezimal) }, { value: max, label: festeZahl(max, dezimal) }];

  const stufe = (v: number) => Math.round((v - min) / schritt);
  const letzteStufe = useRef<number | null>(null);
  // Haptisches Feedback pro Rasterschritt (nur auf echten Geraeten; im Web/Browser still).
  const ticken = (v: number) => {
    const st = stufe(v);
    if (letzteStufe.current === st) return;
    letzteStufe.current = st;
    try {
      void Haptics.selectionAsync();
    } catch {
      /* kein Haptik-Modul (Web/Tablet) - Ton ist optional */
    }
  };

  const rechnen = (x: number) => (breite > 0 ? sliderWert(min, max, schritt, x / breite) : null);
  const setzen = (x: number) => {
    const v = rechnen(x);
    if (v == null || disabled) return;
    setLokal(v);
    ticken(v);
  };
  const übernehmen = (x: number) => {
    const v = rechnen(x);
    if (v != null && !disabled) fireControl(dispatch, props, v);
    setLokal(null);
    setZiehen(false);
    letzteStufe.current = null;
  };
  const springe = (v: number) => {
    if (disabled) return;
    setLokal(null);
    fireControl(dispatch, props, Math.max(min, Math.min(max, v)));
    ticken(v);
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: (e) => {
          setZiehen(true);
          setzen(e.nativeEvent.locationX);
        },
        onPanResponderMove: (e) => setzen(e.nativeEvent.locationX),
        onPanResponderRelease: (e) => übernehmen(e.nativeEvent.locationX),
        onPanResponderTerminate: (e) => übernehmen(e.nativeEvent.locationX),
      }),
    // breite/schritt/min/max/disabled bestimmen die Rechnung
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [breite, min, max, schritt, disabled, props],
  );

  return (
    <View style={[{ marginVertical: 2 }, disabled && { opacity: 0.45 }]}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 2 }}>
        <Text style={styles.sliderLabel}>
          {label}
          {required ? <Text style={{ color: colors.accent }}> *</Text> : null}
        </Text>
        <Text style={styles.sliderWert}>{festeZahl(anzeige, dezimal)}</Text>
      </View>
      <View
        style={styles.sliderTouch}
        onLayout={(e) => setBreite(e.nativeEvent.layout.width)}
        {...pan.panHandlers}
        accessibilityRole="adjustable"
        accessibilityLabel={(label || "Schieberegler") + (required ? ", Pflichtfeld" : "")}
        accessibilityState={{ disabled }}
        accessibilityValue={{ min, max, now: Math.round(anzeige) }}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(anzeige)}
        aria-disabled={disabled}
      >
        <View style={styles.sliderTrack}>
          <View style={[styles.sliderFill, { width: `${Math.round(pct * 100)}%` }]} />
          {marks.length
            ? marks.map((m, i) => (
                <View
                  key={i}
                  pointerEvents="none"
                  style={[styles.sliderTick, { left: `${Math.round(((m.value - min) / spanne) * 100)}%` }]}
                />
              ))
            : null}
        </View>
        <View style={[styles.sliderKnopf, { left: `${Math.round(pct * 100)}%` }]} pointerEvents="none" />
        {ziehen ? (
          <View style={[styles.sliderBubble, { left: `${Math.round(pct * 100)}%` }]} pointerEvents="none">
            <Text style={styles.sliderBubbleText}>{festeZahl(anzeige, dezimal)}</Text>
          </View>
        ) : null}
      </View>
      {/* Skalenmarken: antippbar (Sprung), damit man nicht zielen muss */}
      <View style={{ height: 16, position: "relative", marginTop: 2 }}>
        {marken.map((m, i) => (
          <Pressable
            key={i}
            accessibilityRole="button"
            accessibilityLabel={`${label || "Regler"} auf ${m.label} setzen`}
            onPress={() => springe(m.value)}
            disabled={disabled}
            style={[styles.markTreffer, { left: `${Math.round(((m.value - min) / spanne) * 100)}%` }]}
          >
            <Text style={styles.markLabel} numberOfLines={1}>{m.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ── Statistik-Anzeiger: KPI-Kacheln (Stat / StatGrid / Stats) ──
// Props: items/stats/data = [{label, value, delta, unit, hint}] oder Einzelwerte
// (label+value). `$value`/`$delta` sind CEL-gebunden und folgen Slider/Select live.
type StatKachel = { label: string; value: string; delta: number | null; hint: string; unit: string };

/**
 * Fallback für PlantUML-Blöcke, die der Server nicht gerendert hat.
 * Normalerweise kommt gar kein PlantUml-Block an: server/puml.js ersetzt ihn
 * durch ein Image mit /generated/puml/<hash>.png (Java-Render, 0,5 s, gecacht).
 */
/**
 * UML-Bild, das man im Chat benutzen kann: zoomen, Knoten antippen, Schritt waehlen.
 * Die Knotenflaechen kommen vom Server (server/puml.js: svgHotspots) in
 * Prozentkoordinaten — dadurch passen sie bei jeder Anzeigebreite.
 */
function UmlBildWidget({ props, knots }: { props: Props; knots: unknown[] }) {
  const roh = str(getProp(props, "src"), str(getProp(props, "url"), ""));
  const b = Math.max(1, num(getProp(props, "width"), 1));
  const h = Math.max(1, num(getProp(props, "height"), 1));
  const seiten = b / h;
  const [gewaehlt, setGewaehlt] = useState<number | null>(null);
  const [offen, setOffen] = useState(false);
  const schritte = (Array.isArray(getProp(props, "steps")) ? (getProp(props, "steps") as unknown[]) : []).map((t) => String(t)).slice(0, 40);
  const src = /^\/generated\//i.test(roh) ? absoluteImageUri(roh, getImageBaseUrl()) || "" : roh;
  if (!src || !isSafeImageSrc(src)) return null;
  const flaechen = knots
    .map((k) => (k && typeof k === "object" ? (k as Record<string, unknown>) : null))
    .filter((k): k is Record<string, unknown> => !!k && Number.isFinite(Number(k.x)) && Number.isFinite(Number(k.y)))
    .slice(0, 120);
  const text = gewaehlt != null ? str(flaechen[gewaehlt]?.text, "") : "";
  const bild = (zoombar: boolean) => (
    <View style={{ width: "100%", aspectRatio: seiten, position: "relative" }}>
      <Image source={{ uri: src }} resizeMode="contain" style={{ width: "100%", height: "100%" }} accessibilityLabel={str(getProp(props, "alt"), "Diagramm")} />
      {flaechen.map((k, i) => (
        <Pressable
          key={i}
          accessibilityRole="button"
          accessibilityLabel={str(k.text, "Knoten " + (i + 1))}
          onPress={() => setGewaehlt(i === gewaehlt ? null : i)}
          style={{
            position: "absolute",
            left: `${Math.max(0, Math.min(100, Number(k.x)))}%`,
            top: `${Math.max(0, Math.min(100, Number(k.y)))}%`,
            width: `${Math.max(4, Math.min(100, Number(k.w)))}%`,
            height: `${Math.max(3, Math.min(100, Number(k.h)))}%`,
            borderRadius: 6,
            borderWidth: i === gewaehlt ? 2 : 0,
            borderColor: colors.accent,
            backgroundColor: i === gewaehlt ? colors.accent + "22" : "transparent",
          }}
        />
      ))}
    </View>
  );
  return (
    <View style={{ gap: 8 }}>
      <Pressable onPress={() => setOffen(true)} accessibilityRole="imagebutton" accessibilityLabel="Diagramm vergrößern">
        {bild(false)}
      </Pressable>
      {!!text && (
        <View style={[styles.statKachel, { gap: 4 }]}>
          <Text style={{ fontSize: 11, color: colors.muted }}>Schritt {gewaehlt != null ? gewaehlt + 1 : ""}</Text>
          <Text style={{ fontSize: 13, color: colors.text }} selectable>{text}</Text>
        </View>
      )}
      <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
        <Pressable onPress={() => setOffen(true)} style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border }}>
          <Text style={{ fontSize: 11, color: colors.muted }}>Vergrößern</Text>
        </Pressable>
        <Text style={{ fontSize: 11, color: colors.muted }}>
          {flaechen.length} Knoten antippbar{schritte.length ? ` · ${schritte.length} Schritte` : ""}
        </Text>
      </View>
      <Modal visible={offen} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setOffen(false)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.94)" }}>
          <ScrollView
            maximumZoomScale={5}
            minimumZoomScale={1}
            centerContent
            contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 8 }}
          >
            {bild(true)}
          </ScrollView>
          <Pressable onPress={() => setOffen(false)} style={{ padding: 14, alignItems: "center" }} accessibilityRole="button" accessibilityLabel="Schließen">
            <Text style={{ color: "#fff", fontSize: 13 }}>Zum Schließen tippen · zoomen mit zwei Fingern</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

function PlantUmlWidget({ props }: { props: Props }) {
  const code = String(getProp(props, "code") ?? getProp(props, "source") ?? getProp(props, "puml") ?? "").trim();
  const caption = String(getProp(props, "caption") ?? getProp(props, "title") ?? "");
  const [kopiertHinweis, setKopiertHinweis] = useState("");
  const kopieren = useCallback(() => {
    Clipboard.setStringAsync(code)
      .then(() => setKopiertHinweis("kopiert"))
      .catch(() => setKopiertHinweis("Kopieren fehlgeschlagen"));
    setTimeout(() => setKopiertHinweis(""), 2000);
  }, [code]);
  return (
    <View style={[styles.card, { gap: 6 }]}>
      <Text style={{ color: colors.text, fontSize: 13, fontWeight: "600" }}>
        {caption || "UML-Diagramm"}{code ? " · Quelle" : ""}
      </Text>
      {code ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 260 }}>
            <Text selectable style={[styles.fallbackRaw, { fontSize: 11, lineHeight: 16 }]}>
              {code}
            </Text>
          </ScrollView>
          <Pressable
            onPress={kopieren}
            style={{ alignSelf: "flex-start", paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border }}
          >
            <Text style={{ fontSize: 11, color: colors.muted }}>{kopiertHinweis || "Code kopieren"}</Text>
          </Pressable>
        </>
      ) : (
        <Text style={{ fontSize: 12, color: colors.muted }}>Kein Diagramm-Code übergeben.</Text>
      )}
    </View>
  );
}

function StatGridWidget({ props }: { props: Props }) {
  const dispatch = useDilDispatch();
  const aktion = ["onSelectAction", "onClickAction", "onTapAction"]
    .map((k) => getProp(props, k))
    .find((a) => typeof a === "string" && a.trim()) as string | undefined;
  const format = str(getProp(props, "format"), "auto").toLowerCase();
  const spalten = Math.max(1, Math.min(4, Math.round(num(getProp(props, "columns"), 2))));

  const roh = getProp(props, "items") ?? getProp(props, "stats") ?? getProp(props, "data");
  const kacheln: StatKachel[] = Array.isArray(roh)
    ? roh.slice(0, 12).map((e, i) => {
        const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
        const label = str(o.label ?? o.name ?? o.title, "Wert " + (i + 1));
        const wert = o.value ?? o.amount ?? o.count ?? getProp(props, "value");
        const deltaRoh = o.delta ?? o.change;
        const delta = typeof deltaRoh === "number" ? deltaRoh : Number.isFinite(Number(deltaRoh)) && deltaRoh != null && deltaRoh !== "" ? Number(deltaRoh) : null;
        return {
          label,
          value: formatiereZahl(typeof wert === "number" ? String(wert) : str(wert, "—"), format),
          delta,
          hint: str(o.hint ?? o.description ?? o.sub, ""),
          unit: str(o.unit ?? "", ""),
        };
      })
    : // Einzelkachel: <Stat label="…" value="…"/>
      [{ label: str(getProp(props, "label"), ""), value: formatiereZahl(String(getProp(props, "value") ?? "—"), format), delta: null, hint: str(getProp(props, "hint"), ""), unit: str(getProp(props, "unit"), "") }];

  if (!kacheln.length || (kacheln.length === 1 && !kacheln[0].label && kacheln[0].value === "—")) return null;

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {kacheln.map((k, i) => (
        <View
          key={i}
          accessibilityRole={aktion ? "button" : "summary"}
          accessibilityLabel={`${k.label}: ${k.value}${k.unit ? " " + k.unit : ""}${k.delta != null ? ", " + (k.delta >= 0 ? "plus" : "minus") + Math.abs(k.delta) : ""}`}
          style={[styles.statKachel, { width: spalten >= 3 ? "31%" : spalten === 2 ? "48%" : "100%" }]}
          {...(aktion
            ? { onStartShouldSetResponder: () => true, onResponderRelease: () => fireControl(dispatch, props, k.value, { event: { label: k.label, value: k.value, index: i } }) }
            : {})}
        >
          <Text style={styles.statLabel} numberOfLines={2}>{k.label}</Text>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 4 }}>
            <Text style={styles.statWert} numberOfLines={1}>{k.value}</Text>
            {k.unit ? <Text style={styles.statEinheit}>{k.unit}</Text> : null}
          </View>
          {k.delta != null ? (
            <Text style={[styles.statDelta, { color: k.delta >= 0 ? "#22c55e" : "#ef4444" }]}>
              {k.delta >= 0 ? "▲" : "▼"} {formatiereZahl(String(Math.abs(k.delta)), format)}
            </Text>
          ) : k.hint ? (
            <Text style={styles.statHint} numberOfLines={2}>{k.hint}</Text>
          ) : null}
        </View>
      ))}
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
  // Hook MUSS unbedingt vor dem switch laufen (Rules of Hooks).
  const dilCtx = useContext(DilRuntimeCtx);
  const dispatch: DilDispatch = dilCtx ? dilCtx.dispatch : NOOP_DISPATCH;
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
      const actions = actionsOf(props);
      return (
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled || !!loading }} accessibilityLabel={label || "Aktion"}
          disabled={disabled || loading}
          onPress={() => {
            // Follow-up-Frage: Action → Effekt „message" → App schickt sie als Turns an das Modell.
            for (const a of actions) dispatch(a, { value: label });
          }}
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
      const values = options.map((o, i) => (typeof o === "string" ? o : str((o as Record<string, unknown>)?.value, str(opts[i], String(i)))));
      const id = str(getProp(props, "id"), str(getProp(props, "name"), ""));
      // Runtime-State hat Vorrang vor dem Prop-Wert: props.value ist der Snapshot vom Turn-Anfang;
      // solange er gewinnt, springt die Auswahl nach jedem Tap zurueck (Befund 23.11.2026).
      const ausState = id ? str(dilCtx?.rt.state[id], "") : "";
      const selected = ausState || str(getProp(props, "value"), "");
      return (
        <View style={styles.select}>
          {opts.map((o, i) => (
            <Pressable accessibilityRole="radio" accessibilityState={{ selected: selected === values[i] }} aria-checked={selected === values[i]} accessibilityLabel={t(o, "?")}
              key={i}
              onPress={() => {
                fireControl(dispatch, props, values[i]);
              }}
            >
              <Text style={[styles.selectItem, selected === values[i] ? { color: colors.accent, fontWeight: "600" } : null]}>
                {(selected === values[i] ? "● " : "○ ") + t(o, "?")}
              </Text>
            </Pressable>
          ))}
        </View>
      );
    }
    case "Slider": {
      const min = num(getProp(props, "min"), 0);
      const max = num(getProp(props, "max"), 100);
      const id = str(getProp(props, "id"), str(getProp(props, "name"), ""));
      const ausState = id ? num(dilCtx?.rt.state[id], NaN) : NaN;
      const val = Number.isFinite(ausState) ? ausState : num(getProp(props, "value"), num(getProp(props, "defaultValue"), min));
      return <SliderWidget min={min} max={max} wert={val} dispatch={dispatch} props={props} />;
    }

    // ── Inhalt ──
    case "Image": {
      // UML/Diagramm mit Knotenflaechen: antippbar + zoombar statt toter Grafik.
      const knoten = Array.isArray(getProp(props, "hotspots")) ? (getProp(props, "hotspots") as unknown[]) : [];
      if (knoten.length) return <UmlBildWidget props={props} knots={knoten} />;
      const roh = str(getProp(props, "src"), str(getProp(props, "url"), ""));
      const w = Math.max(0, num(getProp(props, "width"), 0));
      const h = Math.max(0, num(getProp(props, "height"), 0));
      const radius = Math.max(0, num(getProp(props, "radius"), 12));
      if (!roh) return null;
      // Relative Pfade (/generated/…) gegen die Server-Basis auflösen - sonst rendert das Bild nicht
      // und der Nutzer landet beim Antippen auf der Website.
      const src = /^\/generated\//i.test(roh) ? absoluteImageUri(roh, getImageBaseUrl()) || "" : roh;
      // Schema-Allowlist: nur https + whitelistete data:image/* (kein file:///http:///Tracking).
      if (!src || !isSafeImageSrc(src)) return null;
      return (
        <BildMitVollbild
          uri={src}
          width={w || "100%"}
          height={Math.min(h || 220, MAX_MEDIA_H)} // Deckel gegen Riesen-Props
          radius={radius}
          resizeMode="cover"
          alt={str(getProp(props, "alt"), "Bild")}
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
      const rowsProp = getProp(props, "rows");
      const dataProp = Array.isArray(rowsProp) && (rowsProp as unknown[]).length ? null : getProp(props, "data");
      const ausProps = Array.isArray(rowsProp) && (rowsProp as unknown[]).length
        ? (rowsProp as unknown[])
        : Array.isArray(dataProp) ? (dataProp as unknown[]) : [];
      const ausKindern = ausProps.length ? { columns: [] as string[], rows: [] as string[][], gesamt: 0 } : tabelleAusKindern(Array.isArray(children) ? children : []);
      const allRows = ausProps.length ? ausProps : ausKindern.rows;
      const spaltenProp = getProp(props, "columns") ?? getProp(props, "headers");
      const spaltenListe = Array.isArray(spaltenProp) ? (spaltenProp as unknown[]) : spaltenProp == null ? [] : [spaltenProp];
      const columns = (spaltenListe.length ? spaltenListe : ausKindern.columns).slice(0, 50);
      const rows = allRows.slice(0, 50);
      const gesamt = ausProps.length ? ausProps.length : ausKindern.gesamt;
      const headers = columns.map((c) => {
        const o = c as Record<string, unknown> | null;
        if (o && typeof o === "object") return str(o.label ?? o.header ?? o.key, "");
        return str(c, "");
      });
      const keys = columns.map((c) => str((c as Record<string, unknown>)?.key, ""));
      const keysOk = keys.some((k) => k); // String-Spalten haben keinen key -> zeilenweise lesen
      // Spaltenbreite EINMAL berechnen (vor rows.map) - sonst O(Zeilen x Keys) pro Render
      const breite = Math.min(
        50, // Deckel: kaputtes DIL-JSON (Zeile mit 200.000 Keys) darf nicht 200.000 Text-Knoten erzeugen
        (headers.length || keys.length)
          ? Math.max(headers.length, keys.length)
          : rows.reduce((m: number, r: unknown) => Math.max(m, Array.isArray(r) ? r.length : r && typeof r === "object" ? Object.keys(r).length : 1), 0),
      );
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
            const werte = Object.values(row).slice(0, 50); // einmal, gedeckelt - Object.values auf 200.000 Keys ist teuer
            // Spaltennamen aus headers zuerst, Object.values nur als Notnagel
            const geordnet = headers.some((h) => h && Object.prototype.hasOwnProperty.call(row, h))
              ? headers.slice(0, 50).map((h) => row[h])
              : werte;
            // pro Zeile entscheiden: Array-Zeile hat Vorrang vor Spalten-Keys
            const cells = (Array.isArray(r)
              ? (r as unknown[]).map((c) => cellWert(c))
              : keysOk
                ? keys.map((k, i) => {
                    if (k) return cellWert(row[k], 0);
                    // Spalte ohne key: erst Header-Name als Schluessel, dann Position
                    const h = headers[i];
                    if (h && Object.prototype.hasOwnProperty.call(row, h)) return cellWert(row[h], 0);
                    return cellWert(werte[i], 0);
                  })
                : geordnet.map((v) => cellWert(v, 0))).slice(0, 50);
            while (cells.length < breite) cells.push("");
            if (breite > 0 && cells.length > breite) cells.length = breite; // Extra-Felder nicht anzeigen
            return (
              <View key={ri} style={styles.tableRow}>
                {cells.map((c, ci) => (
                  <Text key={ci} style={styles.tableCell} numberOfLines={3}>{breakUnbreakable(c)}</Text>
                ))}
              </View>
            );
          })}
          {gesamt > rows.length ? (
            <Text style={styles.tableNote}>{gesamt - rows.length} weitere Zeilen ausgeblendet</Text>
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
    case "Stat":
    case "StatGrid":
    case "Stats":
      return <StatGridWidget props={props} />;
    case "PlantUml":
    case "Puml":
    case "Uml":
      return <PlantUmlWidget props={props} />;

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
          style={{ width: Math.max(0, num(getProp(props, "width"), 0)) || "100%", maxWidth: "100%", height: Math.min(Math.max(0, num(getProp(props, "height"), 0)) || 220, MAX_MEDIA_H), borderRadius: Math.max(0, num(getProp(props, "radius"), 12)), backgroundColor: "transparent" }}
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
  const dispatch = useDilDispatch();
  const { points, type: seriesType } = useMemo(
    () => resolveChartData(getProp(props, "data"), getProp(props, "series")),
    [props],
  );
  const explicitType = str(getProp(props, "type"), "").toLowerCase();
  const kind = explicitType || seriesType.toLowerCase();
  // Chart-Interaktivität wie ValdiChart: onHover/onSelect → Action mit `event`-Objekt.
  const pointActions = ["onSelectAction", "onPointAction", "onHoverAction", "onClickAction"]
    .map((k) => getProp(props, k))
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  const onPick =
    dispatch && pointActions.length
      ? (p: ChartPoint, i: number) => {
          for (const a of pointActions) dispatch(a, { event: { label: p.label, value: p.value, index: i } });
        }
      : undefined;
  if (!points.length) return null;
  if (kind === "line" || kind === "area") {
    return <LineChart points={points} area={kind === "area"} />;
  }
  const horizontal = str(getProp(props, "layout"), "") === "vertical";
  return <BarChart points={points} horizontal={horizontal} onPick={onPick} />;
}

// ── Balken-Chart (View-basiert, optional antippbar) ──
// Achse und Gitterlinien liegen exakt auf der Balkenbasis: der Gitter-Container ist so
// hoch wie die Spur (TRACK_H), Labels stehen darunter - vorher sassen Ticks und Linien
// auf verschiedenen Hoehen (Befund 23.11.2026).
const TRACK_H = 110;

function BarChart({ points, horizontal, onPick }: { points: ChartPoint[]; horizontal?: boolean; onPick?: (p: ChartPoint, i: number) => void }) {
  if (!points.length) return null;
  const max = Math.max(1, ...points.map((p) => p.value));
  const ticks = [max, Math.round((max / 2) * 100) / 100, 0];
  const kurz = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v));
  const barColor = colors.accent;
  if (horizontal) {
    return (
      <View style={styles.chart}>
        {points.map((p, i) => (
          <Pressable accessibilityRole="button" accessibilityLabel={`Balken: ${p.label}, ${p.value}`} key={i} style={styles.hBarRow} disabled={!onPick} onPress={() => onPick?.(p, i)}>
            <Text style={styles.hBarLabel} numberOfLines={1}>{p.label}</Text>
            <View style={styles.hBarTrack}>
              <View style={[styles.hBarFill, { width: `${Math.max(2, Math.round((p.value / max) * 100))}%`, backgroundColor: barColor }]} />
            </View>
            <Text style={styles.chartValue}>{p.value}</Text>
          </Pressable>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.chart}>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {/* y-Skala: 3 Ticks, Hoehe = Spur, damit die Linien auf den Balken treffen */}
        <View style={styles.axisCol}>
          {ticks.map((tv, i) => (
            <Text key={i} style={styles.axisTick}>{kurz(tv)}</Text>
          ))}
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ height: TRACK_H, position: "relative" }}>
            {ticks.map((_, i) => (
              <View key={i} style={[styles.gridLine, { top: (i / (ticks.length - 1)) * TRACK_H }]} pointerEvents="none" />
            ))}
            <View style={styles.vBarArea}>
              {points.map((p, i) => {
                const wert = Number.isFinite(p.value) ? p.value : 0;
                const pct = Math.min(100, Math.max(0, (wert / max) * 100));
                return (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Säule: ${p.label}, ${p.value}`} key={i} style={styles.vBarCol} disabled={!onPick} onPress={() => onPick?.(p, i)}>
                    <View style={[styles.vBarFill, styles.vBarFillMax, { height: `${Math.max(2, pct)}%`, backgroundColor: barColor }]} />
                  </Pressable>
                );
              })}
            </View>
          </View>
          {/* Werte + Namen unter der Spur, gleiche Spaltenbreite wie die Säulen */}
          <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
            {points.map((p, i) => (
              <View key={i} style={{ flex: 1, alignItems: "center" }}>
                <Text style={styles.barWert} numberOfLines={1}>{p.value}</Text>
                <Text style={styles.chartLabel} numberOfLines={1}>{p.label}</Text>
              </View>
            ))}
          </View>
        </View>
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
  const letzter = coords[coords.length - 1];
  return (
    <View style={styles.chart}>
      <Svg width={W} height={H}>
        <Defs>
          <LinearGradient id="verlauf" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={lineColor} stopOpacity="0.38" />
            <Stop offset="1" stopColor={lineColor} stopOpacity="0.02" />
          </LinearGradient>
        </Defs>
        {/* Gitter: 3 horizontale Hilfslinien statt nur Null-Linie */}
        {[0, 0.5, 1].map((f, i) => (
          <SvgLine
            key={i}
            x1={padL}
            x2={W - padR}
            y1={padT + innerH * f}
            y2={padT + innerH * f}
            stroke={colors.border}
            strokeWidth={1}
            strokeDasharray="3,4"
          />
        ))}
        <SvgLine x1={padL} y1={baseY} x2={W - padR} y2={baseY} stroke={colors.border} strokeWidth={1} />
        {area ? <Path d={areaPath} fill="url(#verlauf)" stroke="none" /> : null}
        <Polyline points={line} fill="none" stroke={lineColor} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {coords.map((c, i) => (
          <Circle key={i} cx={c.x} cy={c.y} r={i === coords.length - 1 ? 4 : 2.5} fill={i === coords.length - 1 ? lineColor : "#ffffff"} stroke={lineColor} strokeWidth={1.5} />
        ))}
        <SvgText x={2} y={padT + 8} fontSize={9} fill={colors.muted}>{max}</SvgText>
        <SvgText x={2} y={padT + innerH / 2 + 3} fontSize={9} fill={colors.muted}>{Math.round((max + min) / 2)}</SvgText>
        <SvgText x={2} y={baseY - 2} fontSize={9} fill={colors.muted}>{min}</SvgText>
        <SvgText x={letzter.x} y={Math.max(9, letzter.y - 8)} fontSize={10} fontWeight="bold" fill={lineColor} textAnchor="middle">
          {points[coords.length - 1]?.value ?? ""}
        </SvgText>
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

/** Eine DIL-Antwort (bereits geparstes JSON) rendern.
 *
 * Befund 23.11.2026: Jeder `dil`-Block einer Antwort hatte seinen EIGENEN State —
 * ein Slider in Block 1 konnte den Chart in Block 2 nicht bewegen (Chart zeigte 0).
 * Deshalb: liegt bereits ein Runtime-Provider darüber (DilRichText/DilBereich),
 * wird dessen `state` benutzt; nur ohne Provider entsteht ein eigener.
 */
export function Dil({
  json,
  onAction,
}: {
  json: unknown;
  /** Callback aus der Sandbox (invokeDILCallbackWithResult) → App schickt Text als neuen Turn. */
  onAction?: (text: string, name: string) => void;
}) {
  const aussen = useContext(DilRuntimeCtx);
  if (aussen) return <DilInhalt json={json} rt={aussen.rt} />;
  return <DilAllein json={json} onAction={onAction} />;
}

/** Eigenständiger Block ohne umgebenden Provider: baut seinen Runtime selbst. */
function DilAllein({ json, onAction }: { json: unknown; onAction?: (text: string, name: string) => void }) {
  const { rt, dispatch } = useRuntime(json, onAction);
  return (
    <DilRuntimeCtx.Provider value={{ rt, dispatch }}>
      <DilInhalt json={json} rt={rt} />
    </DilRuntimeCtx.Provider>
  );
}

/** Gemeinsamer Runtime/State für alle DIL-Blöcke einer Antwort. */
export function DilBereich({ jsons, onAction, children }: { jsons: unknown[]; onAction?: (text: string, name: string) => void; children: ReactNode }) {
  // Liegt schon ein Provider darüber (verschachtelter Bereich in einer Antwort), wird
  // dessen State benutzt — sonst hätte jeder Block wieder einen eigenen Store (Slider in
  // Block 1 bewegte den Chart in Block 2 nicht, Befund 23.11.2026). Der Early-Return steht
  // VOR den Hooks: die innere Komponente wird dann gar nicht gemountet (keine sinnlos
  // laufende State-Maschine, keine bedingte Hook-Reihenfolge).
  const aussen = useContext(DilRuntimeCtx);
  if (aussen) return <>{children}</>;
  return <DilBereichAussen jsons={jsons} onAction={onAction}>{children}</DilBereichAussen>;
}

function DilBereichAussen({ jsons, onAction, children }: { jsons: unknown[]; onAction?: (text: string, name: string) => void; children: ReactNode }) {
  // Objektidentitaet stabil halten: useRuntime startet bei neuem `json` neu — ein bei jedem
  // Render frisch gebautes Objekt erzeugte eine Endlos-Render-Schleife (Befund 23.11.2026).
  const seedJson = useMemo(() => ({ children: jsons }), [jsons]);
  const { rt, dispatch } = useRuntime(seedJson, onAction);
  return <DilRuntimeCtx.Provider value={{ rt, dispatch }}>{children}</DilRuntimeCtx.Provider>;
}

/** Runtime + Dispatch: `state` aus allen defaultValue starten, Actions zentral anwenden. */
function useRuntime(json: unknown, onAction?: (text: string, name: string) => void): { rt: DilRuntime; dispatch: DilDispatch } {
  const [model, setModel] = useState<{ json: unknown; rt: DilRuntime }>(() => {
    const seed = extractRuntimeSeed(json);
    return { json, rt: { ...createRuntime(seed.appData, seed.constants), state: seedDefaults(json) } };
  });
  // Neue Antwort → frischer Runtime-Zustand. Entscheidend ist der INHALT, nicht die
  // Objektidentität: ein bei jedem Render neu gebautes JSON-Objekt ließ diese
  // Render-Phase-Aktualisierung nie konvergieren (Endlos-Render → Watchdog-Kill der App
  // ohne JS-Fehler, Befund 23.11.2026). hashRef verhindert das dauerhaft.
  // jsonRef merkt sich die ZULETZT GESEHENE Identität — unabhängig davon, ob geseedet
  // wurde. Sonst bliebe model.json !== json dauerhaft wahr und der Hash (inkl. vollem
  // JSON.stringify) liefe in jedem Render (Review-Fund: 0,21 ms/Render ohne Nutzen).
  // hashRef startet mit dem Hash des INITIALEN Baums: sonst würde der erste
  // Identitätswechsel (z. B. Verlauf-Refresh mit neu geparsten, inhaltsgleichen Blöcken)
  // immer neu seeden und Slider/Select auf Default zurückwerfen (Review-Fund 23.11.2026).
  const hashRef = useRef<string | null>(null);
  if (hashRef.current === null) hashRef.current = dilInhaltHash(json);
  if (model.json !== json) {
    const pruefung = dilNeuSeeden(hashRef.current, json);
    if (pruefung.neu) {
      hashRef.current = pruefung.hash;
      const seed = extractRuntimeSeed(json);
      setModel({ json, rt: { ...createRuntime(seed.appData, seed.constants), state: seedDefaults(json) } });
    } else {
      // Gleicher Inhalt, neues Objekt: nur die Referenz nachziehen (State-basiert, damit die
      // Bedingung oben beim nächsten Render false ist und StrictMode-Doppelrender nichts verliert).
      setModel((m) => (m.json === json ? m : { ...m, json }));
    }
  }

  // Refs, damit der Dispatch keine stale Closures hat (Actions halten den Turn über).
  const rtRef = useRef(model.rt);
  rtRef.current = model.rt;
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;

  const dispatch = useCallback<DilDispatch>((action, ctx) => {
    const res = applyAction(rtRef.current, action, evalCel, ctx);
    if (res.rt !== rtRef.current) {
      rtRef.current = res.rt;
      setModel((m) => ({ ...m, rt: res.rt }));
    }
    for (const eff of res.effects) onActionRef.current?.(eff.text, eff.name);
    if (res.error) console.warn("[dil] action", action, "→", res.error);
  }, []);

  return { rt: model.rt, dispatch };
}

function DilInhalt({ json, rt }: { json: unknown; rt: DilRuntime }) {
  const nodes = useMemo(() => {
    try {
      return resolveDilRoot(json, runtimeScope(rt));
    } catch {
      return [];
    }
  }, [json, rt]);
  if (!nodes.length) return null;
  return <View style={styles.root}>{renderNodes(nodes)}</View>;
}

/** appData/constants aus der (evtl. v2-)Wurzel ziehen. */
function extractRuntimeSeed(json: unknown): { appData: unknown; constants: Record<string, unknown> } {
  const root = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const appData = "appData" in root ? root.appData : null;
  const constants =
    root.constants && typeof root.constants === "object" && !Array.isArray(root.constants)
      ? (root.constants as Record<string, unknown>)
      : {};
  return { appData, constants };
}

/**
 * Antworttext rendern: zerlegt ihn in Markdown- und ```dil```-Blöcke.
 * DIL-JSON → Widgets, restlicher Text → Markdown. Kaputtes DIL → Code-Block-Fallback.
 */
export function DilRichText({ text, onAction }: { text: string; onAction?: (text: string, name: string) => void }) {
  const blocks = useMemo(() => splitDilBlocks(text), [text]);
  // Alle DIL-JSONs dieser Antwort in EINEN State seeden (Slider -> Chart in einem Schritt).
  const jsons = useMemo(
    () => blocks.flatMap((b) => (b.kind === "dil" && b.json != null ? [b.json] : [])),
    [blocks],
  );
  if (!blocks.length) return <Markdown text={text} />;
  return (
    <DilBereich jsons={jsons} onAction={onAction}>
    <View style={styles.root}>
      {blocks.map((b, i) => {
        if (b.kind === "md") {
          return <Markdown key={i} text={b.text} />;
        }
        if (b.pending) {
          // Antwort streamt noch: geparster Teil schon rendern, sonst stiller Platzhalter
          // (kein „Interaktive Ansicht fehlerhaft"-Blitz bei halbem JSON).
          if (b.json != null) return <Dil key={i} json={b.json} onAction={onAction} />;
          return <Text key={i} style={styles.fallbackText}>…</Text>;
        }
        if (b.parseError || b.json == null) {
          return (
            <View key={i} style={styles.fallback}>
              <Text style={styles.fallbackText}>⚠️ Interaktive Ansicht fehlerhaft</Text>
              <Text style={styles.fallbackRaw} numberOfLines={6}>{b.raw}</Text>
            </View>
          );
        }
        return <Dil key={i} json={b.json} onAction={onAction} />;
      })}
    </View>
    </DilBereich>
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
  checkboxLabel: { color: colors.text, fontSize: 15, flex: 1, minWidth: 0 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  youtube: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, backgroundColor: colors.surface2 },
  svgFallback: { width: 48, height: 48, borderRadius: 10, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center", alignSelf: "flex-start" },
  select: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, gap: 4, backgroundColor: colors.surface },
  selectItem: { color: colors.text, fontSize: 14, paddingVertical: 2 },
  sliderLabel: { color: colors.text, fontSize: 13, fontWeight: "600", flexShrink: 1 },
  statKachel: { backgroundColor: colors.surface, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, gap: 2 },
  statLabel: { color: colors.muted, fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 },
  statWert: { color: colors.text, fontSize: 22, fontWeight: "700", fontFamily: monoFontFamily },
  statEinheit: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  statDelta: { fontSize: 12, fontWeight: "700", fontFamily: monoFontFamily },
  statHint: { color: colors.muted, fontSize: 11 },
  sliderWert: { color: colors.accent, fontSize: 14, fontWeight: "700", fontFamily: monoFontFamily },
  sliderTick: { position: "absolute", top: -3, width: 2, height: 14, borderRadius: 1, backgroundColor: colors.border },
  sliderBubble: {
    position: "absolute",
    top: -30,
    width: 46,
    marginLeft: -23,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: colors.accent,
    alignItems: "center",
  },
  sliderBubbleText: { color: "#ffffff", fontSize: 12, fontWeight: "700", fontFamily: monoFontFamily },
  markTreffer: { position: "absolute", width: 56, marginLeft: -28, alignItems: "center" },
  markLabel: { color: colors.muted, fontSize: 10, fontFamily: monoFontFamily },
  sliderTouch: { height: 26, justifyContent: "center", marginVertical: 2 },
  sliderTrack: { height: 8, borderRadius: 4, backgroundColor: colors.surface2, justifyContent: "center" },
  sliderKnopf: {
    position: "absolute",
    width: 22,
    height: 22,
    borderRadius: 11,
    marginLeft: -11,
    top: 2,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: "#ffffff",
  },
  sliderFill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
  sliderValue: { color: colors.muted, fontSize: 12, marginTop: 4 },
  badge: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 12, gap: 6 },
  list: { gap: 4, marginVertical: 2 },
  listRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  listMarker: { color: colors.muted, fontSize: 15, lineHeight: 24 },
  listText: { color: colors.text, fontSize: 15, lineHeight: 24, flex: 1, minWidth: 0, fontFamily: aiFontFamily },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: "hidden" },
  tableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tableHeaderCell: { flex: 1, minWidth: 0, padding: 8, fontSize: 13, fontWeight: "700", color: colors.text, backgroundColor: colors.surface2 },
  tableCell: { flex: 1, minWidth: 0, padding: 8, fontSize: 13, color: colors.text },
  tableNote: { color: colors.muted, fontSize: 11, padding: 6, textAlign: "center" },
  chart: { gap: 6, marginVertical: 4 },
  vBarArea: { position: "absolute", left: 0, right: 0, top: 0, height: TRACK_H, flexDirection: "row", alignItems: "flex-end", gap: 6 },
  axisCol: { width: 34, height: TRACK_H, justifyContent: "space-between", alignItems: "flex-end" },
  axisTick: { color: colors.muted, fontSize: 10, fontFamily: monoFontFamily },
  gridLine: { position: "absolute", left: 0, right: 0, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  barWert: { color: colors.text, fontSize: 11, fontWeight: "700", fontFamily: monoFontFamily, maxWidth: "100%" },
  hBarLabel: { color: colors.muted, fontSize: 11, width: 70 },
  vBarCol: { flex: 1, height: "100%", justifyContent: "flex-end", alignItems: "center" },
  vBarFillMax: { maxWidth: 54, alignSelf: "center" },
  vBarFill: { width: "100%", borderTopLeftRadius: 6, borderTopRightRadius: 6, borderRadius: 4, minHeight: 2 },
  hBarRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  hBarTrack: { flex: 1, height: 14, backgroundColor: colors.surface2, borderRadius: 7, overflow: "hidden" },
  hBarFill: { height: "100%", borderRadius: 7 },
  chartLabel: { color: colors.muted, fontSize: 11, flex: 1, minWidth: 0 },
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
  diffText: { flex: 1, minWidth: 0, paddingVertical: 3, paddingRight: 8, fontSize: 13, lineHeight: 18, fontFamily: monoFontFamily, color: colors.text },
  fallback: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, gap: 4 },
  fallbackText: { color: colors.muted, fontSize: 13 },
  fallbackRaw: { color: colors.muted, fontSize: 11, fontFamily: monoFontFamily },
});
