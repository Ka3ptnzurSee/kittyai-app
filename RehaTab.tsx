import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { colors } from "./theme";

/**
 * Reha-Tab (Comeback-Modus der ACL-Reha).
 *
 * Holt die Zahlen aus /api/comeback - dort rechnet scripts/comeback.py aus
 * /opt/projekte/health-acl dieselben Werte, die auch die systemd-Timer nutzen
 * (Garmin-Sync: Schlaf, HRV, Ruhepuls, Readiness, TRIMP/ACWR; Hevy: LSI).
 * Kein WhatsApp-Push: Check-in und Sprungtest gehen direkt hier rein.
 */

type RehaPayload = { state: any; result: any };

export function RehaTab({
  serverUrl,
  authHeaders,
}: {
  serverUrl: string;
  authHeaders: () => Record<string, string>;
}) {
  const [data, setData] = useState<RehaPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sprungR, setSprungR] = useState("");
  const [sprungL, setSprungL] = useState("");

  const base = serverUrl.replace(/\/+$/, "");

  const load = useCallback(
    async (refresh = false) => {
      setBusy(true);
      try {
        const res = await fetch(base + "/api/comeback" + (refresh ? "?refresh=1" : ""), {
          headers: authHeaders(),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        setData(await res.json());
        setError(null);
      } catch (e: any) {
        setError(String(e?.message || e));
      } finally {
        setBusy(false);
      }
    },
    [base, authHeaders],
  );

  useEffect(() => {
    load();
  }, [load]);

  async function post(pfad: string, payload: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(base + "/api/comeback/" + pfad, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const antwort: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(antwort?.error || "HTTP " + res.status));
      setError(null);
      await load(true);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const st: any = data?.state || {};
  const res: any = data?.result || {};
  const heute = res?.heute || { einheit: "", details: [] };
  const sprung = st?.funktion?.sprung;
  const hq = st?.hq || {};
  const trend: any[] = Array.isArray(st?.lsi_trend) ? st.lsi_trend : [];
  const luecke: any[] = Array.isArray(res?.lsi_luecke) ? res.lsi_luecke : [];
  const ampelFarbe =
    res.ampel === "rot" ? colors.danger : res.ampel === "gelb" ? colors.warning : colors.success;
  const zellen = [
    { label: "Readiness", wert: st.readiness != null ? String(st.readiness) : "-" },
    { label: "Schlaf", wert: st.sleep_h != null ? Number(st.sleep_h).toFixed(1) + " h" : "-" },
    { label: "HRV", wert: st.hrv_status ? String(st.hrv_status) : "-" },
    { label: "Ruhepuls", wert: st.rhr != null ? String(Math.round(Number(st.rhr))) : "-" },
    { label: "ACWR", wert: st.acwr != null ? Number(st.acwr).toFixed(2) : "-" },
    { label: "LSI", wert: res.worst_lsi != null ? Math.round(Number(res.worst_lsi)) + " %" : "-" },
    { label: "Kraft 7 T", wert: st.strength_week != null ? String(st.strength_week) : "-" },
  ];


  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.wrap}>
      <View style={styles.kopf}>
        <View style={[styles.ampel, { backgroundColor: ampelFarbe }]}>
          <Text style={styles.ampelText}>
            {res.ampel ? String(res.ampel).toUpperCase() : "..."}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.titel}>ACL-Reha</Text>
          <Text style={styles.sub}>
            {st.op_day != null ? "Tag " + st.op_day + " post-OP" : "noch keine Daten"}
            {res.naechstes_ziel
              ? " · " + res.naechstes_ziel + " in " + res.tage_bis_ziel + " Tagen"
              : ""}
          </Text>
        </View>
        <Pressable onPress={() => load(true)} style={styles.reload}>
          {busy ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Text style={styles.reloadText}>Neu</Text>
          )}
        </Pressable>
      </View>

      {error ? (
        <View style={[styles.card, { borderLeftWidth: 4, borderLeftColor: colors.danger }]}>
          <Text style={styles.fehler}>Reha-Daten nicht abrufbar: {error}</Text>
          <Text style={styles.sub}>
            Sonst lokal prüfen: python3 scripts/comeback.py status
          </Text>
        </View>
      ) : null}

      <View style={styles.grid}>
        {zellen.map((z) => (
          <View key={z.label} style={styles.zelle}>
            <Text style={styles.zahl}>{z.wert}</Text>
            <Text style={styles.label}>{z.label}</Text>
          </View>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitel}>Heute</Text>
        <Text style={styles.einheit}>{heute.einheit || "-"}</Text>
        {(heute.details || []).map((d: string, i: number) => (
          <Text key={i} style={styles.zeile}>
            · {d}
          </Text>
        ))}
      </View>

      {res.blockers && res.blockers.length ? (
        <View style={[styles.card, { borderLeftWidth: 4, borderLeftColor: colors.danger }]}>
          <Text style={styles.cardTitel}>Stopp</Text>
          {res.blockers.map((b: string, i: number) => (
            <Text key={i} style={styles.zeile}>
              · {b}
            </Text>
          ))}
        </View>
      ) : null}

      {res.warnungen && res.warnungen.length ? (
        <View style={[styles.card, { borderLeftWidth: 4, borderLeftColor: colors.warning }]}>
          <Text style={styles.cardTitel}>Achtung</Text>
          {res.warnungen.map((b: string, i: number) => (
            <Text key={i} style={styles.zeile}>
              · {b}
            </Text>
          ))}
        </View>
      ) : null}


      <View style={styles.card}>
        <Text style={styles.cardTitel}>Symmetrie bis 95 %</Text>
        {luecke.length === 0 ? (
          <Text style={styles.zeile}>Noch keine einbeinigen Hevy-Sätze.</Text>
        ) : (
          luecke.map((row: any) => (
            <View key={row.uebung} style={styles.symRow}>
              <Text style={styles.symName}>{row.uebung}</Text>
              <View style={styles.track}>
                <View
                  style={[styles.fill, { width: (Math.min(100, Math.max(2, Number(row.lsi))) + "%") as any }]}
                />
              </View>
              <Text style={styles.symWert}>
                {Math.round(row.lsi)} % · {row.jetzt_kg} / {row.ziel_kg} kg rechts
              </Text>
            </View>
          ))
        )}
        {trend.map((t: any) => (
          <Text key={t.uebung} style={styles.sub}>
            {t.uebung}: {t.delta > 0 ? "+" : ""}
            {t.delta} pp in {t.tage} Tagen ({t.krafteinheiten} Krafteinheiten, Messung{" "}
            {t.tage_seit_letzter} Tage alt)
          </Text>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitel}>Sprung einbeinig (Physio)</Text>
        {sprung ? (
          <Text style={styles.zeile}>
            rechts {sprung.right_value} / links {sprung.left_value} {sprung.unit} = LSI{" "}
            {Math.round(sprung.lsi)} % ({sprung.day})
          </Text>
        ) : (
          <Text style={styles.zeile}>Noch kein Test eingetragen.</Text>
        )}
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder="rechts cm"
            keyboardType="numeric"
            value={sprungR}
            onChangeText={setSprungR}
          />
          <TextInput
            style={styles.input}
            placeholder="links cm"
            keyboardType="numeric"
            value={sprungL}
            onChangeText={setSprungL}
          />
          <Pressable
            style={styles.btn}
            onPress={() =>
              post("funktion", {
                kind: "sprung",
                rechts: Number(sprungR.replace(",", ".")),
                links: Number(sprungL.replace(",", ".")),
              })
            }
          >
            <Text style={styles.btnText}>Speichern</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitel}>H/Q-Verhältnis</Text>
        <Text style={styles.zeile}>
          {hq.messbar
            ? "rechts " +
              hq.hq_rechts +
              " · links " +
              hq.hq_links +
              " (Ziel rechts über 0,6 - Beinbeuger einbeinig loggen)"
            : "nicht messbar: " + (hq.grund || "kein einbeiniges Beinbeugen geloggt")}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitel}>Check-in heute</Text>
        <Text style={styles.sub}>
          {st.pain != null ? "Schmerz " + st.pain + "/10" : "Schmerz noch nicht eingetragen"}
          {st.swelling != null ? " · Schwellung " + (st.swelling ? "ja" : "nein") : ""}
        </Text>
        <View style={styles.chips}>
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
            <Pressable
              key={n}
              onPress={() => post("checkin", { pain: n })}
              style={[styles.chip, st.pain === n && styles.chipActive]}
            >
              <Text style={[styles.chipText, st.pain === n && styles.chipTextActive]}>{n}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.inputRow}>
          <Pressable style={styles.btn} onPress={() => post("checkin", { swelling: 0 })}>
            <Text style={styles.btnText}>keine Schwellung</Text>
          </Pressable>
          <Pressable style={styles.btn} onPress={() => post("checkin", { swelling: 1 })}>
            <Text style={styles.btnText}>Schwellung</Text>
          </Pressable>
        </View>
        {st.note ? <Text style={styles.sub}>Notiz: {st.note}</Text> : null}
      </View>
    </ScrollView>
  );
}


const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.bg },
  wrap: { padding: 14, gap: 10, paddingBottom: 48 },
  kopf: { flexDirection: "row", alignItems: "center", gap: 12 },
  ampel: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12 },
  ampelText: { color: "#FFFFFF", fontWeight: "800", fontSize: 13, letterSpacing: 0.6 },
  titel: { fontSize: 20, fontWeight: "800", color: colors.text },
  sub: { fontSize: 12.5, color: colors.muted, marginTop: 2, lineHeight: 17 },
  reload: { minWidth: 48, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: colors.surface2, alignItems: "center" },
  reloadText: { color: colors.accent, fontWeight: "700", fontSize: 13 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  zelle: { flexGrow: 1, minWidth: "29%", backgroundColor: colors.surface, borderRadius: 12, padding: 10 },
  zahl: { fontSize: 18, fontWeight: "800", color: colors.text },
  label: { fontSize: 11.5, color: colors.muted, marginTop: 1 },
  card: { backgroundColor: colors.surface, borderRadius: 14, padding: 12, gap: 4 },
  cardTitel: { fontSize: 12.5, fontWeight: "800", color: colors.text, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 2 },
  einheit: { fontSize: 15.5, fontWeight: "700", color: colors.text },
  zeile: { fontSize: 13.5, color: colors.text, lineHeight: 19 },
  fehler: { fontSize: 13.5, color: colors.danger, fontWeight: "600" },
  symRow: { gap: 3, marginTop: 6 },
  symName: { fontSize: 13, fontWeight: "700", color: colors.text },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
  symWert: { fontSize: 12, color: colors.muted },
  inputRow: { flexDirection: "row", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" },
  input: { flexGrow: 1, minWidth: 90, backgroundColor: colors.surface2, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: colors.text },
  btn: { backgroundColor: colors.accentSoft, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  btnText: { color: colors.accent, fontWeight: "700", fontSize: 13 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chip: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" },
  chipActive: { backgroundColor: colors.accent },
  chipText: { fontSize: 12.5, color: colors.text, fontWeight: "600" },
  chipTextActive: { color: "#FFFFFF" },
});

