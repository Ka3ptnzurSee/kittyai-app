import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { beschreibeFehler, meldeRenderFehler } from "./crashHandler";
import { colors } from "./theme";
import { firstFrame } from "./lib";

/**
 * Fehler-Grenze (ErrorBoundary) — verhindert, dass EIN defekter Block die ganze App abschießt.
 *
 * Befund 23.11.2026 (Build 132): Beim Öffnen bestimmter Verläufe beendete sich die App
 * ohne jeden Absturzbericht. Der globale JS-Handler (crashHandler.ts) war aktiv und hatte
 * 59 Einträge — aber keinen einzigen `js_crash`, also war es kein unbehandelter
 * JS-Fehler, den React hätte weiterreichen können. Es fehlte die Ebene dazwischen:
 * ein Render-Fehler in einer einzelnen Nachricht/DIL-Ansicht nahm bisher die gesamte
 * Ansicht mit. Diese Grenze fängt das ab, zeigt einen aufklappbaren Hinweis statt eines
 * Absturzes und meldet Kategorie + Ort an /api/client-error (kind="render_crash").
 */

type Props = {
  children: ReactNode;
  /** Wo die Grenze sitzt (Telemetrie + Hinweistext), z. B. "nachricht" oder "verlauf". */
  bereich: string;
  /** Ändert sich dieser Wert (z. B. Chat-ID), wird die Grenze zurückgesetzt. */
  resetKey?: string;
  /** Kompakter Hinweis (in der Blase) statt großflächigem Block. */
  kompakt?: boolean;
};

type State = { fehler: string | null };

export class SichererBlock extends Component<Props, State> {
  state: State = { fehler: null };

  static getDerivedStateFromError(error: unknown): State {
    return { fehler: beschreibeFehler(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const ort = info?.componentStack ? firstFrame(info.componentStack) : "";
    meldeRenderFehler(`${beschreibeFehler(error)}${ort ? ` @${ort}` : ""}`, this.props.bereich);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.fehler) {
      this.setState({ fehler: null });
    }
  }

  private erneut = (): void => {
    this.setState({ fehler: null });
  };

  render(): ReactNode {
    if (!this.state.fehler) return this.props.children;
    return (
      <View style={this.props.kompakt ? styles.kompakt : styles.box}>
        <Text style={styles.titel}>⚠️ Dieser Teil konnte nicht dargestellt werden</Text>
        {!this.props.kompakt ? <Text style={styles.detail}>{this.state.fehler}</Text> : null}
        <Pressable onPress={this.erneut} style={styles.knopf} accessibilityRole="button">
          <Text style={styles.knopfText}>Erneut versuchen</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  box: {
    margin: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 10,
  },
  kompakt: {
    marginVertical: 6,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 8,
  },
  titel: { color: colors.text, fontSize: 14, fontWeight: "600" },
  detail: { color: colors.muted, fontSize: 12, fontFamily: "Menlo" },
  knopf: {
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  knopfText: { color: colors.text, fontSize: 13 },
});
