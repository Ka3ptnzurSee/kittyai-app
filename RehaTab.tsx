import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Svg, { Circle, Line as SvgLine, Polyline, Rect, Text as SvgText } from "react-native-svg";
import { Ionicons } from "./icons";
import { colors } from "./theme";

type IonName = React.ComponentProps<typeof Ionicons>["name"];

/**
 * Reha-Tab (nativ, kein WebView).
 *
 * Datenquelle: GET /api/comeback (offen, kein Token). Liefert state (Heute),
 * result (Ampel + Ziele), kalender (49 Tage), wochenplan (Planwoche) und
 * history (load/wellness/lsi/aktivitaet/quellen) fuer die Verlauf-Diagramme.
 * Check-in/Sprungtest schreiben ueber POST /api/comeback/checkin und /funktion.
 */

type ComebackData = any;

const VIEWS = [
  { key: "heute", label: "Heute", icon: "today-outline" as const },
  { key: "woche", label: "Woche", icon: "calendar-outline" as const },
  { key: "verlauf", label: "Verlauf", icon: "stats-chart-outline" as const },
  { key: "plan", label: "Plan", icon: "list-outline" as const },
  { key: "quellen", label: "Quellen", icon: "server-outline" as const },
];

// --- kleine Helfer ----------------------------------------------------------

function nf(v: number | null | undefined, digits = 0): string {
  if (v == null || !isFinite(v)) return "–";
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined): string {
  if (typeof v !== "number" || !isFinite(v)) return "–";
  return Math.round(v) + " %";
}

function fmtMinutes(sec: number | null | undefined): string {
  if (sec == null || !isFinite(sec)) return "–";
  const m = Math.round(sec / 60);
  if (m < 60) return m + " min";
  return Math.floor(m / 60) + " h " + (m % 60) + " min";
}

function sportIcon(type: string | null | undefined): IonName {
  const t = (type || "").toLowerCase();
  if (t.includes("swim")) return "water-outline";
  if (t.includes("run") || t.includes("lauf")) return "walk-outline";
  if (t.includes("bike") || t.includes("cycling") || t.includes("rad")) return "bicycle-outline";
  if (t.includes("hike") || t.includes("wandern")) return "trail-sign-outline";
  if (t.includes("strength") || t.includes("kraft") || t.includes("weight")) return "barbell-outline";
  return "fitness-outline";
}

function ampelInfo(ampel: string | undefined): { color: string; label: string; bg: string } {
  if (ampel === "gruen") return { color: colors.success, label: "Grün – voll belastbar", bg: "#D9F4E4" };
  if (ampel === "gelb") return { color: colors.warning, label: "Gelb – angepasst trainieren", bg: "#FFF5F0" };
  return { color: colors.danger, label: "Rot – Schonung", bg: "#FFF0F0" };
}

function dayShort(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

// --- Diagramme (SVG) ---------------------------------------------------------

const CHART_H = 140;
const PAD_L = 34;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 22;

function yRange(values: (number | null)[]): [number, number] {
  const nums = values.filter((v): v is number => v != null && isFinite(v));
  if (!nums.length) return [0, 1];
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  if (lo === hi) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

function polySegments(
  values: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number,
): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v == null || !isFinite(v)) {
      if (cur.length) { out.push(cur.join(" ")); cur = []; }
      return;
    }
    cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (cur.length) out.push(cur.join(" "));
  return out;
}

/** Breite messen, damit die Charts die volle Kartenbreite nutzen (Svg width="100%" skaliert nicht ueberall). */
function useChartWidth(): [number, (w: number) => void] {
  const [w, setW] = useState(0);
  return [w, (nw: number) => setW(Math.round(nw))];
}

function LineChart({
  series,
  labels,
  height = CHART_H,
  unit,
  domain,
}: {
  series: { name: string; color: string; values: (number | null)[] }[];
  labels: string[];
  height?: number;
  unit?: string;
  domain?: [number, number];
}) {
  const n = Math.max(1, ...series.map((s) => s.values.length), labels.length);
  const [boxW, setBoxW] = useChartWidth();
  const W = boxW > 40 ? boxW : 360;
  const innerW = W - PAD_L - PAD_R;
  const innerH = height - PAD_T - PAD_B;
  const x = (i: number) => PAD_L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const all = series.flatMap((s) => s.values);
  const [lo, hi] = domain || yRange(all);
  const y = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo)) * innerH;

  return (
    <View onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}>
      <View style={styles.legendRow}>
        {series.map((s) => (
          <View key={s.name} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: s.color }]} />
            <Text style={styles.legendText}>{s.name}</Text>
          </View>
        ))}
      </View>
      <Svg width={W} height={height} viewBox={`0 0 ${W} ${height}`}>
        {[0, 0.5, 1].map((t) => (
          <SvgLine
            key={t}
            x1={PAD_L}
            x2={W - PAD_R}
            y1={PAD_T + t * innerH}
            y2={PAD_T + t * innerH}
            stroke={colors.border}
            strokeWidth={1}
          />
        ))}
        {series.map((s) =>
          polySegments(s.values, x, y).map((seg, i) => (
            <Polyline
              key={s.name + i}
              points={seg}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
            />
          )),
        )}
        <SvgText x={PAD_L - 4} y={PAD_T + 4} fontSize={9} fill={colors.muted} textAnchor="end">
          {unit ? `${nf(hi, 0)}${unit}` : nf(hi, 0)}
        </SvgText>
        <SvgText x={PAD_L - 4} y={PAD_T + innerH} fontSize={9} fill={colors.muted} textAnchor="end">
          {unit ? `${nf(lo, 0)}${unit}` : nf(lo, 0)}
        </SvgText>
        <SvgText x={PAD_L} y={height - 6} fontSize={9} fill={colors.muted}>
          {labels[0] || ""}
        </SvgText>
        <SvgText x={W - PAD_R} y={height - 6} fontSize={9} fill={colors.muted} textAnchor="end">
          {labels[labels.length - 1] || ""}
        </SvgText>
      </Svg>
    </View>
  );
}

function BarLineChart({
  bars,
  line,
  labels,
  height = CHART_H,
}: {
  bars: { name: string; color: string; values: (number | null)[] };
  line: { name: string; color: string; values: (number | null)[] };
  labels: string[];
  height?: number;
}) {
  const n = Math.max(bars.values.length, line.values.length, labels.length);
  const [boxW, setBoxW] = useChartWidth();
  const W = boxW > 40 ? boxW : 360;
  const innerW = W - PAD_L - PAD_R;
  const innerH = height - PAD_T - PAD_B;
  const x = (i: number) => PAD_L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const [blo, bhi] = yRange(bars.values);
  const [llo, lhi] = yRange(line.values);
  const by = (v: number) => PAD_T + (1 - (v - blo) / (bhi - blo)) * innerH;
  const ly = (v: number) => PAD_T + (1 - (v - llo) / (lhi - llo)) * innerH;
  const barW = Math.max(3, Math.min(10, innerW / n - 3));

  return (
    <View onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}>
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: bars.color }]} />
          <Text style={styles.legendText}>{bars.name}</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: line.color }]} />
          <Text style={styles.legendText}>{line.name}</Text>
        </View>
      </View>
      <Svg width={W} height={height} viewBox={`0 0 ${W} ${height}`}>
        {bars.values.map((v, i) =>
          v == null || !isFinite(v) ? null : (
            <Rect
              key={i}
              x={x(i) - barW / 2}
              y={by(v)}
              width={barW}
              height={Math.max(1, PAD_T + innerH - by(v))}
              rx={1.5}
              fill={bars.color}
              opacity={0.7}
            />
          ),
        )}
        {polySegments(line.values, x, ly).map((seg, i) => (
          <Polyline key={i} points={seg} fill="none" stroke={line.color} strokeWidth={2} />
        ))}
        <SvgText x={PAD_L} y={height - 6} fontSize={9} fill={colors.muted}>
          {labels[0] || ""}
        </SvgText>
        <SvgText x={W - PAD_R} y={height - 6} fontSize={9} fill={colors.muted} textAnchor="end">
          {labels[labels.length - 1] || ""}
        </SvgText>
      </Svg>
    </View>
  );
}

// --- kleine Bausteine --------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, tone ? { color: tone } : null]}>{value}</Text>
      {sub ? <Text style={styles.tileSub}>{sub}</Text> : null}
    </View>
  );
}

// --- Ansichten ---------------------------------------------------------------

/** Kleiner Verlauf (14 Tage) hinter einer Wellness-Kachel - wie Arnes Trend-Panel. */
function Sparkline({ values, color, height = 46 }: { values: (number | null)[]; color: string; height?: number }) {
  const nums = values.filter((v): v is number => v != null && isFinite(v));
  if (nums.length < 2) {
    return <Text style={styles.tileSub}>zu wenig Werte fuer einen Verlauf</Text>;
  }
  const W = 220;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo || 1;
  const x = (i: number) => (values.length <= 1 ? 0 : (i / (values.length - 1)) * W);
  const y = (v: number) => height - 4 - ((v - lo) / span) * (height - 8);
  return (
    <Svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none">
      {polySegments(values, x, y).map((seg, i) => (
        <Polyline key={i} points={seg} fill="none" stroke={color} strokeWidth={2} />
      ))}
    </Svg>
  );
}

/** Kleines Label-Chip (z. B. "3× Kraft"). */
function Chip({ text, color }: { text: string; color: string }) {
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <View style={[styles.chipDot, { backgroundColor: color }]} />
      <Text style={styles.chipText}>{text}</Text>
    </View>
  );
}

const TON_COLOR: Record<string, string> = { gut: colors.success, schlecht: colors.danger };

/** Wellness-Kachel nach Arnes Muster: Wert, Vergleich zum 7-Tage-Schnitt, Trend zum Aufklappen. */
function WellnessTile({ tile }: { tile: any }) {
  const [open, setOpen] = useState(false);
  const tone = TON_COLOR[tile.ton] || colors.muted;
  const delta = String(tile.delta || "");
  const arrow: IonName = delta.startsWith("+")
    ? "arrow-up"
    : delta.startsWith("−")
    ? "arrow-down"
    : "remove";
  const verlauf = (tile.verlauf || []).map((p: any) => p.wert);
  return (
    <Pressable
      style={styles.tile}
      onPress={() => setOpen((o) => !o)}
      accessibilityRole="button"
      accessibilityLabel={`${tile.label}: ${tile.wert || "kein Wert"}`}
    >
      <Text style={styles.tileLabel}>{tile.label}</Text>
      <Text style={[styles.tileValue, { color: tile.wert ? colors.text : colors.muted }]}>{tile.wert || "–"}</Text>
      {tile.delta ? (
        <View style={styles.deltaRow}>
          <Ionicons name={arrow} size={12} color={tone} />
          <Text style={[styles.deltaText, { color: tone }]}>{delta}</Text>
          <Text style={styles.tileSub}>zu Ø 7 T {tile.schnitt || ""}</Text>
        </View>
      ) : tile.wert ? (
        <Text style={styles.tileSub}>kein Vergleich (unter 3 Werten)</Text>
      ) : null}
      {tile.tag && tile.tag !== todayIso() ? (
        <Text style={styles.tileSub}>Wert vom {dayShort(tile.tag)}</Text>
      ) : null}
      {open ? (
        <View style={{ marginTop: 6 }}>
          <Sparkline values={verlauf} color={tone === colors.muted ? colors.accent : tone} />
          <Text style={styles.tileSub}>
            {(tile.verlauf || []).length} Tage · Tippen schließt den Verlauf
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sync-Karte: letzter Lauf, nächster Termin, Automatik - Knopf nur für Sonderfälle. */
function SyncCard({ sync, onSync, busy }: { sync: any; onSync: () => void; busy: boolean }) {
  if (!sync || sync.fehler) {
    return (
      <Section title="Garmin-Sync">
        <Text style={styles.hint}>Sync-Status nicht lesbar: {sync?.fehler || "keine Antwort"}</Text>
      </Section>
    );
  }
  const age = sync.last_ok_age_h;
  const ageText = age == null ? "noch kein Lauf" : age < 1 ? "vor wenigen Minuten" : `vor ${nf(age, 1)} h`;
  const dot = sync.running ? colors.warning : sync.failed_message ? colors.danger : age != null && age < sync.stale_h ? colors.success : colors.warning;
  return (
    <Section title="Garmin-Sync">
      <View style={styles.syncCard}>
        <View style={styles.syncHead}>
          <View style={[styles.dayDot, { backgroundColor: dot }]} />
          <Text style={styles.syncState}>
            {sync.running ? "läuft gerade …" : `zuletzt ${ageText}`}
          </Text>
          {sync.last_ok_trigger ? <Text style={styles.syncMeta}>{sync.last_ok_trigger}</Text> : null}
        </View>
        <Text style={styles.syncMeta}>Nächster Lauf: {sync.next_run || "unbekannt"}</Text>
        {sync.last_ok_counters ? (
          <Text style={styles.syncMeta}>
            Letzter Lauf: {sync.last_ok_counters.tage ?? 0} Tage Wellness, {sync.last_ok_counters.aktivitaeten ?? 0} Einheiten, {
              sync.last_ok_counters.lsi_zeilen ?? 0
            } LSI-Zeilen
          </Text>
        ) : null}
        {sync.failed_message ? <Text style={styles.syncFail}>Fehler: {sync.failed_message}</Text> : null}
        <Text style={[styles.syncMeta, { marginTop: 2 }]}>{sync.plan}</Text>
        {sync.auto && sync.auto !== "frisch" ? (
          <Text style={styles.syncMeta}>Automatik: Sync {sync.auto}</Text>
        ) : null}
        <Pressable
          style={[styles.btnSmall, busy ? styles.btnDisabled : null]}
          disabled={busy}
          onPress={onSync}
          accessibilityRole="button"
        >
          <Ionicons name="sync" size={14} color="#fff" />
          <Text style={styles.btnText}>Jetzt synchronisieren</Text>
        </Pressable>
      </View>
    </Section>
  );
}

/** Erklärtexte in Laien-Deutsch (Arne-Muster: <details>). */
function Erklaerungen({ texte }: { texte: Record<string, string> }) {
  const [open, setOpen] = useState<string | null>(null);
  const labels: [string, string][] = [
    ["ampel", "Was heißt grün / gelb / rot?"],
    ["readiness", "Was ist Readiness?"],
    ["hrv", "Was ist HRV?"],
    ["rhr", "Warum der Ruhepuls wichtig ist"],
    ["schlaf", "Warum Schlaf zählt"],
    ["acwr", "Was ist die Belastungs-Balance (ACWR)?"],
    ["trimp", "Was ist TRIMP?"],
    ["lsi", "Was ist LSI (Symmetrie)?"],
    ["checkin", "Wie funktioniert der Check-in?"],
    ["sprungtest", "Wie funktioniert der Sprungtest?"],
    ["sync", "Wie oft werden die Daten geholt?"],
  ];
  return (
    <Section title="Was bedeuten die Zahlen?">
      {labels
        .filter(([key]) => texte[key])
        .map(([key, label]) => {
          const isOpen = open === key;
          return (
            <View key={key} style={styles.erklaerung}>
              <Pressable onPress={() => setOpen(isOpen ? null : key)} style={styles.erklaerungHead} accessibilityRole="button">
                <Text style={styles.erklaerungLabel}>{label}</Text>
                <Ionicons name={isOpen ? "chevron-up" : "chevron-down"} size={15} color={colors.muted} />
              </Pressable>
              {isOpen ? <Text style={styles.erklaerungText}>{texte[key]}</Text> : null}
            </View>
          );
        })}
    </Section>
  );
}

function HeuteView({ data, onCheckin, onFunktion, busy }: {
  data: ComebackData;
  onCheckin: (p: { pain?: number; swelling?: number; note?: string }) => void;
  onFunktion: (p: { rechts: number; links: number }) => void;
  busy: boolean;
}) {
  const s = data.state || {};
  const r = data.result || {};
  const amp = ampelInfo(r.ampel);
  const sync = data.sync || {};
  const tiles: any[] = data.wellness_tiles || [];
  const bekannteTiles = tiles.filter((t) => t.wert);
  // LSI je Uebung: state.lsi_detail ist ein Objekt {Uebung: {lsi, right_kg, left_kg, day}}
  const lsiDetail: { name: string; lsi: number; rechts: number | null; links: number | null; day: string | null }[] = Object.entries(
    (s.lsi_detail && typeof s.lsi_detail === "object" ? s.lsi_detail : {}) as Record<string, any>,
  )
    .map(([name, d]: [string, any]) => ({
      name,
      lsi: Number(d?.lsi),
      rechts: d?.right_kg ?? null,
      links: d?.left_kg ?? null,
      day: d?.day ?? null,
    }))
    .filter((row) => isFinite(row.lsi))
    .sort((a, b) => a.lsi - b.lsi);
  const [pain, setPain] = useState<string>(s.pain != null ? String(s.pain) : "");
  const [swelling, setSwelling] = useState<string>(s.swelling != null ? String(s.swelling) : "");
  const [note, setNote] = useState<string>("");
  const [rechts, setRechts] = useState<string>("");
  const [links, setLinks] = useState<string>("");

  const heute = r.heute || {};
  const funktion = s.funktion || {};

  return (
    <View style={styles.scroll}>
      {/* Ampel */}
      <View style={[styles.ampelCard, { backgroundColor: amp.bg }]}>
        <View style={styles.ampelHead}>
          <View style={[styles.ampelDot, { backgroundColor: amp.color }]} />
          <Text style={[styles.ampelLabel, { color: amp.color }]}>{amp.label}</Text>
        </View>
        <Text style={styles.ampelDay}>
          {s.op_day != null ? `Tag ${s.op_day} nach OP` : "OP-Tag unbekannt"} · {dayShort(s.today)}
        </Text>
        {r.naechstes_ziel ? (
          <Text style={styles.ampelGoal}>
            Nächstes Ziel: {r.naechstes_ziel}
            {r.tage_bis_ziel != null ? ` (in ${r.tage_bis_ziel} Tagen)` : ""}
          </Text>
        ) : null}
        {Array.isArray(r.blockers) && r.blockers.length ? (
          <View style={styles.ampelList}>
            {r.blockers.map((b: string, i: number) => (
              <Text key={i} style={styles.ampelBlock}>• {b}</Text>
            ))}
          </View>
        ) : null}
      </View>

      {/* Plan heute */}
      {heute.einheit ? (
        <Section title="Heute geplant">
          <View style={styles.rowBetween}>
            <Text style={styles.planEinheit}>{heute.einheit}</Text>
            <Text style={styles.planIntens}>{heute.intensitaet || ""}</Text>
          </View>
          {Array.isArray(heute.details) && heute.details.length ? (
            <Text style={styles.planDetails}>{heute.details.join(" · ")}</Text>
          ) : null}
        </Section>
      ) : null}

      {/* Wellness-Kacheln wie in Arnes Dashboard */}
      {bekannteTiles.length ? (
        <Section title="Wellness (Garmin) · Tippen zeigt 14 Tage">
          <View style={styles.tileGrid}>
            {bekannteTiles.map((t) => (
              <WellnessTile key={t.key} tile={t} />
            ))}
          </View>
          <Text style={styles.hint}>
            Vergleich mit dem Schnitt der 7 Tage davor: grün = besser, rot = schlechter. Unter 3 Werten kein Vergleich.
          </Text>
        </Section>
      ) : sync.last_ok_age_h != null ? (
        <Section title="Wellness (Garmin)">
          <Text style={styles.hint}>
            Noch keine Wellness-Werte. Letzter Sync vor {nf(sync.last_ok_age_h, 1)} h — Sync läuft automatisch.
          </Text>
        </Section>
      ) : null}

      {/* Kennzahlen: nur was nicht schon in den Wellness-Kacheln steht */}
      <Section title="Belastung & Symmetrie">
        <View style={styles.tileGrid}>
          <Tile label="Readiness" value={nf(s.readiness)} sub={s.readiness_level || undefined} />
          <Tile
            label="ACWR"
            value={s.acwr != null ? Number(s.acwr).toFixed(2) : "–"}
            tone={s.acwr != null && Number(s.acwr) > 1.3 ? colors.warning : undefined}
            sub={
              s.chronic != null && Number(s.chronic) < 15
                ? `akut ${nf(s.acute, 0)} / chron ${nf(s.chronic, 0)} · zu wenig Historie`
                : `akut ${nf(s.acute, 0)} / chron ${nf(s.chronic, 0)}`
            }
          />
          <Tile
            label="LSI (schlechtester)"
            value={fmtPct(r.worst_lsi ?? (typeof s.lsi === "number" ? s.lsi : null))}
            tone={r.worst_lsi != null && Number(r.worst_lsi) < 90 ? colors.warning : undefined}
            sub="Symmetrie, Ziel 95 %"
          />
          <Tile label="Kraft" value={s.strength_week != null ? String(s.strength_week) : "–"} sub={s.last_strength ? `zuletzt ${dayShort(s.last_strength)}` : undefined} />
          <Tile label="OP-Tag" value={s.op_day != null ? String(s.op_day) : "–"} sub="Tage" />
          <Tile label="Check-in" value={s.has_checkin ? "✓" : "offen"} sub={s.has_checkin ? "heute eingetragen" : "heute noch nicht"} />
        </View>
      </Section>

      {/* LSI je Übung (Hevy-Sätze, rechts = operiert) */}
      {lsiDetail.length ? (
        <Section title="LSI je Übung (rechts = operiert)">
          {lsiDetail.map((row) => (
            <View key={row.name} style={styles.lsiRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.actName}>{row.name}</Text>
                <Text style={styles.daySub}>
                  {row.rechts != null ? `${nf(row.rechts, 1)} kg rechts` : "rechts –"}
                  {row.links != null ? ` · ${nf(row.links, 1)} kg links` : ""}
                  {row.day ? ` · ${dayShort(row.day)}` : ""}
                </Text>
              </View>
              <View style={styles.lsiBarWrap}>
                <View
                  style={[
                    styles.lsiBar,
                    {
                      width: `${Math.max(4, Math.min(100, row.lsi))}%`,
                      backgroundColor: row.lsi >= 95 ? colors.success : row.lsi >= 80 ? colors.warning : colors.danger,
                    },
                  ]}
                />
              </View>
              <Text style={styles.lsiValue}>{fmtPct(row.lsi)}</Text>
            </View>
          ))}
          <Text style={styles.hint}>Unter 80 % keine Sprünge und kein Laufen. Ziel 95 %.</Text>
        </Section>
      ) : null}

      {/* Check-in */}
      <Section title="Check-in (Schmerz / Schwellung)">
        <View style={styles.checkinRow}>
          <TextInput
            style={styles.input}
            value={pain}
            onChangeText={setPain}
            keyboardType="numeric"
            placeholder="Schmerz 0–10"
            placeholderTextColor={colors.muted}
          />
          <TextInput
            style={styles.input}
            value={swelling}
            onChangeText={setSwelling}
            keyboardType="numeric"
            placeholder="Schwellung 0–3"
            placeholderTextColor={colors.muted}
          />
        </View>
        <Pressable
          style={[styles.btn, busy ? styles.btnDisabled : null]}
          disabled={busy}
          onPress={() => {
            const p = Number(pain);
            const sw = Number(swelling);
            onCheckin({
              pain: pain.trim() !== "" && isFinite(p) ? p : undefined,
              swelling: swelling.trim() !== "" && isFinite(sw) ? sw : undefined,
              note: note.trim() || undefined,
            });
          }}
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Speichern</Text>
        </Pressable>
        <TextInput
          style={[styles.input, { minHeight: 40 }]}
          value={note}
          onChangeText={setNote}
          placeholder="Notiz (z. B. Treppe ok, Schwellung abends mehr)"
          placeholderTextColor={colors.muted}
          maxLength={200}
        />
        {s.has_checkin ? (
          <Text style={styles.hint}>Heute schon eingetragen{s.note ? `: ${s.note}` : ""}.</Text>
        ) : null}
      </Section>

      {/* Sprungtest */}
      <Section title="Sprungtest (Funktion)">
        {funktion.day ? (
          <Text style={styles.hint}>
            Letzter Test {dayShort(funktion.day)}: rechts {nf(funktion.rechts, 1)} / links {nf(funktion.links, 1)} → LSI {fmtPct(funktion.lsi)}
          </Text>
        ) : (
          <Text style={styles.hint}>Noch kein Sprungtest eingetragen.</Text>
        )}
        <View style={styles.checkinRow}>
          <TextInput
            style={styles.input}
            value={rechts}
            onChangeText={setRechts}
            keyboardType="numeric"
            placeholder="Rechts (cm)"
            placeholderTextColor={colors.muted}
          />
          <TextInput
            style={styles.input}
            value={links}
            onChangeText={setLinks}
            keyboardType="numeric"
            placeholder="Links (cm)"
            placeholderTextColor={colors.muted}
          />
        </View>
        <Pressable
          style={[styles.btn, busy ? styles.btnDisabled : null]}
          disabled={busy}
          onPress={() => {
            const rv = Number(rechts);
            const lv = Number(links);
            if (isFinite(rv) && isFinite(lv) && rv > 0 && lv > 0) onFunktion({ rechts: rv, links: lv });
          }}
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>Sprungtest eintragen</Text>
        </Pressable>
      </Section>
    </View>
  );
}

function WocheView({ data }: { data: ComebackData }) {
  const kalender: any[] = data.kalender || [];
  const heute = String(data.state?.today || "");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [zeigeAlt, setZeigeAlt] = useState(false);

  const tag = (d: any) => String(d.day || "");
  const ist = (d: any) => (Array.isArray(d.ist) ? d.ist : []);
  const geplant = (d: any) => Boolean(d.soll && d.soll.einheit);

  const kommend = kalender.filter((d) => tag(d) > heute).slice(0, 7);
  const letzte14 = kalender.filter((d) => tag(d) <= heute).slice(-14);
  const alt = kalender.filter((d) => !kommend.includes(d) && !letzte14.includes(d));

  // Wochenbilanz: letzte 7 Tage mit Plan
  const letzte7 = kalender.filter((d) => tag(d) <= heute).slice(-7);
  const sollCount = letzte7.filter(geplant).length;
  const istCount = letzte7.filter((d) => geplant(d) && ist(d).length > 0).length;

  const zeile = (d: any, i: number) => {
    const eintraege = ist(d);
    const done = eintraege.length > 0;
    const zukunft = tag(d) > heute;
    const missed = !done && !zukunft && geplant(d) && d.status !== "frei";
    const dot = done ? colors.success : zukunft ? colors.muted : missed ? colors.danger : colors.muted;
    const key = String(d.day || i);
    const open = expanded === key;
    const statusText = done
      ? eintraege.map((a: any) => a.name || a.type).join(", ")
      : zukunft
      ? geplant(d)
        ? "geplant"
        : "frei"
      : geplant(d)
      ? "nicht erledigt"
      : "frei";
    return (
      <View key={key}>
        <Pressable onPress={() => setExpanded(open ? null : key)} style={styles.dayRow} accessibilityRole="button">
          <View style={styles.dayBadge}>
            <Text style={styles.dayDow}>{d.wochentag || dayShort(d.day)}</Text>
            <Text style={styles.dayDate}>{dayShort(d.day)}</Text>
          </View>
          <View style={[styles.dayDot, { backgroundColor: dot }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.dayMain}>
              {d.soll?.einheit || "Frei"}
              {d.heute ? <Text style={styles.todayTag}>  heute</Text> : null}
            </Text>
            <Text style={styles.daySub}>{statusText}</Text>
          </View>
          {done ? <Ionicons name="checkmark-circle" size={18} color={colors.success} /> : null}
          <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.muted} />
        </Pressable>
        {open ? (
          <View style={styles.dayDetail}>
            {d.soll?.details?.length ? (
              <Text style={styles.dayDetailText}>Geplant: {d.soll.details.join(" · ")}</Text>
            ) : null}
            {eintraege.map((a: any, j: number) => (
              <View key={j} style={styles.dayDetailRow}>
                <Ionicons name={sportIcon(a.type)} size={14} color={colors.accent} />
                <Text style={styles.dayDetailText}>
                  {a.name || a.type}{a.source === "strava" ? " (Strava)" : ""} · {fmtMinutes(a.duration_s)}
                  {a.trimp != null ? ` · TRIMP ${nf(a.trimp)}` : ""}{a.tempo ? ` · ${a.tempo}` : ""}
                </Text>
              </View>
            ))}
            {missed ? <Text style={styles.dayMissed}>Verpasst — Einheit nicht eingetragen.</Text> : null}
            {zukunft && geplant(d) ? <Text style={styles.hint}>Noch offen — liegt in der Zukunft.</Text> : null}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.scroll}>
      <Section title="Diese Woche im Rückblick">
        <Text style={styles.hint}>
          {istCount} von {sollCount} geplanten Einheiten erledigt (letzte 7 Tage).
        </Text>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              {
                width: `${sollCount ? Math.round((istCount / sollCount) * 100) : 0}%`,
                backgroundColor: istCount >= sollCount ? colors.success : colors.warning,
              },
            ]}
          />
        </View>
      </Section>

      <Section title="Nächste 7 Tage">
        <Text style={styles.hint}>Was als Nächstes ansteht (aus dem Plan).</Text>
        {kommend.length ? kommend.map(zeile) : <Text style={styles.hint}>Keine Planung hinterlegt.</Text>}
      </Section>

      <Section title="Letzte 14 Tage">
        <Text style={styles.hint}>Grün = erledigt, rot = verpasst, grau = frei. Antippen für Details.</Text>
        {letzte14.length ? letzte14.slice().reverse().map(zeile) : <Text style={styles.hint}>Keine Daten.</Text>}
      </Section>

      <Section title="Ältere Tage">
        <Pressable onPress={() => setZeigeAlt(!zeigeAlt)} style={styles.btnGhost} accessibilityRole="button">
          <Text style={styles.btnGhostText}>
            {zeigeAlt ? "Ältere Tage ausblenden" : `${alt.length} ältere Tage anzeigen`}
          </Text>
        </Pressable>
        {zeigeAlt ? alt.slice().reverse().map(zeile) : null}
      </Section>
    </View>
  );
}

function VerlaufView({ data }: { data: ComebackData }) {
  const h = data.history || {};
  const load: any[] = h.load || [];
  const wellness: any[] = h.wellness || [];
  const lsi: any[] = h.lsi || [];
  const aktivitaet: any[] = h.aktivitaet || [];

  const LSI_PALETTE = ["#0285FF", "#E25507", "#00A240", "#8E24AA", "#00838F", "#C62828"];

  return (
    <View style={styles.scroll}>
      {load.length ? (
        <Section title="Belastung (akute / chronische Last)">
          <LineChart
            unit=""
            labels={load.map((d) => dayShort(d.day))}
            series={[
              { name: "akut", color: colors.warning, values: load.map((d) => d.acute) },
              { name: "chronisch", color: colors.accent, values: load.map((d) => d.chronic) },
            ]}
          />
        </Section>
      ) : null}

      {wellness.length ? (
        <Section title="Readiness (0–100)">
          <LineChart
            unit=""
            labels={wellness.map((d) => dayShort(d.day))}
            domain={[0, 100]}
            series={[{ name: "Readiness", color: colors.success, values: wellness.map((d) => d.readiness) }]}
          />
        </Section>
      ) : null}

      {wellness.some((d) => d.sleep_h != null) ? (
        <Section title="Schlaf (Stunden pro Nacht)">
          <LineChart
            unit=" h"
            labels={wellness.map((d) => dayShort(d.day))}
            domain={[0, 12]}
            series={[{ name: "Schlaf", color: colors.accent, values: wellness.map((d) => d.sleep_h) }]}
          />
        </Section>
      ) : null}

      {wellness.length ? (
        <Section title="Schritte & Stress">
          <BarLineChart
            labels={wellness.map((d) => dayShort(d.day))}
            bars={{ name: "Schritte", color: colors.accent, values: wellness.map((d) => d.steps) }}
            line={{ name: "Stress", color: colors.warning, values: wellness.map((d) => d.stress) }}
          />
        </Section>
      ) : null}

      {lsi.length ? (
        <Section title="Symmetrie (LSI) · je Übung eigene Skala">
          <Text style={styles.hint}>
            Rechts (operiert) im Verhältnis zu links in Prozent. Ziel 95 %, unter 80 % kein Springen.
          </Text>
          {lsi.slice(0, 6).map((ex, i) => {
            const punkte = (ex.punkte || []).filter((p: any) => p.lsi != null && isFinite(p.lsi));
            const werte = punkte.slice(-12).map((p: any) => p.lsi);
            const jetzt = werte.length ? werte[werte.length - 1] : null;
            const vorher = werte.length > 1 ? werte[0] : null;
            const delta = jetzt != null && vorher != null ? jetzt - vorher : null;
            return (
              <View key={ex.uebung || i} style={styles.lsiSeriesRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.actName}>{ex.uebung || "Übung"}</Text>
                  <Text style={styles.daySub}>
                    {jetzt != null ? fmtPct(jetzt) : "–"}
                    {delta != null ? ` · ${delta >= 0 ? "+" : "−"}${nf(Math.abs(delta), 1)} pp in ${punkte.length} Messungen` : ""}
                  </Text>
                </View>
                <Sparkline values={werte} color={LSI_PALETTE[i % LSI_PALETTE.length]} height={34} />
              </View>
            );
          })}
        </Section>
      ) : null}

      {aktivitaet.length ? (
        <Section title="Einheiten · letzte 90 Tage">
          <Text style={styles.hint}>
            {aktivitaet.length} Einheiten, neueste zuerst. TRIMP = Belastungswert der Einheit.
          </Text>
          {aktivitaet.map((a, i) => (
            <View key={i} style={styles.actRow}>
              <Ionicons name={sportIcon(a.type)} size={20} color={colors.accent} />
              <View style={{ flex: 1 }}>
                <Text style={styles.actName}>{a.name || a.type}</Text>
                <Text style={styles.actSub}>
                  {dayShort(a.day)} · {a.source === "strava" ? "Strava" : "Garmin"} · {fmtMinutes(a.duration_s)}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.actTrimp}>{a.trimp != null ? `TRIMP ${nf(a.trimp)}` : "–"}</Text>
                {a.stufe ? <Text style={styles.actStufe}>{a.stufe}</Text> : null}
              </View>
            </View>
          ))}
        </Section>
      ) : null}
    </View>
  );
}

function PlanView({ data }: { data: ComebackData }) {
  const wochenplan: any[] = data.wochenplan || [];
  // state.weekday ist ISO (1 = Montag). Der Plan liefert nur den Namen -> ueber Namen matchen.
  const DOW = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  const heuteName = DOW[(Number(data.state?.weekday ?? 0) || new Date().getDay() || 7) - 1] || "";
  const einheiten = wochenplan.map((w) => String(w.soll?.einheit || "Frei"));
  const kraft = wochenplan.filter((w) => w.krafttag).length;
  const physio = einheiten.filter((e) => /physio/i.test(e)).length;
  const ausdauer = einheiten.filter((e) => /ausdauer/i.test(e)).length;
  const mobility = einheiten.filter((e) => /mobility|balance|rom/i.test(e)).length;
  return (
    <View style={styles.scroll}>
      <Section title="Wochenumfang">
        <View style={styles.legendRow}>
          <Chip text={`${kraft}× Kraft`} color={colors.warning} />
          <Chip text={`${physio}× Physio`} color={colors.accent} />
          <Chip text={`${ausdauer}× Ausdauer`} color={colors.success} />
          <Chip text={`${mobility}× Mobility`} color={colors.muted} />
        </View>
        <Text style={styles.hint}>Feste Wochenstruktur der Reha. Der Ampel-Status oben kann Übungen und Sätze reduzieren.</Text>
      </Section>
      <Section title="Wochenplan">
        {wochenplan.map((w, i) => {
          const istHeute = String(w.wochentag || "") === heuteName;
          return (
            <View key={i} style={[styles.planRow, istHeute && styles.planRowHeute]}>
              <View style={styles.planDayCol}>
                <Text style={styles.planDow} numberOfLines={1}>
                  {w.wochentag || `Tag ${i + 1}`}
                </Text>
                {istHeute ? <Text style={styles.planHeuteTag}>heute</Text> : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.planEinheit}>{w.soll?.einheit || "Frei"}</Text>
                {w.soll?.intensitaet ? <Text style={styles.planIntensity}>{w.soll.intensitaet}</Text> : null}
                <Text style={styles.planDetails}>
                  {(w.soll?.details || []).join(" · ") || "–"}
                </Text>
              </View>
              {w.krafttag ? <Ionicons name="barbell" size={16} color={colors.warning} /> : null}
            </View>
          );
        })}
      </Section>
    </View>
  );
}

function QuellenView({ data, onSync, busy }: { data: ComebackData; onSync: () => void; busy: boolean }) {
  const q = data.history?.quellen || {};
  const fenster = q.fenster_tage || 30;

  const rows: { label: string; value: string; sub?: string }[] = [];
  const g = q.garmin || {};
  const st = q.strava || {};
  const hv = q.hevy || {};
  const ap = q.apple || {};

  // „31 von 30" sieht wie ein Fehler aus: Tage im Fenster hart deckeln.
  const vonFenster = (n: number | undefined) => `${Math.min(Number(n) || 0, fenster)} von ${fenster}`;
  rows.push({ label: "Garmin Wellness", value: vonFenster(g.wellness_tage), sub: "Tage mit Werten" });
  rows.push({ label: "Garmin Schritte", value: vonFenster(g.schritte_tage) });
  rows.push({ label: "Garmin Schlaf", value: vonFenster(g.schlaf_tage) });
  rows.push({ label: "Garmin HRV", value: vonFenster(g.hrv_tage) });
  rows.push({ label: "Garmin Ruhepuls", value: vonFenster(g.puls_tage) });
  rows.push({ label: "Garmin Stress", value: vonFenster(g.stress_tage) });
  rows.push({ label: "Garmin Einheiten", value: `${g.einheiten ?? 0}`, sub: `${g.mit_hf_reihe ?? 0} mit HF-Reihe` });
  rows.push({ label: "Strava Einheiten", value: `${st.einheiten ?? 0}` });
  rows.push({ label: "Hevy Workouts", value: `${hv.workouts ?? 0}`, sub: `${hv.saetze ?? 0} Sätze` });
  rows.push({ label: "Apple Health", value: `${ap.einheiten ?? 0}` });
  rows.push({ label: "Check-ins", value: `${q.checkins ?? 0}` });
  rows.push({ label: "Sprungtests", value: `${q.sprungtests ?? 0}` });

  return (
    <View style={styles.scroll}>
      <SyncCard sync={data.sync} onSync={onSync} busy={busy} />
      <Section title="Datenquellen">
        <Text style={styles.hint}>
          Abdeckung der letzten {fenster} Tage. Fehlende Tage = keine Daten von dieser Quelle.
        </Text>
        {rows.map((row, i) => (
          <View key={i} style={styles.srcRow}>
            <Text style={styles.srcLabel}>{row.label}</Text>
            <View style={{ alignItems: "flex-end" }}>
              <Text style={styles.srcValue}>{row.value}</Text>
              {row.sub ? <Text style={styles.srcSub}>{row.sub}</Text> : null}
            </View>
          </View>
        ))}
        {q.letzter_sync ? (
          <Text style={styles.syncHint}>Letzter Sync: {new Date(q.letzter_sync).toLocaleString("de-DE")}</Text>
        ) : null}
      </Section>
      <Erklaerungen texte={data.erklaerungen || {}} />
    </View>
  );
}

// --- Hauptkomponente ---------------------------------------------------------

export function RehaTab({
  serverUrl,
  authHeaders,
}: {
  serverUrl: string;
  authHeaders?: () => Record<string, string>;
}) {
  const base = serverUrl.replace(/\/+$/, "");
  const [view, setView] = useState<string>("heute");
  const [data, setData] = useState<ComebackData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastMs, setToastMs] = useState(2600);
  const [toastWarn, setToastWarn] = useState(false);

  const load = useCallback(async (refresh = false) => {
    try {
      setError(null);
      const headers: Record<string, string> = { Accept: "application/json" };
      if (authHeaders) Object.assign(headers, authHeaders());
      const res = await fetch(base + "/api/comeback" + (refresh ? "?refresh=1" : ""), { headers });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(String((e as any)?.message || e));
    } finally {
      setLoading(false);
    }
  }, [base, authHeaders]);

  useEffect(() => {
    load();
  }, [load]);

  const post = useCallback(
    async (path: string, payload: Record<string, unknown>) => {
      setBusy(true);
      setToast(null);
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (authHeaders) Object.assign(headers, authHeaders());
        const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(payload) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || "HTTP " + res.status);
        if (j?.warnung?.text) {
          // Warnzeichen im Notiztext: Arzt/Notruf-Hinweis stehen lassen, nicht wegblinzeln.
          setToastWarn(true);
          setToastMs(15000);
          setToast("⚠ " + j.warnung.text);
        } else {
          setToastWarn(false);
          setToastMs(2600);
          setToast("Gespeichert ✓");
        }
        await load(true);
      } catch (e) {
        setToastWarn(true);
        setToastMs(5000);
        setToast("Fehler: " + String((e as any)?.message || e));
      } finally {
        setBusy(false);
      }
    },
    [base, authHeaders, load],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toastMs);
    return () => clearTimeout(t);
  }, [toast, toastMs]);

  const syncNow = useCallback(async () => {
    setBusy(true);
    setToast("Sync wird angestossen …");
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (authHeaders) Object.assign(headers, authHeaders());
      const res = await fetch(base + "/api/comeback/sync", { method: "POST", headers, body: "{}" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "HTTP " + res.status);
      setToast("Sync laeuft - Werte in etwa einer Minute da");
      setTimeout(() => load(true), 45000);
    } catch (e) {
      // Aeltere Server-Version ohne /sync-Route: der normale Abruf stoesst bei
      // alten Daten ebenfalls einen Sync an - dann eben beim naechsten Oeffnen.
      await load(true);
      setToast(`Sync automatisch angefordert (${String((e as any)?.message || e)})`);
    } finally {
      setBusy(false);
    }
  }, [base, authHeaders, load]);

  const content = useMemo(() => {
    if (!data) return null;
    switch (view) {
      case "woche":
        return <WocheView data={data} />;
      case "verlauf":
        return <VerlaufView data={data} />;
      case "plan":
        return <PlanView data={data} />;
      case "quellen":
        return <QuellenView data={data} onSync={syncNow} busy={busy} />;
      default:
        return (
          <HeuteView
            data={data}
            busy={busy}
            onCheckin={(p) => post("/api/comeback/checkin", p)}
            onFunktion={(p) => post("/api/comeback/funktion", { ...p, kind: "sprung", unit: "cm" })}
          />
        );
    }
  }, [data, view, busy, post, syncNow]);

  // Sync-Zustand in der Kopfzeile: Alter der Daten / laeuft gerade / Fehler.
  const sync = data?.sync || {};
  const syncAge = sync.last_ok_age_h;
  const syncTone = sync.running
    ? colors.warning
    : sync.failed_message
    ? colors.danger
    : syncAge != null && syncAge < (sync.stale_h || 6)
    ? colors.success
    : colors.warning;
  const syncText = sync.running
    ? "Sync läuft …"
    : syncAge == null
    ? "noch kein Sync"
    : `Sync vor ${syncAge < 1 ? "wenigen Minuten" : nf(syncAge, 1) + " h"}`;

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Reha · rechtes Knie</Text>
          <View style={styles.syncBarRow}>
            <View style={[styles.syncDot, { backgroundColor: syncTone }]} />
            <Text style={styles.syncBarText}>{syncText}</Text>
            {sync.next_run ? <Text style={styles.syncBarText}> · nächster {sync.next_run}</Text> : null}
          </View>
        </View>
        <Pressable onPress={() => load(true)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Neu laden">
          <Ionicons name="refresh" size={18} color={colors.accent} />
        </Pressable>
      </View>

      <View style={styles.segment}>
        {VIEWS.map((v) => {
          const active = view === v.key;
          return (
            <Pressable
              key={v.key}
              onPress={() => setView(v.key)}
              style={[styles.segItem, active ? styles.segActive : null]}
              accessibilityRole="button"
            >
              <Ionicons name={v.icon} size={16} color={active ? "#fff" : colors.muted} />
              <Text style={[styles.segText, active ? styles.segTextActive : null]}>{v.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {loading && !data ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.hint}>Lade Reha-Daten …</Text>
        </View>
      ) : error && !data ? (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.muted} />
          <Text style={styles.failTitle}>Reha-Daten nicht erreichbar</Text>
          <Text style={styles.failText}>{error}</Text>
          <Pressable style={styles.btn} onPress={() => load()}>
            <Text style={styles.btnText}>Erneut laden</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(true)} tintColor={colors.accent} />}
        >
          {content}
        </ScrollView>
      )}

      {toast ? (
        <View style={[styles.toast, toastWarn ? styles.toastWarn : null]} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "600" },
  segment: {
    flexDirection: "row",
    marginHorizontal: 12,
    marginVertical: 10,
    backgroundColor: colors.surface2,
    borderRadius: 10,
    padding: 3,
  },
  segItem: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 7,
    borderRadius: 8,
  },
  segActive: { backgroundColor: colors.accent },
  segText: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  segTextActive: { color: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28, gap: 10 },
  scroll: { padding: 14, paddingBottom: 40, gap: 12 },
  section: { gap: 8 },
  sectionTitle: { color: colors.muted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  hint: { color: colors.muted, fontSize: 12 },
  syncHint: { color: colors.muted, fontSize: 11, marginTop: 6 },
  failTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  failText: { color: colors.muted, fontSize: 13, textAlign: "center" },
  btn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 4,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  toast: {
    position: "absolute",
    left: 24,
    right: 24,
    bottom: 26,
    backgroundColor: "rgba(13,13,13,0.92)",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
  },
  toastText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  toastWarn: { backgroundColor: "rgba(180,30,30,0.96)" },

  // Ampel
  ampelCard: { borderRadius: 14, padding: 14, gap: 8 },
  ampelHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  ampelDot: { width: 14, height: 14, borderRadius: 7 },
  ampelLabel: { fontSize: 16, fontWeight: "700" },
  ampelDay: { color: colors.text, fontSize: 13, fontWeight: "600" },
  ampelGoal: { color: colors.text, fontSize: 13 },
  ampelList: { gap: 2 },
  ampelBlock: { color: colors.text, fontSize: 13 },

  // Plan
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  planEinheit: { color: colors.text, fontSize: 15, fontWeight: "600" },
  planIntens: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  planDetails: { color: colors.muted, fontSize: 13 },

  // Tiles
  tileGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: {
    width: "48%",
    flexGrow: 1,
    minWidth: 140,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    gap: 2,
  },
  tileLabel: { color: colors.muted, fontSize: 12 },
  tileValue: { color: colors.text, fontSize: 20, fontWeight: "700" },
  tileSub: { color: colors.muted, fontSize: 11 },

  // Check-in
  checkinRow: { flexDirection: "row", gap: 8 },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },

  // Woche
  dayRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 10,
  },
  dayBadge: { width: 62, alignItems: "center" },
  dayDow: { color: colors.muted, fontSize: 11 },
  dayDate: { color: colors.text, fontSize: 15, fontWeight: "700" },
  dayDot: { width: 10, height: 10, borderRadius: 5 },
  dayMain: { color: colors.text, fontSize: 14, fontWeight: "600" },
  daySub: { color: colors.muted, fontSize: 12 },
  todayTag: { color: colors.accent, fontSize: 12 },
  dayDetail: {
    marginTop: -2,
    marginBottom: 6,
    marginLeft: 84,
    backgroundColor: colors.surface2,
    borderRadius: 8,
    padding: 10,
    gap: 6,
  },
  dayDetailRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  dayDetailText: { color: colors.text, fontSize: 12, flex: 1 },
  dayMissed: { color: colors.danger, fontSize: 12, fontWeight: "600" },

  // Verlauf
  legendRow: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: 4 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: colors.muted, fontSize: 11 },
  actRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 10,
  },
  actName: { color: colors.text, fontSize: 14, fontWeight: "600" },
  actSub: { color: colors.muted, fontSize: 12 },
  actTrimp: { color: colors.text, fontSize: 13, fontWeight: "600" },
  actStufe: { color: colors.warning, fontSize: 11 },

  // Plan
  planRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 10,
  },
  planDow: { color: colors.text, fontSize: 14, fontWeight: "700" },
  planDayCol: { width: 84, gap: 2 },
  planHeuteTag: { color: colors.accent, fontSize: 11, fontWeight: "700" },
  planIntensity: { color: colors.warning, fontSize: 12, fontWeight: "600", marginTop: 1 },
  planRowHeute: { borderWidth: 1, borderColor: colors.accent },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { color: colors.text, fontSize: 12, fontWeight: "600" },

  // Quellen
  srcRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  srcLabel: { color: colors.text, fontSize: 14 },
  srcValue: { color: colors.text, fontSize: 14, fontWeight: "700" },
  srcSub: { color: colors.muted, fontSize: 11 },

  // Sync + Erklaerungen
  syncBarRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  syncDot: { width: 7, height: 7, borderRadius: 4 },
  syncBarText: { color: colors.muted, fontSize: 11 },
  syncCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  syncHead: { flexDirection: "row", alignItems: "center", gap: 7 },
  syncState: { color: colors.text, fontSize: 14, fontWeight: "600", flex: 1 },
  syncMeta: { color: colors.muted, fontSize: 12 },
  syncFail: { color: colors.danger, fontSize: 12, fontWeight: "600" },
  btnSmall: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: colors.accent,
    paddingVertical: 8,
    borderRadius: 9,
    marginTop: 6,
  },
  deltaRow: { flexDirection: "row", alignItems: "center", gap: 4, flexWrap: "wrap" },
  deltaText: { fontSize: 12, fontWeight: "700" },
  lsiRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 10,
  },
  lsiBarWrap: { width: 64, height: 8, borderRadius: 4, backgroundColor: colors.surface2, overflow: "hidden" },
  lsiBar: { height: 8, borderRadius: 4 },
  lsiValue: { width: 46, textAlign: "right", color: colors.text, fontSize: 13, fontWeight: "700" },
  lsiSeriesRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: colors.surface2, overflow: "hidden", marginTop: 6 },
  progressFill: { height: 8, borderRadius: 4 },
  btnGhost: {
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  btnGhostText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  erklaerung: { backgroundColor: colors.surface, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  erklaerungHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  erklaerungLabel: { color: colors.text, fontSize: 13, fontWeight: "600", flex: 1 },
  erklaerungText: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 6 },
});
