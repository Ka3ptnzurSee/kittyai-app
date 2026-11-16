import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { Ionicons } from "./icons";
import { colors } from "./theme";

/**
 * Reha-Tab = die echte Web-Ansicht (/web/reha.html), eingebettet.
 *
 * Der native Nachbau (Check-in, Sprungtest, eine lange Liste) war deutlich
 * schlechter als die Web-Seite: dort gibt es drei umschaltbare Ansichten
 * (Heute / Woche / Verlauf), vier Diagramme, Einheiten aus Garmin+Strava,
 * Symmetrie und die Datenquellen-Abdeckung.
 *
 * Die Seite holt ihre Daten selbst von /api/comeback (offen, kein Token) und
 * laedt ihre Assets relativ (/web/reha.css, /web/chart.umd.min.js) - deshalb
 * funktioniert sie in der WebView ohne weitere Verdrahtung.
 */
export function RehaTab({
  serverUrl,
}: {
  serverUrl: string;
  authHeaders?: () => Record<string, string>;
}) {
  const base = serverUrl.replace(/\/+$/, "");
  const uri = base + "/web/reha.html";
  const webRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  const reload = useCallback(() => {
    setFailed(null);
    setLoading(true);
    webRef.current?.reload();
  }, []);

  return (
    <View style={styles.root}>
      <View style={styles.bar}>
        <Text style={styles.title}>Reha · rechtes Knie</Text>
        <Pressable onPress={reload} hitSlop={10} accessibilityRole="button" accessibilityLabel="Neu laden">
          <Ionicons name="refresh" size={18} color={colors.accent} />
        </Pressable>
        <Pressable
          onPress={() => Linking.openURL(uri).catch(() => {})}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Im Browser oeffnen"
        >
          <Ionicons name="open-outline" size={18} color={colors.muted} />
        </Pressable>
      </View>

      {failed ? (
        <View style={styles.failWrap}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.muted} />
          <Text style={styles.failTitle}>Reha-Ansicht nicht erreichbar</Text>
          <Text style={styles.failText}>{failed}</Text>
          <Pressable style={styles.retryBtn} onPress={reload} accessibilityRole="button">
            <Text style={styles.retryText}>Erneut laden</Text>
          </Pressable>
        </View>
      ) : (
        <WebView
          ref={webRef}
          source={{ uri }}
          style={styles.web}
          originWhitelist={["*"]}
          startInLoadingState={false}
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures
          pullToRefreshEnabled
          contentInsetAdjustmentBehavior="automatic"
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
          onError={(e) => {
            setLoading(false);
            setFailed(String(e?.nativeEvent?.description || "Netzwerkfehler"));
          }}
          onHttpError={(e) => {
            setLoading(false);
            setFailed("HTTP " + String(e?.nativeEvent?.statusCode ?? "?"));
          }}
        />
      )}

      {loading && !failed ? (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator color={colors.accent} />
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
  web: { flex: 1, backgroundColor: colors.bg },
  loading: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  failWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28, gap: 10 },
  failTitle: { color: colors.text, fontSize: 16, fontWeight: "600" },
  failText: { color: colors.muted, fontSize: 13, textAlign: "center" },
  retryBtn: {
    marginTop: 6,
    backgroundColor: colors.accent,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
  retryText: { color: "#fff", fontWeight: "600" },
});
