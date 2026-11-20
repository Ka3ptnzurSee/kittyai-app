import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  View,
} from "react-native";
import * as Speech from "expo-speech";
import { useAudioPlayer } from "expo-audio";
import VoiceMode from "./VoiceMode";
import { voiceHooks } from "./voice";
import { File, Paths } from "expo-file-system";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import * as Clipboard from "expo-clipboard";
import { secureGet, secureSet, SecureStoreError } from "./secureStore";
import Constants from "expo-constants";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Ionicons, preloadIcons } from "./icons";
import { preloadFonts } from "./fonts";
import { Utf8Decoder, SseParser, argSummary, breakLongLines, breakUnbreakable, formatTime, uid, cronLabel, presetCron, WEEKDAYS_DE, toolMeta, applyPermission, classifyError, isRetryable, deriveTitle, absoluteImageUri, setImageBaseUrl, tooTall, normalizeBlankRuns, stripDilFences, isBlankAiMessage, trimChatsForStorage, sanitizeLoadedMessages, stripErrorFlags, MAX_BUBBLE_PT, BUBBLE_PREVIEW_PT, type CronPreset, type PermissionRequest } from "./lib";
import { Dil, DilRichText } from "./Dil";
import { aiFontFamily, colors, monoFontFamily, oaicolors, uiFontFamily } from "./theme";
import { haptic, CharacterCounter, Pressable, PullToRefresh, RotatingShimmerText, SearchField, ShimmerText, TabsHeader } from "./components";
import { buildIndex, matchingChatIds } from "./searchIndex";
import { RehaTab } from "./RehaTab";
import { installGlobalErrorHandlers } from "./crashHandler";

type Activity = { id: string; tool: string; status: "running" | "ok" | "error"; args?: unknown; result?: string };
type Msg = { id: string; role: "user" | "assistant"; text: string; activity?: Activity[]; permissions?: PermissionRequest[]; images?: { uri: string }[]; attachments?: { kind: string; name: string; sizeKB?: number }[]; replyTo?: { text: string }; error?: { type: string; retryable: boolean }; dil?: unknown[] };
type ChatSource = "app" | "whatsapp" | "terminal";
type Chat = {
  id: string;
  title: string;
  messages: Msg[];
  createdAt: number;
  updatedAt: number;
  folderId?: string | null;
  model?: string;
  /** Woher der Verlauf kommt: App (Server-Session), WhatsApp (GOWA-Bots), Terminal (pi auf dem Hetzner). */
  source?: ChatSource;
  /** Nur lesbar (Terminal-Verläufe gehören dem pi-Prozess, WhatsApp-Antworten gehen über WhatsApp). */
  readOnly?: boolean;
  /** Liegt (noch) nur auf dem Server, nicht als lokaler Chat auf diesem Gerät. */
  remote?: boolean;
  /** Stabile Server-Identität (Session-Dateiname) — verhindert doppelte Einträge. */
  serverKey?: string;
  /** Vorschau der letzten Nachricht vom Server (remote-Chats haben noch keinen Verlauf geladen). */
  preview?: string;
};
type Folder = { id: string; name: string; description: string; parentId: string | null; order: number };
type Connector = { id: string; name: string; agent: string; description: string; createdAt?: string; enabled?: boolean; command?: string };
type ConnectedPlatform = { id: string; name: string; status: "ok" | "error" | "warning"; detail: string };
type SkillMeta = { id: string; name: string; description: string };
type AgentMeta = { id: string; name: string; description: string };
type WorkflowMeta = { id: string; name: string; cron?: string };

// Eigenständige Komponente: tickt jede Sekunde, OHNE den ganzen App-Baum neu zu rendern.
function ElapsedLabel({ style }: { style?: TextStyle }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  return (
    <Text style={style} numberOfLines={1}>
      denkt nach · {sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`}
    </Text>
  );
}

// Fortschrittsbalken für die Kontext-Kompaktierung (Schätzung: ~120s Server-Timeout).
function CompactionBar() {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  // Schätzung basiert auf echter Messung: Kompaktierung dauert typisch 5–17s (Ausreißer ~37s).
  const EST = 20;
  const pct = Math.min(95, Math.round((sec / EST) * 100));
  const remaining = Math.max(0, EST - sec);
  return (
    <View style={styles.compactionWrap}>
      <View style={styles.compactionTrack}>
        <View style={[styles.compactionFill, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.thinkingText} numberOfLines={1}>
        kompaktiere Kontext · {pct}% · noch ca. {remaining}s
      </Text>
    </View>
  );
}

// Denk-Text als aufklappbarer Block (Volllänge). Standardmäßig eingeklappt,
// damit die lange Reasoning-Ausgabe KEINE weiße Bubble/Layout-Loop erzeugt —
// der volle Text ist per Tap erreichbar.
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  return (
    <View style={styles.thinkingBlock}>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.thinkingHeader} hitSlop={6} accessibilityRole="button" accessibilityLabel={open ? "Denkprozess ausblenden" : "Denkprozess anzeigen"}>
        <Text style={styles.thinkingText} numberOfLines={1}>
          {open ? "Denkprozess ausblenden" : "Denkprozess anzeigen"}
        </Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={14} color={colors.muted} />
      </Pressable>
      {open ? (
        <ScrollView style={styles.thinkingScroll} nestedScrollEnabled>
          <Text style={styles.thinkingDetail}>{breakUnbreakable(trimmed, 120)}</Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

// Fehlerklassifikation & Titelableitung leben jetzt in ./lib (testbar).

type Task = {
  id: string;
  message: string;
  status: "pending" | "running" | "done" | "error";
  result?: string;
  createdAt?: string;
  doneAt?: string;
};
type Schedule = { id: string; message: string; cron: string };

const TOKEN_KEY = "pi-api-token";
const CHATS_KEY = "pi-chats-v2"; // Legacy-Klartext (nur noch für Migration)
const FOLDERS_KEY = "pi-folders-v1"; // Legacy-Klartext (nur noch für Migration)
const CWD_KEY = "pi-cwd";
const STREAM_STATE_KEY = "pi-stream-state-v1";
// Verschlüsselte Ablagen (AES-GCM, Master-Key im Keychain/Keystore via secureStore.ts).
const CHATS_ENC_KEY = "pi-chats-v2.enc";
const FOLDERS_ENC_KEY = "pi-folders-v1.enc";
const STREAM_TIMEOUT_MS = 65 * 60 * 1000; // 65 min – über PROMPT_TIMEOUT_MS (60 min), damit der Server-Timeout (fehlgeschlagener Turn) VOR dem Client-Abbruch als Fehler-Event ankommt
const STREAM_STALL_MS = 45 * 1000; // Kein-Datenfluss-Watchdog: Server pingt alle 15 s → 45 s Stille = Verbindung still gestorben (iOS/Netz tötet Socket ohne EOF). Reconnect/Resume statt ewig hängen.
const MAX_REPLY_CHARS = 500000; // OOM-Schutz, hoch genug für echte Antworten (vorher 20 000 → lange Antworten wurden mitten im Wort abgeschnitten)
const MAX_BUFFER_CHARS = 8 * 1024 * 1024; // SSE-Puffer (ein `done`-Event kann ~135 KB+ tragen)
const MAX_THINKING_CHARS = 16000; // Denk-Text deckeln (vorher 800 → schnitt Reasoning sichtbar ab)
const MAX_TITLE_CHARS = 22;
const MAX_FOLDER_NAME_CHARS = 40;
const MAX_FOLDER_DESC_CHARS = 200;

// Stream still beendet (EOF ohne terminales done/error, z. B. iOS tötet die
// SSE-Verbindung im Hintergrund): eigener Fehlertyp, damit send() gezielt mit
// Resume an der Abbruchstelle fortsetzt statt eine „Netzwerk unterbrochen"-Karte
// zu zeigen. lastSeq = zuletzt gesehene Sequenznummer (für den Resume-Anker).
class StreamInterrupted extends Error {
  readonly lastSeq?: number;
  constructor(lastSeq?: number) {
    super("Stream vorzeitig beendet (network)");
    this.name = "StreamInterrupted";
    this.lastSeq = lastSeq;
  }
}

/**
 * Die App wurde vom Betriebssystem suspendiert (Hintergrund) und hat die Verbindung
 * deshalb SELBST getrennt. Das ist KEIN Netzwerkfehler — der Server-Turn läuft
 * unabhängig weiter (turnRegistry) und wird beim Zurückkehren per REST nachgeladen.
 * ChatGPT und Claude behandeln diesen Fall genauso: stiller Sync statt Fehlerkarte.
 */
class BackgroundDetached extends Error {
  constructor() {
    super("App im Hintergrund — Verbindung bewusst getrennt");
    this.name = "BackgroundDetached";
  }
}

// Auswählbare Chat-Modelle (Key = Server-Slug, Label = kurze Anzeige).
// Reihenfolge = Zyklus beim Tippen auf den Chip.
const CHAT_MODEL_OPTIONS: { key: string; label: string; deactivated?: boolean }[] = [
  { key: "pro", label: "PRO" },
  { key: "flash", label: "FLASH" },
  // --goeran-options:start--
  { key: "muse", label: "MUSE" },
  // --goeran-options:end--
  // Robotron-Modelle auch offline/ohne /api/models anbieten (Laptop-Tunnel :18444).
  // deactivated: hängen am Laptop-Tunnel → im UI als INAKTIV markiert, nicht wählbar.
  { key: "robotron", label: "ROBOTRON", deactivated: true },
  { key: "robotron2", label: "ROBOTRON2", deactivated: true },
];

// Plugins-Untertabs (Connectors/Skills/Agenten/Workflows/Tasks).
const PLUGIN_TABS: { key: "connectors" | "skills" | "agents" | "workflows" | "tasks"; label: string }[] = [
  { key: "connectors", label: "Connectoren" },
  { key: "skills", label: "Skills" },
  { key: "agents", label: "Agenten" },
  { key: "workflows", label: "Workflows" },
  { key: "tasks", label: "Tasks" },
];

// Routinen-Presets (Claude-iOS-„Routines“-Pendant) → 5-Feld-Cron
const SCHEDULE_PRESETS: { id: CronPreset | "custom"; label: string }[] = [
  { id: "hourly", label: "Stündlich" },
  { id: "daily", label: "Täglich" },
  { id: "weekdays", label: "Wochentags" },
  { id: "weekend", label: "Wochenende" },
  { id: "weekly", label: "Wöchentlich" },
  { id: "monthly", label: "Monatlich" },
  { id: "custom", label: "Eigene Cron" },
];



function detectBase(): string {
  try {
    const hostUri = Constants.expoConfig?.hostUri;
    if (hostUri) {
      const raw = String(hostUri).replace(/^https?:\/\//, "");
      const isTunnel = /exp\.direct|exp\.host|u\.expo\.dev|ngrok/i.test(raw);
      if (isTunnel) {
        return `https://${raw.replace(/:\d+$/, "")}`;
      }
      return `http://${raw}`;
    }
  } catch {
    // ignorieren
  }
  return "https://hashtagweinboehla.de/kittyai";
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Claude-Stil „Tool-Berechtigungskarte“: zeigt pro Werkzeug Icon + deutschen
// Namen + Status und klappt das Ergebnis bei Tipp auf.
function ToolCard({ a }: { a: Activity }) {
  const [expanded, setExpanded] = useState(false);
  const meta = toolMeta(a.tool);
  const statusColor = a.status === "running" ? colors.accent : a.status === "ok" ? colors.success : colors.danger;
  const args = argSummary(a.args);
  return (
    <View style={[styles.toolCard, a.status === "error" && styles.toolCardErr]}>
      <View style={styles.toolCardHeader}>
        <Text style={styles.toolCardIcon}>{meta.icon}</Text>
        <Text style={styles.toolCardLabel} numberOfLines={1}>
          {breakUnbreakable(meta.label)}
        </Text>
        <View style={[styles.toolDot, { backgroundColor: statusColor }]} />
      </View>
      {args ? (
        <Text style={styles.toolCardArgs} numberOfLines={1}>
          {breakLongLines(args)}
        </Text>
      ) : null}
      {a.result ? (
        <Text
          style={styles.activityResult}
          numberOfLines={expanded ? undefined : 2}
          onPress={() => setExpanded((v) => !v)}
        >
          {breakLongLines(a.result)}
        </Text>
      ) : null}
    </View>
  );
}

// Werkzeug-Aktivität standardmäßig EINGEKLAPPT (nur „X Werkzeuge“-Zeile).
// Verhindert große weiße Blöcke, wenn die Antwort nur aus Tool-Aufrufen besteht.
function ActivityList({ activity }: { activity: Activity[] }) {
  const [open, setOpen] = useState(false);
  const hasError = activity.some((a) => a.status === "error");
  return (
    <View style={styles.activityWrap}>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.activityToggle} accessibilityRole="button" accessibilityLabel={open ? "Werkzeug-Aktivität ausblenden" : "Werkzeug-Aktivität anzeigen"}>
        <Text style={[styles.activitySummary, hasError && { color: colors.danger }]}>
          {hasError ? "⚠ " : ""}{open ? "▴" : "▾"} {activity.length} Werkzeug{activity.length === 1 ? "" : "e"} {open ? "" : "· versteckt"}
        </Text>
      </Pressable>
      {open ? activity.map((a) => <ToolCard key={a.id} a={a} />) : null}
    </View>
  );
}

// Freigabe-Karte: erscheint unter einer laufenden Assistant-Message, wenn ein
// Tool-Aufruf auf die Zustimmung des Nutzers wartet (Claude-iOS-Gefühl).
function PermissionCard({ p, onDecision }: { p: PermissionRequest; onDecision?: (p: PermissionRequest, decision: "allow" | "deny") => void }) {
  const [busy, setBusy] = useState(false);
  const pending = p.status === "pending";
  const statusLabel = p.status === "allowed" ? "erlaubt" : p.status === "denied" ? "verweigert" : "warte auf Freigabe …";
  const decide = async (decision: "allow" | "deny") => {
    if (!onDecision || busy) return;
    haptic(decision === "allow" ? "success" : "warning");
    setBusy(true);
    try {
      await onDecision(p, decision);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.permissionCard}>
      <View style={styles.permissionHeader}>
        <Ionicons name="key-outline" size={16} color={colors.accent} />
        <Text style={styles.permissionTitle} numberOfLines={2}>
          {breakUnbreakable(p.title || `Claude möchte ${p.tool} ausführen`)}
        </Text>
      </View>
      {p.description ? (
        <Text style={styles.permissionDesc} numberOfLines={3}>
          {breakLongLines(p.description)}
        </Text>
      ) : null}
      {pending ? (
        <View style={styles.permissionActions}>
          <Pressable onPress={() => decide("allow")} disabled={busy} accessibilityLabel="Werkzeug erlauben" style={[styles.permissionBtn, styles.permissionAllow, busy && styles.permissionBtnDisabled]}>
            <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
            <Text style={styles.permissionBtnText}>Erlauben</Text>
          </Pressable>
          <Pressable onPress={() => decide("deny")} disabled={busy} accessibilityLabel="Werkzeug verweigern" style={[styles.permissionBtn, styles.permissionDeny, busy && styles.permissionBtnDisabled]}>
            <Ionicons name="close-circle-outline" size={16} color="#fff" />
            <Text style={styles.permissionBtnText}>Verweigern</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.permissionStatus}>{statusLabel}</Text>
      )}
    </View>
  );
}

// Blinkender Cursor am Ende einer laufenden Antwort — zeigt live, dass noch gestreamt wird
// (verhindert das Gefühl eines „weißen Blocks“, während pi denkt/arbeitet).
function StreamingCursor() {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 450, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.15, duration: 450, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.Text style={{ opacity, color: colors.accent, fontSize: 17, lineHeight: 22, fontWeight: "600" }}>
      ▍
    </Animated.Text>
  );
}

// ```dil```-Fences () werden in ./lib entfernt (stripDilFences) — dort testbar.

// Bild in einer Nachricht: lädt es nicht (toter /generated-Link, gelöschte Datei),
// bleibt KEIN 260pt hoher leerer Kasten stehen (das war ein „weißer Block"),
// sondern nur eine schmale Hinweiszeile.
function MessageImage({ uri }: { uri: string }) {
  const [failed, setFailed] = useState(false);
  if (!uri || failed) {
    return (
      <View style={styles.imgFailedRow}>
        <Ionicons name="image-outline" size={14} color={colors.muted} />
        <Text style={styles.imgFailedText}>Bild nicht verfügbar</Text>
      </View>
    );
  }
  return <Image source={{ uri }} style={styles.msgImage} resizeMode="cover" onError={() => setFailed(true)} />;
}

function MessageBubble({
  item,
  isLast,
  isBusy,
  onReply,
  onRetry,
  onPermission,
  onDilAction,
  onTooBig,
}: {
  item: Msg;
  isLast: boolean;
  isBusy: boolean;
  onReply: (m: Msg) => void;
  onRetry?: (m: Msg) => void;
  onPermission?: (p: PermissionRequest, decision: "allow" | "deny") => void;
  /** Follow-up aus einem DIL-Widget (invokeDILCallbackWithResult) → als neuer Turn senden. */
  onDilAction?: (text: string) => void;
  /** Blase hat die Höhengrenze überschritten → an den Server melden (Selbst-Diagnose). */
  onTooBig?: (m: Msg, height: number) => void;
}) {
  const isUser = item.role === "user";
  // Höhen-Wächter: überschreitet die Blase die Höhengrenze, wird sie EINMAL
  // eingeklappt (aufklappbar) und einmalig an den Server gemeldet — damit ein
  // aufblähender Block NIE mehr den ganzen Verlauf unlesbar macht.
  const rawHRef = useRef(0);
  const [bigH, setBigH] = useState(0); // 0 = normal; > 0 = gemessene Riesenhöhe
  const [forceOpen, setForceOpen] = useState(false);
  const tooBig = bigH > 0 && !forceOpen;
  const activity = !isUser ? item.activity || [] : [];
  // Kopieren/Teilen: iOS-Textauswahl ist bei uns nur absatzweise möglich, weil
  // Markdown jeden Absatz als eigenes <Text selectable> rendert — eine ganze
  // Antwort lässt sich damit nicht am Stück markieren. Deshalb gibt es pro
  // Nachricht eine feste Aktionszeile (Kopieren/Antworten/Teilen).
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  const plainText = (item.text || "").trim();
  const canCopy = plainText.length > 0 && !isBusy;
  function copyMessage() {
    Clipboard.setStringAsync(item.text || "").catch(() => {});
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  }
  function shareMessage() {
    Share.share({ message: item.text || "" }).catch(() => {});
  }
  const bubbleStyle = isUser
    ? styles.userBubble
    : isLast && isBusy && !item.text
      ? styles.aiBubbleRunning
      : isLast && !isBusy && !!item.text
        ? styles.aiBubbleDone
        : styles.aiBubble;

  // Swipe nach rechts → antworten. Nur klare horizontale Wischbewegungen
  // kapern, damit vertikales Scrollen und die native Textauswahl (selectable)
  // weiter normal funktionieren.
  const itemRef = useRef(item);
  itemRef.current = item; // patchMsg ersetzt das Objekt beim Streamen → aktuelles item nachführen
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) =>
        Math.abs(gesture.dx) > 24 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
      onPanResponderRelease: (_evt, gesture) => {
        if (gesture.dx > 48 && Math.abs(gesture.dx) > Math.abs(gesture.dy)) {
          onReply(itemRef.current);
        }
      },
    }),
  ).current;

  return (
    <>
    <View
      style={[styles.bubble, bubbleStyle, tooBig && { height: BUBBLE_PREVIEW_PT, overflow: "hidden" }]}
      {...panResponder.panHandlers}
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        // Nur nach oben nachführen und nur EINMAL State setzen (sonst Layout-Loop
        // bzw. Re-Render bei jedem Streaming-Delta).
        if (!Number.isFinite(h) || h <= rawHRef.current) return;
        rawHRef.current = h;
        if (bigH === 0 && tooTall(h)) {
          setBigH(h);
          onTooBig?.(itemRef.current, h);
        }
      }}
    >
      {item.replyTo ? (
        <View style={styles.replyQuote}>
          <Text style={styles.replyQuoteText} numberOfLines={2}>{breakUnbreakable(item.replyTo.text)}</Text>
        </View>
      ) : null}
      {isUser ? (
        <Text selectable style={styles.userText}>
          {breakUnbreakable(item.text)}
        </Text>
      ) : (
        <>
          {Array.isArray(item.dil) && item.dil.length > 0 ? (
            <View style={{ gap: 8 }}>
              <DilRichText text={stripDilFences(item.text || "")} onAction={(t) => onDilAction?.(t)} />
              {item.dil.map((block, i) => (
                <Dil key={i} json={block} onAction={(t) => onDilAction?.(t)} />
              ))}
            </View>
          ) : (
            <DilRichText text={normalizeBlankRuns(item.text || "")} onAction={(t) => onDilAction?.(t)} />
          )}
          {isLast && isBusy && item.text ? <StreamingCursor /> : null}
          {item.error ? (
            <View style={styles.errorCard}>
              <View style={styles.errorCardTitleRow}>
                <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
                <Text style={styles.errorCardText}>{item.error.type}</Text>
              </View>
              {item.error.retryable && onRetry ? (
                <Pressable onPress={() => onRetry(item)} style={styles.errorRetryBtn} accessibilityLabel="Antwort erneut versuchen">
                  <View style={styles.errorRetryRow}>
                    <Ionicons name="refresh" size={13} color="#ffffff" />
                    <Text style={styles.errorRetryText}>Erneut versuchen</Text>
                  </View>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </>
      )}
      {item.attachments && item.attachments.length > 0 ? (
        <View style={styles.attRow}>
          {item.attachments.map((at, i) => (
            <View key={i} style={styles.attChip}>
              <Ionicons
                name={at.kind === "audio" ? "mic-outline" : at.kind === "image" ? "image-outline" : "document-text-outline"}
                size={12}
                color={colors.muted}
              />
              <Text numberOfLines={1} style={styles.attChipText}>
                {at.name}
                {at.sizeKB ? " · " + (at.sizeKB >= 1024 ? Math.round(at.sizeKB / 1024) + " MB" : at.sizeKB + " KB") : ""}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {item.images && item.images.length > 0 ? (
        item.images.map((img, i) => <MessageImage key={i} uri={img.uri} />)
      ) : null}
      {activity.length > 0 ? (
        <ActivityList activity={activity} />
      ) : null}
      {item.permissions && item.permissions.length > 0 ? (
        <View style={styles.permissionWrap}>
          {item.permissions.map((p) => (
            <PermissionCard key={p.permissionId} p={p} onDecision={onPermission} />
          ))}
        </View>
      ) : null}
    </View>
    {canCopy ? (
      <View style={[styles.msgActions, isUser && styles.msgActionsUser]}>
        <Pressable onPress={copyMessage} hitSlop={10} accessibilityLabel="Nachricht kopieren" style={styles.msgActionBtn}>
          <Ionicons name={copied ? "checkmark" : "copy-outline"} size={13} color={copied ? colors.success : colors.muted} />
          <Text style={[styles.msgActionText, copied && { color: colors.success }]}>{copied ? "Kopiert" : "Kopieren"}</Text>
        </Pressable>
        <Pressable onPress={() => onReply(item)} hitSlop={10} accessibilityLabel="Auf Nachricht antworten" style={styles.msgActionBtn}>
          <Ionicons name="arrow-undo-outline" size={13} color={colors.muted} />
          <Text style={styles.msgActionText}>Antworten</Text>
        </Pressable>
        <Pressable onPress={shareMessage} hitSlop={10} accessibilityLabel="Nachricht teilen" style={styles.msgActionBtn}>
          <Ionicons name="share-outline" size={13} color={colors.muted} />
          <Text style={styles.msgActionText}>Teilen</Text>
        </Pressable>
      </View>
    ) : null}
    {tooBig ? (
      <Pressable onPress={() => setForceOpen(true)} style={styles.tooBigRow} hitSlop={8} accessibilityRole="button" accessibilityLabel="Volle Antwort anzeigen">
        <Ionicons name="chevron-down" size={14} color={colors.accent} />
        <Text style={styles.tooBigText}>
          Nachricht ist ungewöhnlich groß ({Math.round(bigH)} pt) und wurde eingeklappt — antippen zum Aufklappen
        </Text>
      </Pressable>
    ) : null}
    </>
  );
}

// Bild-Liste vom Server normalisieren (absolute URIs, Fremdschemata raus).
function resolveImageList(list: unknown, base: string): { uri: string }[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out = list
    .map((im) => absoluteImageUri(String((im as { uri?: string } | null)?.uri || ""), base))
    .filter((u): u is string => !!u)
    .map((u) => ({ uri: u }));
  return out.length ? out : undefined;
}

// Leere KI-Nachricht (kein sichtbarer Text, keine Widgets, keine Bilder, kein
// Fehler) = „weißer Balken". Implementierung liegt in ./lib (isBlankAiMessage /
// stripDilFences) — dort ohne Expo testbar.
function isEmptyAi(m: Msg): boolean {
  return isBlankAiMessage(m);
}

// secureGet mit begrenztem Retry: transiente Keychain-/Storage-Fehler (z. B. Keychain
// beim Start kurz gesperrt) sollen nicht sofort zu einem permanenten Schreib-Block führen.
async function secureGetWithRetry(key: string): Promise<string | null> {
  let lastErr: unknown = null;
  for (let i = 0; i < 3; i++) {
    try {
      return await secureGet(key);
    } catch (e) {
      // Permanenter Fehler (Chiffretext/Key korrupt) → kein Retry-Nutzen, sofort werfen.
      if (e instanceof SecureStoreError) throw e;
      lastErr = e;
      if (i < 2) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

export default function App() {
  const [tab, setTab] = useState<"chats" | "plugins" | "tasks" | "reha">("chats");
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busyChatIds, setBusyChatIds] = useState<Set<string>>(() => new Set());
  const [refreshingChat, setRefreshingChat] = useState(false); // Pull-to-Refresh läuft
  const [thinkingByChat, setThinkingByChat] = useState<Record<string, string>>({});
  const [statusByChat, setStatusByChat] = useState<Record<string, string>>({}); // z. B. "kompaktiere …", "Retry 2/3"
  const [listening, setListening] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  // iOS kann keinen nativen Picker (PHPicker/Kamera/DocumentPicker/Alert.prompt) auf einen
  // noch sichtbaren RN-<Modal> legen: UIKit präsentiert dann gar nichts — kein Fehler,
  // Promise kommt einfach als `canceled` zurück. Genau das war das Symptom „es öffnet
  // sich nichts" bei Bilder/Kamera/Datei. Deshalb: Sheet schließen, Aktion im
  // onDismiss des Modals ausführen (mit Fallback-Timer, falls onDismiss nicht feuert).
  const pendingAttachActionRef = useRef<null | (() => void)>(null);
  const presentAfterSheet = (action: () => void) => {
    pendingAttachActionRef.current = action;
    setAttachOpen(false);
    setTimeout(() => {
      const fn = pendingAttachActionRef.current;
      if (fn === action) {
        pendingAttachActionRef.current = null;
        fn();
      }
    }, 500);
  };
  const runPendingAttachAction = () => {
    const fn = pendingAttachActionRef.current;
    if (!fn) return;
    pendingAttachActionRef.current = null;
    // Kurz warten, bis der Modal-Controller wirklich weg ist (Dismiss-Animation).
    setTimeout(fn, 60);
  };
  const micPulse = useRef(new Animated.Value(1)).current;
  const sendScale = useRef(new Animated.Value(1)).current;
  const [replyingTo, setReplyingTo] = useState<Msg | null>(null);
  const [pendingImages, setPendingImages] = useState<{ data: string; mediaType: string; uri: string }[]>([]);
  const [pendingFiles, setPendingFiles] = useState<{ name: string; content: string }[]>([]);
  const [pendingDocuments, setPendingDocuments] = useState<{ name: string; data: string; mimeType: string }[]>([]);
  const [speak, setSpeak] = useState(false); // Standard: Textantwort; Sprachausgabe nur auf Wunsch
  // Sprache-zu-Sprache-Modus: Vollbild, hoert zu, schickt ab, liest satzweise vor
  const [voiceOpen, setVoiceOpen] = useState(false);
  const voiceOpenRef = useRef(false);
  useEffect(() => { voiceOpenRef.current = voiceOpen; }, [voiceOpen]);
  const [chatModel, setChatModel] = useState<string>("flash"); // Default-Modell für neue Chats (flash = schnell, liefert direkt Text; pro = Reasoning, langsam + bei knappem Token-Budget leerer content)
  const [serverUrl, setServerUrl] = useState<string>(() => detectBase());
  // Server-Basis für relative Bild-URLs (/generated/…) global bekannt machen —
  // der Markdown-Renderer löst damit `![](/generated/…)` zu einer ladbaren URL auf.
  useEffect(() => {
    setImageBaseUrl(serverUrl);
    // Crash-Telemetrie kennt die aktuelle Server-Basis (installiert sich nur einmal).
    installGlobalErrorHandlers(() => serverUrl);
  }, [serverUrl]);
  const [apiToken, setApiToken] = useState("");
  const [cwd, setCwd] = useState("");
  const [taskList, setTaskList] = useState<Task[]>([]);
  const [taskInput, setTaskInput] = useState("");
  const [scheduleList, setScheduleList] = useState<Schedule[]>([]);
  const [schedInput, setSchedInput] = useState("");
  const [schedPreset, setSchedPreset] = useState<CronPreset | "custom">("daily");
  const [schedTime, setSchedTime] = useState("09:00");
  const [schedDay, setSchedDay] = useState(1); // 0=So … 6=Sa
  const [schedDom, setSchedDom] = useState("1");
  const [schedCustomCron, setSchedCustomCron] = useState("");
  // Ordner/Projekte
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [folderModal, setFolderModal] = useState<{ mode: "create" | "rename" | "edit"; folderId?: string; parentId?: string | null } | null>(null);
  const [folderInput, setFolderInput] = useState("");
  const [folderDescInput, setFolderDescInput] = useState("");
  const [assignChatId, setAssignChatId] = useState<string | null>(null);
  const [folderSuggestion, setFolderSuggestion] = useState<{ chatId: string; folderId: string; name: string } | null>(null);
  // Modell-Menü
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [dynamicModels, setDynamicModels] = useState<{ key: string; label: string; deactivated?: boolean }[]>([]);
  // Chat umbenennen
  const [renameChatId, setRenameChatId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  // Plugins
  const [pluginsTab, setPluginsTab] = useState<"connectors" | "skills" | "agents" | "workflows" | "tasks">("connectors");
  const [meta, setMeta] = useState<{ connectors: Connector[]; skills: SkillMeta[]; agents: AgentMeta[]; workflows: WorkflowMeta[]; platforms: ConnectedPlatform[] }>({ connectors: [], skills: [], agents: [], workflows: [], platforms: [] });
  const [connectorsList, setConnectorsList] = useState<Connector[]>([]);
  const [connectorForm, setConnectorForm] = useState<{ name: string; agent: string; description: string }>({ name: "", agent: "", description: "" });
  const loadedRef = useRef(false);
  const chatsRef = useRef<Chat[]>([]);
  // Server-Verläufe, die es auf DIESEM Gerät noch nicht gibt (anderes iPhone/iPad,
  // WhatsApp-Bot, Terminal-Sessions). Werden nicht verschlüsselt gespeichert, sondern
  // bei jedem Sync frisch vom Server geholt — die Wahrheit liegt auf dem Server.
  const [remoteChats, setRemoteChats] = useState<Chat[]>([]);
  // "server" = Verläufe, die nur auf dem Server liegen (anderes Gerät/andere App-Instanz),
  // "app" = nur die Chats DIESES Geräts. Ohne die Trennung ertrinkt die Liste in
  // hunderten Server-Sessions, die man hier nie angelegt hat.
  type ChatFilter = "all" | "app" | "server" | "whatsapp" | "terminal";
  const [chatFilter, setChatFilter] = useState<ChatFilter>("app");
  // Titel-/Vorschau-Filter ueber der Chat-Liste (Volltext kommt in Welle 2).
  const [chatSearch, setChatSearch] = useState("");
  // Storage-Keys, deren verschlüsselter Bestand vorhanden, aber nicht lesbar ist
  // (Key weg/korrupt bzw. Lesefehler) → NICHT mit leerem Stand überschreiben (kein stiller Datenverlust).
  const storageBlockedRef = useRef<Set<string>>(new Set());
  const writeWarnedRef = useRef<Set<string>>(new Set());
  // Einmaliger Hinweis pro Storage-Key, wenn lokales Speichern fehlschlägt (Quota voll/
  // Storage-Fehler), statt still zu verlieren — Chats bleiben serverseitig erhalten.
  function warnWriteFailure(key: string) {
    if (writeWarnedRef.current.has(key)) return;
    writeWarnedRef.current.add(key);
    Alert.alert(
      "Speichern fehlgeschlagen",
      "Änderungen können lokal nicht gespeichert werden. " +
      "Deine Chats bleiben serverseitig erhalten; Ordner werden nur lokal gespeichert.",
    );
  }
  const dictationBaseRef = useRef("");
  const finalSegmentsRef = useRef(""); // vollständig erkannter Text (Final-Segmente werden angehängt; iOS prependet ab dem 2. Segment ein Leerzeichen)
  const inputRef = useRef("");
  useEffect(() => {
    inputRef.current = input;
  }, [input]);
  const player = useAudioPlayer();
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const abortedRef = useRef<Set<string>>(new Set());
  const streamStateRef = useRef<Record<string, { turnId: string; lastSeq: number; clientMessageId?: string }>>({});
  const tasksAbortRef = useRef<AbortController | null>(null);
  const listRef = useRef<FlatList<Msg>>(null);
  // true, solange ein programmatischer scrollToEnd (animated) läuft: onScroll darf
  // währenddessen nearBottom nicht auf false setzen (Animations-Zwischenwerte).
  const isAutoScrollingRef = useRef(false);
  const contentSizeDebounceRef = useRef<Map<string, number | null>>(new Map());
  // pro Chat: ob der Nutzer am Listenende ist (für Auto-Scroll). Map statt eines
  // einzelnen Booleans, damit beim Chat-Wechsel nicht der false-Wert des vorherigen
  // Chats in den neuen Chat übernommen wird.
  const nearBottomRef = useRef<Map<string, boolean>>(new Map());
  const isNearBottom = (chatId: string) => nearBottomRef.current.get(chatId) ?? true;
  const setNearBottom = (chatId: string, v: boolean) => nearBottomRef.current.set(chatId, v);

  // App-Vordergrund/-Hintergrund: iOS beendet die Socket-Verbindung, sobald die App
  // in den Hintergrund geht. Retries deshalb erst im Vordergrund starten (siehe send()).
  // --- Client-Fehler-Telemetrie ------------------------------------------------
  // Meldet Fehlerkarten an den Server, damit sichtbar wird, wie oft sie beim Nutzer
  // wirklich erscheinen (nginx sieht nur 499/502, nicht den Grund). Es gehen NUR
  // Kategorie/Phase/App-Version/Zeit raus — kein Nachrichtentext, keine Inhalte.
  const APP_VERSION = `${Constants.expoConfig?.version || "?"}+${Constants.expoConfig?.ios?.buildNumber || "?"}`;
  const reportedRef = useRef<Set<string>>(new Set());
  function reportClientError(kind: string, source: string, detail?: string, chatId?: string) {
    try {
      // Dedup pro App-Lauf: dieselbe Karte nicht mehrfach zählen.
      const key = `${source}|${kind}|${chatId || ""}`;
      if (reportedRef.current.has(key)) return;
      reportedRef.current.add(key);
      if (reportedRef.current.size > 200) reportedRef.current.clear();
      const base = serverUrl.replace(/\/+$/, "");
      if (!base) return;
      fetch(`${base}/api/client-error`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ kind, source, phase: "chat", chatId: chatId || "", appVersion: APP_VERSION, detail: (detail || "").slice(0, 160) }),
      }).catch(() => { /* Telemetrie darf nie stören */ });
    } catch { /* ignorieren */ }
  }

  // Ordnet einen Fehlertext einer festen Telemetrie-Kategorie zu.
  function errorKindOf(raw: string): string {
    const s = String(raw || "").toLowerCase();
    if (/nicht gesendet/.test(s)) return "not_sent";
    if (/netzwerk|network|connection|verbindung|econnreset|socket/.test(s)) return "network";
    if (/timeout|zeitüberschreitung|zu lange/.test(s)) return "timeout";
    if (/limit|429/.test(s)) return "rate_limit";
    if (/guthaben|quota|credits/.test(s)) return "quota";
    if (/zugriff|auth|401|403/.test(s)) return "auth";
    if (/kontext zu lang|context/.test(s)) return "context_too_long";
    if (/kompaktier/.test(s)) return "compaction_busy";
    if (/keine antwort/.test(s)) return "progress_timeout";
    if (/zurückgesetzt/.test(s)) return "session_reset";
    if (/server nicht bereit/.test(s)) return "engine_down";
    if (/ausgelastet/.test(s)) return "capacity";
    if (/bild-generierung/.test(s)) return "image_failed";
    if (/abgebrochen/.test(s)) return "aborted";
    return "other";
  }

  // Setzt eine Fehlerkarte UND meldet sie (einheitlicher Pfad für alle Stellen).
  function setErrorCard(chatId: string, msgId: string, type: string, retryable: boolean, source: string, detail?: string) {
    haptic("error"); // spürbar wie ChatGPT/Claude: Fehler meldet sich an, nicht nur visuell
    patchMsg(chatId, msgId, (m) => ({ ...m, error: { type, retryable } }));
    reportClientError(errorKindOf(type), source, detail || type, chatId);
  }

  const appStateRef = useRef(AppState.currentState);
  // true, wenn die App seit dem letzten Turn-Start im Hintergrund war. Damit kann der
  // Client "ich wurde selbst suspendiert" von "das Netz ist weg" unterscheiden — und
  // zeigt dann KEINE Fehlerkarte (so machen es ChatGPT und Claude auch).
  const wentBackgroundRef = useRef(false);
  const [foregroundTick, setForegroundTick] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      const prev = appStateRef.current;
      appStateRef.current = s;
      if (s === "background" || s === "inactive") {
        if (prev === "active") wentBackgroundRef.current = true;
        // Nur bei echtem Hintergrund selbst trennen. `inactive` feuert auch bei
        // kurzem Kontrollzentrum/Anruf — dort wäre ein Abbruch unnötig aggressiv.
        if (s !== "background") return;
        // Bewusst trennen statt auf iOS zu warten: iOS suspendiert die JS-Ausführung
        // und tötet den Socket still. Ein offener Fetch würde beim Zurückkehren als
        // "Netzwerkfehler" auftauchen, obwohl der Server-Turn unabhängig weiterläuft.
        // Also selbst abbrechen — das ist KEIN Fehler (siehe BackgroundDetached).
        for (const ctrl of abortControllersRef.current.values()) {
          try { ctrl.abort(); } catch { /* ignorieren */ }
        }
        return;
      }
      if (s === "active") {
        // Rückkehr in den Vordergrund: alle busy Chats vom Server neu laden.
        setForegroundTick((t) => t + 1);
      }
    });
    return () => sub.remove();
  }, []);

  // Wartet, bis die App wieder aktiv (Vordergrund) ist. Löst sofort auf, wenn bereits aktiv.
  const waitForForeground = () =>
    new Promise<void>((resolve) => {
      if (appStateRef.current === "active") return resolve();
      const sub = AppState.addEventListener("change", (s) => {
        if (s === "active") {
          sub.remove();
          resolve();
        }
      });
    });

  // Mikro-Puls während Diktieren: sanfter Loop, der das „höre zu“-Gefühl sichtbar macht.
  useEffect(() => {
    if (!listening) {
      micPulse.stopAnimation();
      micPulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(micPulse, { toValue: 1.15, duration: 480, useNativeDriver: true }),
        Animated.timing(micPulse, { toValue: 1, duration: 480, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [listening, micPulse]);

  const activeChat = chats.find((c) => c.id === activeChatId) || null;

  // Beim Öffnen eines Chats immer ganz nach unten springen (Fokus letzte Nachricht),
  // statt erste Nachricht oder Mitte. Kleiner Timeout, damit die FlatList erst gemountet ist.
  useEffect(() => {
    // Ausstehende contentSize-Debounce-Timeouts verwerfen, wenn der aktive Chat wechselt:
    // sonst scrollt der verzögerte Callback des vorherigen Chats die neu geöffnete Liste ans Ende.
    for (const [id, t] of contentSizeDebounceRef.current) {
      if (t) clearTimeout(t);
      contentSizeDebounceRef.current.set(id, null);
    }
    if (!activeChatId) return;
    // Leere KI-Bubbles („weiße Balken“) beim Öffnen entfernen — auch aus bestehenden Chats.
    // ABER nie, während der Chat streamt: die Live-Bubble ist anfangs leer und würde sonst
    // entfernt, bevor das erste Text-Delta eintrifft (Antwort ginge verloren).
    if (!busyChatIds.has(activeChatId)) {
      patchChat(activeChatId, (c) => {
        const next = c.messages.filter((m) => !isEmptyAi(m));
        return next.length === c.messages.length ? c : { ...c, messages: next };
      });
    }
    setNearBottom(activeChatId, true); // neuer Chat = am Ende starten (sonst veralteter false-Wert aus vorherigem Chat)
    // Während der programmatischen Initial-Scrolls onScroll unterdrücken (isAutoScrollingRef),
    // sonst setzt der Zwischenwert nearBottom wieder auf false und Auto-Scroll klemmt.
    isAutoScrollingRef.current = true;
    const t1 = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: false });
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
    }, 80);
    const t2 = setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 300);
    const t3 = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: false });
      setNearBottom(activeChatId, true);
      isAutoScrollingRef.current = false;
    }, 800);
    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      isAutoScrollingRef.current = false;
    };
  }, [activeChatId]);

  // pro Chat einstellbares Modell (Default: "flash"). Deaktivierte Modelle
  // (Robotron via Laptop-Tunnel :18444) dürfen nie als aktiv gelten — sonst
  // zeigt der Chip ein Modell an, das der Server still auf flash umbiegt.
  const requestedModel = activeChat?.model || chatModel;
  const activeModel = isModelDeactivated(requestedModel) ? fallbackModelKey() : requestedModel;
  const isThisChatBusy = activeChatId ? busyChatIds.has(activeChatId) : false;
  const thisThinking = activeChatId ? thinkingByChat[activeChatId] || "" : "";
  const thisStatus = activeChatId ? statusByChat[activeChatId] || "" : "";

  function markBusy(chatId: string, busy: boolean) {
    if (busy) setNearBottom(chatId, true); // beim Senden ans Listenende hängen (Auto-Scroll)
    setBusyChatIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(chatId);
      else next.delete(chatId);
      return next;
    });
  }
  function setChatThinking(chatId: string, value: string) {
    setThinkingByChat((prev) => ({ ...prev, [chatId]: value }));
  }
  function persistStreamState(chatId: string) {
    const st = streamStateRef.current[chatId];
    AsyncStorage.getItem(STREAM_STATE_KEY)
      .then((raw) => {
        let map: Record<string, { turnId: string; lastSeq: number; clientMessageId?: string }> = {};
        try { if (raw) map = JSON.parse(raw) || {}; } catch { map = {}; }
        if (st) {
          map[chatId] = st;
        } else {
          delete map[chatId];
        }
        return AsyncStorage.setItem(STREAM_STATE_KEY, JSON.stringify(map));
      })
      .catch(() => { /* ignorieren */ });
  }

  // Stabil halten: Verbraucher (z. B. RehaTab) nutzen die Funktion in
  // useEffect-Deps. Eine bei jedem Render neu erzeugte Funktion trieb dort
  // eine Endlosschleife (183 Requests/Minute -> Rate-Limit -> Chat-Abbruch).
  const authHeaders = useCallback((): Record<string, string> => {
    // Token nur über HTTPS senden – kein Klartext-Token im LAN-/Dev-Modus
    const secure = serverUrl.startsWith("https://");
    return { "Content-Type": "application/json", ...(apiToken && secure ? { "X-API-Token": apiToken } : {}) };
  }, [serverUrl, apiToken]);

  function patchChat(chatId: string, fn: (c: Chat) => Chat) {
    setChats((cs) => cs.map((c) => (c.id === chatId ? fn(c) : c)));
  }
  function setActiveModel(key: string) {
    if (isModelDeactivated(key)) return; // deaktivierte Slugs (Robotron) nicht setzen
    if (activeChatId) patchChat(activeChatId, (c) => ({ ...c, model: key }));
    setModelMenuOpen(false);
  }
  function patchMsg(chatId: string, msgId: string, fn: (m: Msg) => Msg) {
    setChats((cs) =>
      cs.map((c) =>
        c.id === chatId ? { ...c, updatedAt: Date.now(), messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)) } : c,
      ),
    );
  }

  // chatsRef aktuell halten (für Helfer, die außerhalb von State-Closures lesen müssen).
  useEffect(() => { chatsRef.current = chats; }, [chats]);

  // Server-Verläufe (andere Geräte / WhatsApp / Terminal) laden: beim Öffnen des
  // Chats-Tabs und dann alle 45 s, solange keine Unterhaltung offen ist.
  useEffect(() => {
    if (tab !== "chats" || !loadedRef.current) return;
    syncServerChats();
    const iv = setInterval(() => {
      if (!activeChatId) syncServerChats();
    }, 45000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, serverUrl, apiToken, activeChatId]);

  // Live-Sync/Reload: finale Antwort aus der Server-Session-Datei holen (überlebt die
  // turnRegistry-TTL) und eine leere/fehlerhafte KI-Bubble damit auffüllen.
  async function reloadFromServer(chatId: string): Promise<boolean> {
    try {
      const base = serverUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/api/session/${encodeURIComponent(chatId)}`, { headers: authHeaders() });
      if (!res.ok) return false;
      const data = await res.json();
      // Turn läuft noch → Session-Datei evtl. gerade lazy geschrieben (noch leer).
      // Nichts anwenden — der User-Count-Guard unten würde sonst fälschlich greifen.
      if (data.activeTurn === true) return false;
      if (!Array.isArray(data.messages)) return false;
      const serverMsgs = data.messages as { id?: string; role: string; text?: string; images?: { uri: string }[] }[];
      // Nur Assistant-Nachrichten MIT Text zählen: Zwischenschritte (nur Tool-Calls)
      // haben leeren Text und würden die echte Antwort verdecken.
      const serverLast = [...serverMsgs].reverse().find((m) => m.role === "assistant" && String(m.text || "").trim());
      // Turn fertig = Antwort steht NACH der letzten User-Nachricht (danach dürfen leere
      // Zwischenschritte folgen, ohne die Antwort zu verdecken).
      const lastUserIdxS = serverMsgs.map((m) => m.role).lastIndexOf("user");
      const serverLastIdxS = serverLast ? serverMsgs.lastIndexOf(serverLast) : -1;
      const serverUserCount = serverMsgs.filter((m) => m.role === "user").length;
      const chat = chatsRef.current.find((c) => c.id === chatId);
      if (!chat) return false;
      const localUserCount = chat.messages.filter((m) => m.role === "user").length;
      // 0) Turn hat den Server nie erreicht → ALLES Server-seitige (Antwort + lastError)
      // ist stale und darf NICHT auf diesen Turn angewandt werden.
      if (serverUserCount < localUserCount) return false;
      // 1) Vorhandene komplette Antwort hat IMMER Vorrang — auch vor lastError (ein
      // fehlgeschlagener Turn kann eine bereits geschriebene Antwort + angehängten Fehler
      // hinterlassen; die Antwort darf nicht von der Fehler-Karte verdeckt werden).
      if (serverLast && serverLastIdxS > lastUserIdxS && serverLast.text?.trim()) {
        const lastAi = [...chat.messages].reverse().find((m) => m.role === "assistant");
        if (!lastAi) return false;
        const answerText = (serverLast.text || "").slice(0, MAX_REPLY_CHARS);
        const localText = lastAi.text?.trim() || "";
        // Nur überschreiben, wenn die Server-Antwort VOLLSTÄNDIGER ist als die lokale
        // (Teiltext aus abgebrochenem Stream). Sonst ist die Bubble schon gefüllt.
        if (localText && !lastAi.error && answerText.trim().length <= localText.length) return false;
        patchMsg(chatId, lastAi.id, (m) => ({ ...m, text: answerText, images: resolveImageList(serverLast.images, serverUrl) || m.images, error: undefined }));
        delete streamStateRef.current[chatId];
        persistStreamState(chatId);
        return true;
      }
      // 2) Erst JETZT lastError: serverseitig fehlgeschlagener Turn (Timeout/Stall/Prozess tot)
      // hinterlässt lastError + letzte message = user. Fehler-Karte statt leerer Bubble setzen.
      const lastErr = data.lastError && typeof data.lastError === "object" && data.lastError.text ? String(data.lastError.text) : "";
      if (lastErr) {
        const errAi = [...chat.messages].reverse().find((m) => m.role === "assistant");
        if (errAi && !errAi.error) {
          setErrorCard(chatId, errAi.id, classifyError(lastErr), isRetryable(lastErr), "reload_server", lastErr);
          delete streamStateRef.current[chatId];
          persistStreamState(chatId);
          return true;
        }
      }
      // 3) Autoritatives Busy-Signal vom Server: kein laufender Turn (turnRegistry
      // leer/gesettled), keine Antwort, kein Fehler → der Turn ist tot (Server-Neustart/
      // Kill). Fehler-Karte statt ewigem Polling. ChatGPT/Claude haben dafür ein
      // explizites Terminal-Signal; hier ist es activeTurn === false.
      if (data.activeTurn === false) {
        const deadAi = [...chat.messages].reverse().find((m) => m.role === "assistant");
        if (deadAi && !deadAi.text?.trim() && !deadAi.error) {
          setErrorCard(chatId, deadAi.id, "Antwort abgebrochen — bitte erneut senden", true, "turn_dead");
          delete streamStateRef.current[chatId];
          persistStreamState(chatId);
          return true;
        }
        return false;
      }
      // 4) Kein Fehler, aber auch noch keine fertige Antwort → Turn läuft noch.
      return false;
    } catch {
      return false;
    }
  }

  // Prüft, ob der Server-Turn für diesen Chat noch läuft: die letzte Session-Nachricht
  // ist noch die User-Nachricht (keine Assistant-Antwort) → Antwort kommt noch, das ist
  // KEIN Netzwerkfehler. Wird im send()-Fallback genutzt, um statt „Verbindung unterbrochen"
  // den Busy-Status beizubehalten und die Antwort per Session-Polling nachzuladen.
  async function serverTurnStillRunning(chatId: string): Promise<boolean> {
    try {
      const base = serverUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/api/session/${encodeURIComponent(chatId)}`, { headers: authHeaders() });
      if (!res.ok) return false;
      const data = await res.json();
      // Autoritative Busy-Signatur vom Server (turnRegistry): läuft gerade ein Turn?
      // Robuster als die alte Heuristik "letzte Nachricht = user", die nach einem
      // Server-Neustart fälschlich "läuft noch" meldete (Turn weg, Session-Datei hatte
      // aber noch die letzte user-Nachricht → Chat hing ewig als "busy").
      if (typeof data.activeTurn === "boolean") {
        return data.activeTurn === true;
      }
      // Fallback (älterer Server ohne activeTurn-Feld): bisherige Heuristik.
      if (!Array.isArray(data.messages) || data.messages.length === 0) return false;
      const serverUserCount = data.messages.filter((m: any) => m.role === "user").length;
      const chat = chatsRef.current.find((c) => c.id === chatId);
      const localUserCount = chat ? chat.messages.filter((m) => m.role === "user").length : 0;
      if (serverUserCount < localUserCount) return false;
      if (data.lastError && typeof data.lastError === "object" && data.lastError.text) return false;
      const last = data.messages[data.messages.length - 1];
      return !!last && last.role !== "assistant";
    } catch {
      return false;
    }
  }

  // Hat die letzte lokale User-Nachricht den Server erreicht? true bei offline/unbekannt
  // oder erreicht; false NUR wenn der Server nachweislich weniger User-Nachrichten hat
  // als lokal (die Nachricht ist nie angekommen → kein Server-Turn vorhanden).
  async function messageReachedServer(chatId: string): Promise<boolean> {
    // Stream-State mit turnId = der Server hat den Turn NACHWEISLICH gestartet
    // (turn_start empfangen). „Nicht gesendet" wäre dann immer falsch — die Nachricht
    // ist angekommen, der Turn ist höchstens abgebrochen/fertig. Verhindert das
    // voreilige „Nicht gesendet — bitte erneut senden" beim Öffnen eines Chats,
    // BEVOR die Auto-Resume die Antwort nachgeladen hat (Race mit dem Busy-Poller).
    const st = streamStateRef.current[chatId];
    if (st && st.turnId) return true;
    try {
      const base = serverUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/api/session/${encodeURIComponent(chatId)}`, { headers: authHeaders() });
      if (!res.ok) return true;
      const data = await res.json();
      // Autoritatives Busy-Signal: Turn läuft (Session-Datei evtl. noch leer —
      // Server schreibt sie lazy) → Nachricht hat den Server erreicht, KEIN „nie gesendet".
      if (data.activeTurn === true) return true;
      if (!Array.isArray(data.messages)) return true;
      const serverUserCount = data.messages.filter((m: any) => m.role === "user").length;
      const chat = chatsRef.current.find((c) => c.id === chatId);
      const localUserCount = chat ? chat.messages.filter((m) => m.role === "user").length : 0;
      return serverUserCount >= localUserCount;
    } catch {
      return true; // offline → nicht feststellbar → optimistisch als „erreicht" behandeln
    }
  }

  function saveFolders(next: Folder[]) {
    setFolders(next);
    if (storageBlockedRef.current.has(FOLDERS_ENC_KEY)) {
      warnWriteFailure(FOLDERS_ENC_KEY); // unlesbar → Ordner-Änderungen gehen verloren (lokal-only)
      return;
    }
    secureSet(FOLDERS_ENC_KEY, JSON.stringify(next))
      .then(() => { writeWarnedRef.current.delete(FOLDERS_ENC_KEY); })
      .catch(() => warnWriteFailure(FOLDERS_ENC_KEY));
  }

  // Dynamische Modell-Liste vom Server laden (neue Goeran-Modelle ohne Rebuild).
  async function loadModels() {
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/models`, { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.models) && data.models.length) {
        setDynamicModels(data.models.map((m: any) => ({ key: String(m.key || ""), label: String(m.label || m.key || "").toUpperCase(), ...(m.deactivated === true ? { deactivated: true } : {}) })));
        // Server-Standardmodell übernehmen (aktuell "flash") — damit App und
        // WhatsApp-Brücke immer dasselbe Default-Modell zeigen.
        const dflt = String(data.default || "");
        if (dflt && data.models.some((m: any) => String(m.key || "") === dflt)) setChatModel(dflt);
      }
    } catch {
      // offline → statische CHAT_MODEL_OPTIONS verwenden
    }
  }

  async function loadMeta() {
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/meta`, { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      setMeta({
        connectors: Array.isArray(data.connectors) ? data.connectors : [],
        skills: Array.isArray(data.skills) ? data.skills : [],
        agents: Array.isArray(data.agents) ? data.agents : [],
        workflows: Array.isArray(data.workflows) ? data.workflows : [],
        platforms: Array.isArray(data.platforms) ? data.platforms : [],
      });
    } catch {
      // offline → leer lassen
    }
  }

  async function loadConnectorsList() {
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/connectors`, { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      setConnectorsList(Array.isArray(data.connectors) ? data.connectors : []);
    } catch {
      // offline → leer lassen
    }
  }

  function modelOptions(): { key: string; label: string; deactivated?: boolean }[] {
    return dynamicModels.length ? dynamicModels : CHAT_MODEL_OPTIONS;
  }
  // Ist der Slug vom Server als deaktiviert gemeldet (oder statisch markiert)?
  function isModelDeactivated(key: string): boolean {
    return !!modelOptions().find((o) => o.key === key)?.deactivated;
  }
  // Erstes wählbares Modell (aktuell "flash") als Ersatz für deaktivierte Slugs.
  function fallbackModelKey(): string {
    return modelOptions().find((o) => !o.deactivated)?.key || "flash";
  }

  // --- Ordner/Projekte ---
  function folderChildren(parentId: string | null): Folder[] {
    return folders.filter((f) => f.parentId === parentId).sort((a, b) => a.order - b.order);
  }

  function openFolderModal(mode: "create" | "rename" | "edit", folderId?: string, parentId?: string | null) {
    if (mode === "create") {
      setFolderInput("");
      setFolderDescInput("");
      setFolderModal({ mode, parentId: parentId ?? null });
    } else {
      const f = folders.find((x) => x.id === folderId);
      setFolderInput(f?.name || "");
      setFolderDescInput(f?.description || "");
      setFolderModal({ mode, folderId, parentId: f?.parentId ?? null });
    }
  }

  function submitFolder() {
    const name = folderInput.trim().slice(0, MAX_FOLDER_NAME_CHARS);
    if (!name || !folderModal) return;
    if (folderModal.mode === "create") {
      const f: Folder = { id: uid("f"), name, description: folderDescInput.trim().slice(0, MAX_FOLDER_DESC_CHARS), parentId: folderModal.parentId ?? null, order: folders.length };
      saveFolders([...folders, f]);
    } else {
      saveFolders(folders.map((f) => (f.id === folderModal.folderId ? { ...f, name, description: folderDescInput.trim().slice(0, MAX_FOLDER_DESC_CHARS) } : f)));
    }
    setFolderModal(null);
  }

  function deleteFolder(folderId: string) {
    const descendants = new Set<string>([folderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of folders) {
        if (f.parentId && descendants.has(f.parentId) && !descendants.has(f.id)) { descendants.add(f.id); changed = true; }
      }
    }
    saveFolders(folders.filter((f) => !descendants.has(f.id)));
    setChats((cs) => cs.map((c) => (descendants.has(c.folderId || "") ? { ...c, folderId: null } : c)));
  }

  function assignChatToFolder(chatId: string, folderId: string | null) {
    patchChat(chatId, (c) => ({ ...c, folderId }));
    setAssignChatId(null);
    setFolderSuggestion((s) => (s && s.chatId === chatId ? null : s));
  }

  // KI ordnet eine neue Anfrage einem passenden Ordner zu (nicht-blockierend).
  async function suggestFolder(chatId: string, query: string) {
    if (folders.length === 0 || !query.trim()) return;
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/classify-folder`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ folders: folders.map((f) => ({ id: f.id, name: f.name, description: f.description })), query }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.folderId && data.name) {
        setFolderSuggestion({ chatId, folderId: data.folderId, name: data.name });
      }
    } catch {
      // offline → kein Vorschlag
    }
  }

  // --- Connectors ---
  async function addConnector() {
    const name = connectorForm.name.trim();
    if (!name) return;
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/connectors`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(connectorForm),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setConnectorForm({ name: "", agent: "", description: "" });
      loadConnectorsList();
    } catch {
      // Eingabe stehen lassen
    }
  }

  async function deleteConnector(id: string) {
    try {
      await fetch(`${serverUrl.replace(/\/+$/, "")}/api/connectors/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() });
    } catch {
      // ignorieren
    }
    loadConnectorsList();
  }

  useEffect(() => {
    (async () => {
      preloadIcons(); // Vektor-Icons (Ionicons) beim Start laden — kein FOUC/Start-Crash
      preloadFonts(); // echte Claude-Fonts (Anthropic Serif/Sans + JetBrains Mono) laden
      // Server-URL ist fest verdrahtet (detectBase) — keine gespeicherte/manuelle URL mehr.
      const url = serverUrl;
      let savedToken = "";
      let secureReadFailed = false;
      // Token liegt im Keychain/Keystore (expo-secure-store), nicht mehr als Klartext
      // in AsyncStorage. Migration: alter Klartext-Token wird einmalig übernommen.
      try {
        savedToken = (await SecureStore.getItemAsync(TOKEN_KEY)) || "";
      } catch {
        secureReadFailed = true; // Keychain transient nicht verfügbar → Klartext-Fallback NICHT in Keychain zurückschreiben
        savedToken = "";
      }
      try {
        if (!savedToken) savedToken = (await AsyncStorage.getItem(TOKEN_KEY)) || "";
      } catch {
        // ignorieren
      }
      // Geteilter App-Token aus dem Build (EXPO_PUBLIC_API_TOKEN) wird NICHT mehr verwendet:
      // EXPO_PUBLIC_* wird zur Build-Zeit ins Bundle inlined und ist aus der IPA extrahierbar.
      // Token wird ausschließlich über SecureStore/AsyncStorage bezogen (Pairing/Login).
      const cfgToken = "";
      if (cfgToken && cfgToken !== savedToken) {
        savedToken = cfgToken;
        setApiToken(cfgToken);
        SecureStore.setItemAsync(TOKEN_KEY, cfgToken, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY })
          .then(() => AsyncStorage.removeItem(TOKEN_KEY).catch(() => {}))
          .catch(() => {}); // Klartext behalten — nächster Start migriert erneut
      } else if (savedToken) {
        setApiToken(savedToken);
        // Nur in den Keychain migrieren, wenn der SecureStore-Read sicher leer war
        // (nicht transient fehlgeschlagen) — sonst könnte ein neuerer Keychain-Token
        // mit dem älteren Klartext überschrieben werden. Klartext erst NACH erfolgreichem
        // Keychain-Write löschen — sonst ist die einzige Kopie (AsyncStorage) weg.
        if (!secureReadFailed) {
          SecureStore.setItemAsync(TOKEN_KEY, savedToken, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY })
            .then(() => AsyncStorage.removeItem(TOKEN_KEY).catch(() => {}))
            .catch(() => {}); // Klartext behalten — nächster Start migriert erneut
        }
      }
      try {
        const savedCwd = await AsyncStorage.getItem(CWD_KEY);
        if (savedCwd) {
          setCwd(savedCwd);
        }
      } catch {
        // ignorieren
      }
      try {
        // Persistierten Stream-State beim Start laden: nach einem kompletten App-Kill
        // ist der turnId/lastSeq-Anker nur hier rekonstruierbar (Resume statt Antwort-Verlust).
        const rawStream = await AsyncStorage.getItem(STREAM_STATE_KEY);
        if (rawStream) {
          try { streamStateRef.current = JSON.parse(rawStream) || {}; } catch { streamStateRef.current = {}; }
        }
      } catch {
        // ignorieren
      }
      try {
        // Chats liegen verschlüsselt (AES-GCM, Key im Keychain). Migration: alter
        // Klartext-Bestand wird einmalig übernommen + neu verschlüsselt, dann entfernt.
        let savedChats: string | null = null;
        try {
          savedChats = await secureGetWithRetry(CHATS_ENC_KEY);
          if (savedChats != null) {
            // Verschlüsselter Bestand lesbar → evtl. Legacy-Klartext-Rest miträumen.
            await AsyncStorage.removeItem(CHATS_KEY).catch(() => {});
          }
        } catch {
          storageBlockedRef.current.add(CHATS_ENC_KEY); // JEDER Lesefehler blockiert (nicht nur SecureStoreError)
        }
        if (savedChats == null && !storageBlockedRef.current.has(CHATS_ENC_KEY)) {
          const legacy = await AsyncStorage.getItem(CHATS_KEY);
          if (legacy != null) {
            // Nur nach erfolgreicher Verschlüsselung den Klartext löschen — sonst Datenverlust.
            const ok = await secureSet(CHATS_ENC_KEY, legacy).then(() => true).catch(() => false);
            if (ok) {
              savedChats = legacy;
              await AsyncStorage.removeItem(CHATS_KEY).catch(() => {});
            } else {
              savedChats = legacy; // Verschlüsselung fehlgeschlagen → Klartext bleibt als Quelle
              warnWriteFailure(CHATS_ENC_KEY);
            }
          }
        }
        if (savedChats) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(savedChats);
          } catch {
            // Verschlüsselter Bestand lesbar, aber Inhalt korrupt (torn write) → nicht überschreiben.
            // (Der spätere Block-Alert weist darauf hin — kein Schreibfehler-Alert hier.)
            storageBlockedRef.current.add(CHATS_ENC_KEY);
            parsed = null;
          }
          if (Array.isArray(parsed)) {
            // Verwaiste leere KI-Nachrichten entfernen (weiße Balken aus abgebrochenen Streams).
            // ABER: NUR die LETZTE leere Bubble als Resume-Anker behalten, wenn ein Stream-State
            // existiert. Alle älteren leeren Bubbles sind weiße Balken aus abgebrochenen Turns und
            // werden entfernt — sonst füllen sie den Verlauf mit 100+ weißen Blöcken.
            const cleaned = parsed.map((c: any) => {
              const msgs = Array.isArray(c.messages) ? c.messages : [];
              let anchorId: string | null = null;
              if (streamStateRef.current[c.id]) {
                const lastEmpty = [...msgs].reverse().find(
                  (m: any) =>
                    m.role === "assistant" &&
                    !(m.text && String(m.text).trim()) &&
                    !(m.activity && m.activity.length) &&
                    !(m.permissions && m.permissions.length) &&
                    !(m.images && m.images.length) &&
                    !(m.dil && m.dil.length) &&
                    !m.error,
                );
                if (lastEmpty) anchorId = lastEmpty.id;
              }
              return {
                ...c,
                // Fehlerkarten aus dem Speicher verwerfen + leere Bubbles raeumen
                // (siehe lib.ts: sanitizeLoadedMessages).
                messages: sanitizeLoadedMessages(msgs, anchorId),
              };
            });
            setChats((prev) => (prev.length ? prev : cleaned));
            // Auto-Resume: für jeden Chat mit Stream-State + leerer KI-Bubble + User-Nachricht
            // den letzten Turn am Server fortsetzen (kompletter App-Kill -> Antwort wiederherstellen).
            for (const chat of cleaned) {
              const st = streamStateRef.current[chat.id];
              if (!st) continue;
              const aiMsg = chat.messages.filter(
                (m: any) => m.role === "assistant" && !(m.text?.trim()) && !m.error,
              ).pop();
              const userMsg = [...chat.messages].reverse().find((m: any) => m.role === "user");
              if (!aiMsg || !userMsg) continue;
              markBusy(chat.id, true);
              streamChat(userMsg.text, chat.id, aiMsg.id, [], [], { turnId: st.turnId, lastSeq: st.lastSeq || 0 }, st.clientMessageId)
                .then(() => markBusy(chat.id, false))
                .catch(async (err) => {
                  // Resume nicht möglich (Turn aufgeräumt) -> erst Session-Reload versuchen:
                  // die Server-Session-Datei überlebt die turnRegistry-TTL und ist die Wahrheit.
                  const filled = await reloadFromServer(chat.id);
                  if (filled) {
                    markBusy(chat.id, false);
                    return;
                  }
                  // Turn läuft serverseitig noch (lazy Session-Write)? Dann busy BEHALTEN:
                  // das Session-Polling (alle 3 s) lädt die Antwort, sobald sie fertig ist.
                  // Wichtig: busy hier NICHT löschen, sonst pollt niemand mehr und die
                  // Antwort bleibt für immer leer („Netzwerk unterbrochen" ohne Nachlieferung).
                  if (await serverTurnStillRunning(chat.id)) return;
                  // Echte Ursache anzeigen statt pauschal "Verbindung unterbrochen".
                  const raw = err instanceof Error ? err.message : String(err || "");
                  setErrorCard(chat.id, aiMsg.id, classifyError(raw), isRetryable(raw), "auto_resume", raw);
                  markBusy(chat.id, false);
                });
            }
          }
        }
      } catch {
        // ignorieren
      }
      try {
        let savedFolders: string | null = null;
        try {
          savedFolders = await secureGetWithRetry(FOLDERS_ENC_KEY);
          if (savedFolders != null) {
            await AsyncStorage.removeItem(FOLDERS_KEY).catch(() => {});
          }
        } catch {
          storageBlockedRef.current.add(FOLDERS_ENC_KEY);
        }
        if (savedFolders == null && !storageBlockedRef.current.has(FOLDERS_ENC_KEY)) {
          const legacy = await AsyncStorage.getItem(FOLDERS_KEY);
          if (legacy != null) {
            const ok = await secureSet(FOLDERS_ENC_KEY, legacy).then(() => true).catch(() => false);
            if (ok) {
              savedFolders = legacy;
              await AsyncStorage.removeItem(FOLDERS_KEY).catch(() => {});
            } else {
              savedFolders = legacy;
              warnWriteFailure(FOLDERS_ENC_KEY);
            }
          }
        }
        if (savedFolders) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(savedFolders);
          } catch {
            storageBlockedRef.current.add(FOLDERS_ENC_KEY);
            parsed = null;
          }
          if (Array.isArray(parsed)) setFolders(parsed);
        }
      } catch {
        // ignorieren
      }
      if (storageBlockedRef.current.size > 0) {
        // Verschlüsselter Bestand unlesbar (Key weg/korrupt). Daten NICHT still verwerfen:
        // Schreiben blockieren + einmalig hinweisen. (Tritt z. B. nach einem Geräte-Restore
        // ohne Key auf — die lokalen Chats sind dann technisch nicht wiederherstellbar.)
        Alert.alert(
          "Lokaler Verlauf nicht lesbar",
          "Der verschlüsselte lokale Verlauf (Chats/Ordner) kann nicht entschlüsselt werden (Schlüssel fehlt). " +
          "Er wird nicht überschrieben — Chats bleiben serverseitig erhalten, Ordner werden nur lokal gespeichert.",
        );
      }
      loadModels();
      loadMeta();
      loadConnectorsList();
      loadedRef.current = true;
      registerPush(url, savedToken);
    })();
  }, []);

  // Live-Sync: beim Öffnen/Zurückkommen die Session vom Server laden — eine im
  // Hintergrund fertig gewordene Antwort (leere lokale KI-Bubble) wieder auffüllen.
  useEffect(() => {
    if (!activeChatId || !loadedRef.current) return;
    if (busyChatIds.has(activeChatId)) return; // busy → Antwort noch nicht final im Server
    let cancelled = false;
    (async () => {
      try {
        const base = serverUrl.replace(/\/+$/, "");
        const res = await fetch(`${base}/api/session/${activeChatId}`, { headers: authHeaders() });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!Array.isArray(data.messages) || data.messages.length === 0) return;
        setChats((cs) =>
          cs.map((c) => {
            if (c.id !== activeChatId) return c;
            const lastAi = [...c.messages].reverse().find((m) => m.role === "assistant");
            const serverLast = [...data.messages].reverse().find((m) => m.role === "assistant" && String(m.text || "").trim());
            // Server-Session ist die Wahrheit: eine (Resume-)Fehler-Karte auffüllen, wenn der
            // Server die finale Antwort WIRKLICH hat. Zwei Guards gegen veraltete Antworten:
            // (1) letzte Server-Nachricht ist eine Assistant-Antwort (Turn fertig),
            // (2) der Server kennt mindestens so viele User-Nachrichten wie lokal — der
            //     fehlgeschlagene Turn hat den Server erreicht (kein reiner Send-Netzwerkfehler).
            const serverUserCount = [...data.messages].filter((m) => m.role === "user").length;
            const localUserCount = c.messages.filter((m) => m.role === "user").length;
            // „Frische Antwort" = letzte Text-tragende Assistant-Nachricht steht NACH der
            // letzten User-Nachricht (Turn ist durch) — unabhängig davon, ob danach noch
            // leere Zwischenschritte in der Session stehen.
            const lastUserIdx = (data.messages as { role?: string }[]).map((m) => m.role).lastIndexOf("user");
            const serverLastIdx = serverLast ? data.messages.lastIndexOf(serverLast) : -1;
            const serverHasFreshAnswer = !!serverLast && serverLastIdx > lastUserIdx && serverUserCount >= localUserCount;
            const serverText = (serverLast?.text || "").trim().slice(0, MAX_REPLY_CHARS);
            const localText = lastAi?.text?.trim() || "";
            if (lastAi && serverHasFreshAnswer && serverText.length > localText.length) {
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === lastAi.id ? { ...m, text: serverText, images: resolveImageList(serverLast.images, serverUrl) || m.images, error: undefined } : m,
                ),
                updatedAt: Date.now(),
              };
            }
            return c;
          }),
        );
      } catch {
        // offline/Server nicht erreichbar → lokalen Stand behalten
      }
    })();
    return () => { cancelled = true; };
  }, [activeChatId, serverUrl, busyChatIds, foregroundTick]);

  // Während ein Chat „busy“ ist (Turn läuft serverseitig, z. B. nach App-Wechsel in den
  // Hintergrund), die Server-Session regelmäßig pollen: sobald die finale Antwort vorliegt,
  // die lokale (leere/teilweise) Bubble auffüllen und busy aufheben.
  useEffect(() => {
    if (!loadedRef.current) return;
    const ids = [...busyChatIds];
    if (ids.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // ALLE busy Chats pollen, nicht nur den aktiven: sonst bleibt eine im Hintergrund
    // fertig gewordene Antwort in einem anderen Chat für immer „busy" hängen.
    const poll = async () => {
      if (cancelled) return;
      let stillBusy = false;
      for (const id of ids) {
        if (cancelled) return;
        if (!busyChatIds.has(id)) continue; // inzwischen fertig
        const filled = await reloadFromServer(id);
        if (cancelled) return;
        if (filled) {
          setStatusByChat((prev) => ({ ...prev, [id]: "" }));
          markBusy(id, false);
          continue;
        }
        // Nachricht hat den Server nie erreicht (Send während Offline): kein Turn da,
        // der fertig werden könnte → Retry-Karte statt endlosem Polling.
        if (!(await messageReachedServer(id))) {
          const deadAi = [...(chatsRef.current.find((c) => c.id === id)?.messages || [])].reverse().find((m) => m.role === "assistant");
          if (deadAi && !deadAi.text?.trim() && !deadAi.error) {
            setErrorCard(id, deadAi.id, "Nicht gesendet — bitte erneut senden.", true, "poll_not_sent");
          }
          setStatusByChat((prev) => ({ ...prev, [id]: "" }));
          markBusy(id, false);
          continue;
        }
        stillBusy = true;
      }
      if (!cancelled && stillBusy) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [activeChatId, busyChatIds, serverUrl, foregroundTick]);

  // Chats automatisch speichern (debounced; trimmen: max 50 Chats, 200 Nachrichten je Chat).
  // WICHTIG (Performance, gemessen 20.11.): während eines Turns ändert sich `chats` bei
  // JEDEM Delta. Das Speichern verschlüsselt den ganzen Bestand per AES-GCM im JS-Thread
  // (331 ms bei 2,2 MB, 664 ms bei 4,3 MB) + hex-verdoppelt in AsyncStorage — hundertfach
  // pro Antwort war das die Ursache für ~2 s verzögerte Taps. Deshalb: beim Streamen NICHT
  // speichern, sondern einmal, wenn nichts mehr läuft (busyChatIds leer).
  useEffect(() => {
    if (!loadedRef.current || storageBlockedRef.current.has(CHATS_ENC_KEY)) return;
    if (busyChatIds.size > 0) return;
    const t = setTimeout(() => {
      // Nur-lesbare Verläufe (WhatsApp/Terminal) NICHT lokal speichern: sie werden bei
      // jedem Sync frisch vom Server geholt und können sehr groß sein (bis ~7 MB).
      const trimmed = trimChatsForStorage(
        chats
          .filter((c) => !c.readOnly)
          .slice(0, 50)
          .map((c) => ({ ...c, title: deriveTitle(c.title || ""), messages: stripErrorFlags(c.messages || []) })),
      );
      secureSet(CHATS_ENC_KEY, JSON.stringify(trimmed))
        .then(() => { writeWarnedRef.current.delete(CHATS_ENC_KEY); })
        .catch(() => warnWriteFailure(CHATS_ENC_KEY));
    }, 2500);
    return () => clearTimeout(t);
  }, [chats, busyChatIds]);

  // Aufgaben automatisch aktualisieren (Plugins → Tasks)
  useEffect(() => {
    if (tab !== "plugins" || pluginsTab !== "tasks") return;
    loadTasks();
    const t = setInterval(loadTasks, 4000);
    return () => {
      clearInterval(t);
      tasksAbortRef.current?.abort();
    };
  }, [tab, pluginsTab, serverUrl, apiToken]);

  // Plugins → Connectoren: Meta inkl. Plattform-Status laden. Der Plattform-Doctor
  // läuft serverseitig asynchron (TTL-Cache), deshalb pollen bis Daten da sind.
  useEffect(() => {
    if (tab !== "plugins" || pluginsTab !== "connectors") return;
    loadMeta();
    if (meta.platforms.length > 0) return;
    const t = setInterval(() => {
      loadMeta();
    }, 8000);
    return () => clearInterval(t);
  }, [tab, pluginsTab, serverUrl, apiToken]);

  async function registerPush(url: string, tok?: string) {
    // Push-Token (sensibler Geräte-Credential) nur über HTTPS übertragen
    if (!url.startsWith("https://")) return;
    try {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== "granted") return;
      const token = (await Notifications.getExpoPushTokenAsync()).data;
      await fetch(`${url.replace(/\/+$/, "")}/register-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(tok && url.startsWith("https://") ? { "X-API-Token": tok } : {}) },
        body: JSON.stringify({ token }),
      });
    } catch {
      // In Expo Go sind Push-Benachrichtigungen nicht verfügbar – ignorieren.
    }
  }

  // Push-Antipp öffnet den richtigen Chat: der Server schickt die chatId im
  // data-Payload mit (sendPush). Ohne diesen Listener wäre der Deep-Link wirkungslos.
  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    try {
      sub = Notifications.addNotificationResponseReceivedListener((resp) => {
        const data = resp?.notification?.request?.content?.data as { chatId?: unknown } | undefined;
        const chatId = typeof data?.chatId === "string" ? data.chatId : "";
        if (!chatId) return;
        setTab("chats");
        openChat(chatId);
      });
    } catch {
      // Expo Go / Web: Push-Listener nicht verfügbar → ignorieren.
    }
    return () => { try { sub?.remove(); } catch { /* ignorieren */ } };
  }, []);

  // Anhänge hängen am COMPOSER, nicht am Chat. Wechselt man den Chat, dürfen
  // alte Anhänge nicht mitwandern — sonst gehen sie beim nächsten Senden mit
  // (z. B. altes Foto + neues Foto in einem Turn, ohne dass man es merkt).
  function clearPendingAttachments() {
    setPendingImages([]);
    setPendingFiles([]);
    setPendingDocuments([]);
  }

  // Server-Verläufe holen (App-Chats anderer Geräte, WhatsApp, Terminal) und alles
  // herausfiltern, was auf diesem Gerät schon als lokaler Chat liegt. Der Abgleich
  // läuft über die chatId-Hashes (Parameter `ids`) und die Session-Datei als Schlüssel.
  async function syncServerChats() {
    try {
      const base = serverUrl.replace(/\/+$/, "");
      const locals = chatsRef.current;
      const ids = locals
        .map((c) => c.id)
        .filter((id) => id && !id.startsWith("file:"));
      // Query manuell bauen: URLSearchParams ist in Hermes unzuverlässig.
      let qs = "limit=400";
      if (ids.length) qs += `&ids=${encodeURIComponent(ids.slice(0, 300).join(","))}`;
      const res = await fetch(`${base}/api/chats?${qs}`, { headers: authHeaders() });      if (!res.ok) return;
      const data = await res.json();
      const list: any[] = Array.isArray(data?.chats) ? data.chats : [];
      const localIds = new Set(locals.map((c) => c.id));
      const localKeys = new Set(locals.map((c) => c.serverKey).filter(Boolean) as string[]);
      const next: Chat[] = [];
      for (const c of list) {
        if (!c || !c.id) continue;
        if (c.known === true) continue; // liegt schon lokal auf diesem Gerät
        if (localIds.has(c.id)) continue;
        if (c.key && localKeys.has(c.key)) continue; // schon als lokaler Chat übernommen
        const source: ChatSource = c.source === "whatsapp" ? "whatsapp" : c.source === "terminal" ? "terminal" : "app";
        const updated = Number(c.updatedAt) || Date.now();
        next.push({
          id: String(c.id),
          title: String(c.title || "Ohne Titel"),
          messages: [],
          createdAt: updated,
          updatedAt: updated,
          source,
          readOnly: source !== "app",
          remote: true,
          serverKey: c.key ? String(c.key) : undefined,
          preview: String(c.preview || ""),
        });
      }
      setRemoteChats(next);
    } catch {
      // offline → alte Liste behalten
    }
  }

  // Pull-to-Refresh im Chat: Verlauf komplett vom Server nachladen (z. B. Antwort kam,
  // während die App im Hintergrund war). Laufender Turn wird NICHT überschrieben.
  async function refreshActiveChat() {
    const chatId = activeChatId;
    if (!chatId || busyChatIds.has(chatId) || refreshingChat) return;
    setRefreshingChat(true);
    haptic("light");
    try {
      const base = serverUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/api/session/${encodeURIComponent(chatId)}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const msgs: Msg[] = Array.isArray(data?.messages)
          ? data.messages.slice(-300).map((m: any, i: number) => ({
              id: String(m.id || `r${i}`),
              role: m.role === "user" ? "user" : "assistant",
              text: String(m.text || ""),
              images: Array.isArray(m.images) && m.images.length ? m.images : undefined,
            }))
          : [];
        // Leere Server-Antwort nie über den lokalen Verlauf legen.
        // MERGE statt Ersetzen: die Server-Antwort kennt nur id/role/text/images —
        // ein Voll-Ersetzen würde Tool-Karten (activity), DIL-Blöcke, Fehler- und
        // Freigabe-Karten aus dem sichtbaren Verlauf löschen.
        if (msgs.length) {
          setChats((cs) =>
            cs.map((c) => {
              if (c.id !== chatId) return c;
              const serverUsers = msgs.filter((m) => m.role === "user").length;
              const localUsers = c.messages.filter((m) => m.role === "user").length;
              if (serverUsers < localUsers) return c; // Server hinterher → nichts anwenden
              const local = new Map(c.messages.map((m) => [m.id, m]));
              const merged = msgs.map((m) => {
                const prev = local.get(m.id);
                if (!prev) return m;
                const text = (m.text?.length ?? 0) > (prev.text?.length ?? 0) ? m.text : prev.text;
                return { ...prev, text, images: m.images ?? prev.images };
              });
              return { ...c, messages: merged };
            }),
          );
        }
      }
      void syncServerChats();
    } catch {
      // offline → lokaler Verlauf bleibt stehen
    } finally {
      setRefreshingChat(false);
    }
  }

  // Verlauf eines Server-Chats laden und als lokalen Chat übernehmen.
  async function adoptRemoteChat(r: Chat) {
    const chat: Chat = { ...r, remote: false, createdAt: Date.now() };
    setChats((cs) => [chat, ...cs.filter((c) => c.id !== chat.id)]);
    setRemoteChats((rs) => rs.filter((c) => c.id !== chat.id));
    setActiveChatId(chat.id);
    try {
      const base = serverUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/api/session/${encodeURIComponent(chat.id)}`, { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const msgs: Msg[] = Array.isArray(data?.messages)
        ? data.messages.slice(-300).map((m: any, i: number) => ({
            id: String(m.id || `s${i}`),
            role: m.role === "user" ? "user" : "assistant",
            text: String(m.text || ""),
            images: Array.isArray(m.images) && m.images.length ? m.images : undefined,
          }))
        : [];
      if (!msgs.length) return;
      setChats((cs) => cs.map((c) => (c.id === chat.id ? { ...c, messages: msgs } : c)));
    } catch {
      // Verlauf bleibt leer — beim nächsten Öffnen erneut
    }
  }

  // Nur-lesbaren Verlauf als Kopie in die App übernehmen (Server kopiert die Session-Datei,
  // der Original-Verlauf bleibt unangetastet).
  async function forkReadOnlyChat(c: Chat) {
    try {
      const base = serverUrl.replace(/\/+$/, "");
      const res = await fetch(`${base}/api/fork`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ chatId: c.id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data?.chatId) throw new Error("keine Chat-ID zurückgegeben");
      const copy: Chat = {
        id: String(data.chatId),
        title: `${c.title} (Kopie)`,
        messages: c.messages,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: "app",
      };
      setChats((cs) => [copy, ...cs]);
      setActiveChatId(copy.id);
      Alert.alert("Übernommen", "Der Verlauf liegt jetzt als eigener Chat in der App — hier kannst du weiterschreiben.");
    } catch (e) {
      Alert.alert("Übernehmen fehlgeschlagen", e instanceof Error ? e.message : String(e));
    }
  }

  function openChat(id: string | null) {
    clearPendingAttachments();
    if (id) {
      const remote = remoteChats.find((c) => c.id === id);
      if (remote) {
        adoptRemoteChat(remote);
        return;
      }
    }
    setActiveChatId(id);
  }

  // Geteilter Inhalt aus der Share-Extension (App Group "group.com.meister.piapp").
  // Die Extension legt JSON unter "kittyai.pendingShare" ab, hier wird es beim
  // naechsten Vordergrund-Wechsel gelesen und in den Eingabetext uebernommen.
  const shareStore = useMemo(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("@bacons/apple-targets/build/ExtensionStorage");
      return new mod.ExtensionStorage("group.com.meister.piapp") as {
        get: (k: string) => string | null;
        remove: (k: string) => void;
      };
    } catch {
      return null;
    }
  }, []);
  // Geteilte Dateien aus der Share-Extension: Bilder -> pendingImages, PDF/Office ->
  // pendingDocuments, Text -> pendingFiles. Die Dateien liegen im App-Group-Container,
  // im Payload steht nur der Pfad (Base64 waere fuer UserDefaults zu gross).
  const attachSharedFiles = useCallback(async (files: { path: string; name?: string }[]) => {
    const imageMime: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heic", gif: "image/gif", webp: "image/webp" };
    const docMime: Record<string, string> = {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
    const textExt = new Set(["txt", "md", "markdown", "csv", "json", "log", "html", "xml", "yml", "yaml", "tsv"]);
    const MAX_SHARE_BYTES = 8 * 1024 * 1024;
    let skipped = 0;
    for (const f of files.slice(0, 5)) {
      try {
        const uri = f.path.startsWith("file://") ? f.path : "file://" + f.path;
        const name = f.name || f.path.split("/").pop() || "datei";
        const ext = (name.split(".").pop() || "").toLowerCase();
        const file = new File(uri);
        const size = typeof file.size === "number" ? file.size : 0;
        if (size > MAX_SHARE_BYTES) {
          skipped += 1;
          continue;
        }
        if (imageMime[ext]) {
          const b64 = await file.base64();
          if (b64) setPendingImages((p) => [...p, { data: b64, mediaType: imageMime[ext], uri }].slice(0, 5));
        } else if (docMime[ext]) {
          const b64 = await file.base64();
          if (b64) setPendingDocuments((p) => [...p, { name, data: b64, mimeType: docMime[ext] }].slice(0, 5));
          try { file.delete(); } catch { /* ignorieren */ }
        } else if (textExt.has(ext)) {
          const text = await file.text();
          if (text) setPendingFiles((p) => [...p, { name, content: text.slice(0, 20000) }].slice(0, 5));
          try { file.delete(); } catch { /* ignorieren */ }
        } else {
          skipped += 1;
        }
      } catch {
        skipped += 1;
      }
    }
    if (skipped) {
      Alert.alert("Nicht übernommen", skipped + " Anhang/Anhänge passten nicht (max. 8 MB, erlaubt: Bilder, PDF, Word, PowerPoint, Excel, Text).");
    }
  }, []);
  const pullPendingShare = useCallback(() => {
    if (!shareStore) return;
    let raw: string | null = null;
    try {
      raw = shareStore.get("kittyai.pendingShare");
    } catch {
      return;
    }
    if (!raw) return;
    shareStore.remove("kittyai.pendingShare");
    try {
      const payload = JSON.parse(raw) as { text?: string; url?: string; files?: { path: string; name?: string }[] };
      const shared = [payload.url, payload.text].filter((v): v is string => !!v && v.length > 0).join("\n");
      const sharedFiles = Array.isArray(payload.files) ? payload.files.filter((f) => f && typeof f.path === "string" && f.path) : [];
      if (!shared && !sharedFiles.length) return;
      newChat();
      if (shared) {
        setTimeout(() => {
          setInput((prev) => (prev.trim() ? prev + "\n" + shared : shared));
        }, 50);
      }
      if (sharedFiles.length) void attachSharedFiles(sharedFiles);
      haptic("light");
    } catch {
      /* kaputter Eintrag: ignorieren */
    }
  }, [attachSharedFiles, shareStore]);

  // Deeplinks aus Widget, Shortcuts und Extensions: kittyai://new | voice | chats
  const deepLinkRef = useRef<(url: string | null) => void>(() => {});
  useEffect(() => {
    deepLinkRef.current = (url: string | null) => {
      if (!url) return;
      const m = /^kittyai:\/\/([a-z]+)/i.exec(url);
      if (!m) return;
      const action = m[1].toLowerCase();
      haptic("light");
      if (action === "new") {
        newChat();
      } else if (action === "voice") {
        newChat();
        setTimeout(() => { void toggleMic(); }, 400);
      } else if (action === "chats") {
        setActiveChatId(null);
        setTab("chats");
      }
    };
  });
  useEffect(() => {
    pullPendingShare();
    const appStateSub = AppState.addEventListener("change", (st) => {
      if (st === "active") pullPendingShare();
    });
    Linking.getInitialURL().then((u) => deepLinkRef.current(u)).catch(() => {});
    const sub = Linking.addEventListener("url", (e) => deepLinkRef.current(e.url));
    return () => {
      sub.remove();
      appStateSub.remove();
    };
  }, [pullPendingShare]);

  function newChat(): string {
    const id = uid("c");
    const chat: Chat = { id, title: "Neuer Chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    setChats((cs) => [chat, ...cs]);
    clearPendingAttachments();
    setActiveChatId(id);
    setTab("chats");
    return id;
  }

  function deleteChat(chatId: string) {
    setChats((cs) => cs.filter((c) => c.id !== chatId));
    if (activeChatId === chatId) {
      setActiveChatId(null);
      clearPendingAttachments();
    }
    // Server-seitig aufräumen: laufende Antwort abbrechen + Session zurücksetzen,
    // damit kein toter pi-Prozess/keine tote Session weiterläuft.
    const running = abortControllersRef.current.get(chatId);
    running?.abort();
    abortControllersRef.current.delete(chatId);
    if (running) abortedRef.current.add(chatId); // nur bei laufendem Stream signalisieren (kein Leak)
    fetch(`${serverUrl.replace(/\/+$/, "")}/api/abort`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ chatId }),
    }).catch(() => {});
    fetch(`${serverUrl.replace(/\/+$/, "")}/api/new-session`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ chatId }),
    }).catch(() => {});
  }

  async function speakReply(text: string) {
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/tts`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.audioBase64) {
        const file = new File(Paths.cache, `tts-${Date.now()}.mp3`);
        file.create({ overwrite: true, intermediates: true });
        await file.write(data.audioBase64, { encoding: "base64" });
        player.replace({ uri: file.uri });
        player.play();
        return;
      }
    } catch {
      // ElevenLabs/Edge nicht erreichbar → Fallback
    }
    Speech.speak(text, { language: "de-DE" });
  }

  const MAX_IMG_BYTES = 5 * 1024 * 1024;

  // Läuft NUR, wenn der PHPicker gar nicht erst öffnet (Fehler/fehlende Berechtigung).
  function offerPhotoSettings(err?: unknown) {
    const detail = err instanceof Error && err.message ? `\n\n${err.message}` : "";
    Alert.alert(
      "Galerie lässt sich nicht öffnen",
      `Wenn der Foto-Picker nicht erscheint: iOS-Einstellungen → KittyAI → Fotos → „Alle Fotos“ erlauben.${detail}`,
      [
        { text: "Einstellungen öffnen", onPress: () => Linking.openSettings().catch(() => {}) },
        { text: "Abbrechen", style: "cancel" },
      ],
    );
  }

  async function pickImage() {
    try {
      // WICHTIG (iOS): `allowsEditing: true` zwingt expo-image-picker auf den alten
      // UIImagePickerController — der BRAUCHT die Foto-Berechtigung. Ist sie früher
      // verweigert oder auf „limitiert“ gesetzt worden, öffnet er stumm nichts.
      // Ohne allowsEditing nutzt expo-image-picker den PHPickerViewController: der läuft
      // out-of-process und zeigt die Galerie IMMER (auch ohne/bei verweigerter Freigabe).
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        base64: true,
        quality: 0.7,
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: 5,
        exif: false,
      });
      if (res.canceled || !res.assets?.length) return;

      const added: { data: string; mediaType: string; uri: string }[] = [];
      let tooBig = 0;
      let unreadable = 0;
      for (const a of res.assets) {
        if (a.fileSize && a.fileSize > MAX_IMG_BYTES) {
          tooBig += 1;
          continue;
        }
        const b64 = a.base64 ?? "";
        if (!b64) {
          unreadable += 1;
          continue;
        }
        if (b64.length > (MAX_IMG_BYTES * 4) / 3) {
          tooBig += 1;
          continue;
        }
        added.push({ data: b64, mediaType: a.mimeType || "image/jpeg", uri: a.uri });
      }
      if (added.length) setPendingImages((p) => [...p, ...added].slice(0, 5));
      if (tooBig) {
        Alert.alert("Bild zu groß", `${tooBig} Bild(er) über 5 MB wurden übersprungen — bitte kleinere wählen.`);
      } else if (unreadable) {
        Alert.alert("Bild konnte nicht gelesen werden", "Bitte ein anderes Bild wählen (JPG/PNG/HEIC).");
      }
    } catch (e) {
      offerPhotoSettings(e);
    }
  }

  async function pickCameraImage() {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Keine Kamera-Freigabe",
          "iOS-Einstellungen → KittyAI → Kamera erlauben, dann Foto aufnehmen.",
          [
            { text: "Einstellungen öffnen", onPress: () => Linking.openSettings().catch(() => {}) },
            { text: "Abbrechen", style: "cancel" },
          ],
        );
        return;
      }
      const res = await ImagePicker.launchCameraAsync({ base64: true, quality: 0.7, exif: false });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      const b64 = a.base64 ?? "";
      if (!b64) {
        Alert.alert("Foto konnte nicht gelesen werden", "Bitte nochmal aufnehmen.");
        return;
      }
      if (b64.length > (MAX_IMG_BYTES * 4) / 3) {
        Alert.alert("Foto zu groß", "Maximal 5 MB — bitte näher heran / niedrigere Auflösung.");
        return;
      }
      setPendingImages((p) => [...p, { data: b64, mediaType: a.mimeType || "image/jpeg", uri: a.uri }].slice(0, 5));
    } catch (e) {
      Alert.alert("Foto aufnehmen fehlgeschlagen", e instanceof Error ? e.message : String(e));
    }
  }

  async function pickFile() {
    try {
      // Mehrfachauswahl: bis zu 5 Dateien in einem Zug (Server-Limit: 5 Dokumente).
      const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
      if (res.canceled || !res.assets?.length) return;
      const docs: { name: string; data: string; mimeType: string }[] = [];
      const files: { name: string; content: string }[] = [];
      let skippedFormat = 0;
      let skippedSize = 0;
      for (const a of res.assets) {
        const lower = (a.name || "").toLowerCase();
        const isPdf = a.mimeType === "application/pdf" || lower.endsWith(".pdf");
        // Word/PowerPoint/Excel sind ZIP-Container: als Text gelesen käme Binärmüll
        // beim Modell an. Sie gehen wie PDFs als Base64 an den Server, der den Text
        // mit scripts/office_extract.py herausholt.
        const officeMime = lower.endsWith(".docx")
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : lower.endsWith(".pptx")
            ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            : lower.endsWith(".xlsx")
              ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : "";
        if (/(?:^|\.)(?:doc|xls|ppt)$/i.test(lower)) {
          skippedFormat += 1;
          continue;
        }
        // Audio (Sprachnotiz, Interview): der Server transkribiert per Gemini.
        const audioMime = /^audio\//.test(a.mimeType || "") ? String(a.mimeType) : "";
        const isDocument = isPdf || !!officeMime || !!audioMime;
        const maxBytes = isDocument ? 8 * 1024 * 1024 : 2 * 1024 * 1024;
        if (a.size && a.size > maxBytes) {
          skippedSize += 1;
          continue;
        }
        const f = new File(a.uri);
        if (isDocument) {
          const b64 = await f.base64();
          if (b64.length * 0.75 > maxBytes) {
            skippedSize += 1;
            continue;
          }
          docs.push({
            name: a.name || "dokument.pdf",
            data: b64,
            mimeType: isPdf ? "application/pdf" : officeMime || audioMime,
          });
        } else {
          const content = await f.text();
          files.push({ name: a.name || "datei", content: content.slice(0, 20000) });
        }
      }
      if (skippedFormat) {
        Alert.alert(
          "Format nicht unterstützt",
          `${skippedFormat} Datei(en) im alten .doc/.xls/.ppt-Format wurden übersprungen — bitte als .docx/.xlsx/.pptx exportieren.`,
        );
      }
      if (skippedSize) {
        Alert.alert(
          "Datei zu groß",
          `${skippedSize} Datei(en) übersprungen — maximal 8 MB pro Dokument/Audio, 2 MB für Textdateien.`,
        );
      }
      if (docs.length) {
        const overflow = docs.length + pendingDocuments.length - 5;
        if (overflow > 0) Alert.alert("Maximal 5 Dokumente", `${overflow} Datei(en) wurden nicht übernommen.`);
        if (docs.length + pendingDocuments.length > 0) setPendingDocuments((p) => [...p, ...docs].slice(0, 5));
      }
      if (files.length) setPendingFiles((p) => [...p, ...files].slice(0, 8));
    } catch (e) {
      Alert.alert("Datei anhängen fehlgeschlagen", e instanceof Error ? e.message : String(e));
    }
  }

  // Kleiner Text-Dialog (iOS Alert.prompt); Fallback: Hinweis, wenn nicht verfügbar.
  function askText(title: string, placeholder: string): Promise<string | null> {
    return new Promise((resolve) => {
      const anyAlert = Alert as unknown as {
        prompt?: (
          t: string,
          p?: string,
          cb?: (text: string) => void,
          type?: { placeholder?: string; cancelButtonText?: string; okButtonText?: string },
        ) => void;
      };
      if (typeof anyAlert.prompt === "function") {
        anyAlert.prompt(
          title,
          placeholder,
          (text: string) => resolve(text && text.trim() ? text.trim() : null),
          { placeholder, cancelButtonText: "Abbrechen", okButtonText: "Erstellen" },
        );
      } else {
        resolve(null);
      }
    });
  }

  // Führt den Bild-Request aus und befüllt eine BESTEHENDE Bubble (auch für „Erneut versuchen“).
  async function regenerateImage(chatId: string, aiId: string, prompt: string) {
    markBusy(chatId, true);
    const ctrl = new AbortController();
    abortControllersRef.current.set(chatId, ctrl);
    // Der Server wiederholt selbst (Pollinations-Limit: 1 Bild / 45 s) → großzügiger Timeout.
    const timer = setTimeout(() => ctrl.abort(), 300000);
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/image`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ prompt }),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({} as { url?: string; error?: string; retryable?: boolean }));
      if (!res.ok) {
        const hint = typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`;
        throw new Error(hint);
      }
      // Nur gültige Bild-URLs übernehmen (relativer Pfad oder http(s)) — kein Schema-/Host-Injection.
      const rawUrl = typeof data.url === "string" ? data.url : "";
      const imgUri = /^https?:\/\//i.test(rawUrl)
        ? rawUrl
        : rawUrl.startsWith("/")
          ? `${serverUrl.replace(/\/+$/, "")}${rawUrl}`
          : "";
      if (!imgUri) throw new Error("Ungültige Bild-URL vom Server");
      patchMsg(chatId, aiId, (m) => ({ ...m, text: "", images: [{ uri: imgUri }], error: undefined }));
      if (speak) speakReply("Hier ist das Bild.");
    } catch (e) {
      if (abortedRef.current.has(chatId)) {
        // Nutzer-Stop (nicht Timeout): leere KI-Bubble entfernen statt Fehlerkarte.
        abortedRef.current.delete(chatId);
        patchChat(chatId, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== aiId) }));
      } else if (wentBackgroundRef.current) {
        // App ging in den Hintergrund → wir haben selbst abgebrochen. Kein Netzwerk-
        // Fehlalarm, aber ehrlich benennen: die Generierung ist nicht fertig geworden.
        setErrorCard(chatId, aiId, "Bild-Generierung unterbrochen (App im Hintergrund)", true, "image_background");
      } else {
        const msg = ctrl.signal.aborted ? "Zeitüberschreitung bei der Bild-Generierung" : (e instanceof Error ? e.message : String(e));
        setErrorCard(chatId, aiId, `Bild-Generierung fehlgeschlagen: ${msg}`, true, "image_failed", msg);
      }
    } finally {
      clearTimeout(timer);
      if (abortControllersRef.current.get(chatId) === ctrl) abortControllersRef.current.delete(chatId);
      markBusy(chatId, false);
    }
  }

  async function generateImageInChat() {
    let prompt = input.trim();
    if (!prompt) {
      const asked = await askText("Was soll ich zeichnen?", "z. B. eine Katze auf einem Skateboard");
      if (!asked) {
        Alert.alert("Kein Motiv", "Schreibe kurz ins Textfeld, was ich zeichnen soll – dann nochmal auf „Bild erstellen“ tippen.");
        return;
      }
      prompt = asked;
    }
    if (isThisChatBusy) return;
    let chatId = activeChatId;
    if (!chatId) chatId = newChat();
    setInput("");
    const userMsg: Msg = { id: uid("u"), role: "user", text: prompt };
    const aiId = uid("a");
    const aiMsg: Msg = { id: aiId, role: "assistant", text: "Bild wird erstellt …", images: [] };
    patchChat(chatId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? (deriveTitle(prompt) || c.title) : c.title,
      messages: [...c.messages, userMsg, aiMsg],
      updatedAt: Date.now(),
    }));
    await regenerateImage(chatId, aiId, prompt);
  }

  async function send(text?: string, voice?: boolean) {
    const message = (text ?? input).trim();
    // Nur-lesbare Verläufe (WhatsApp, Terminal) nie anschreiben — der Verlauf gehört
    // einem anderen Prozess/Kanal. Stattdessen den Übernehmen-Weg anbieten.
    const activeMeta = chatsRef.current.find((c) => c.id === activeChatId);
    if (activeMeta?.readOnly) {
      Alert.alert(
        activeMeta.source === "whatsapp" ? "WhatsApp-Verlauf" : "Terminal-Verlauf",
        activeMeta.source === "whatsapp"
          ? "Antworten laufen über WhatsApp. Du kannst den Verlauf hier lesen oder als Kopie in die App übernehmen."
          : "Dieser Verlauf gehört dem pi-Prozess im Terminal. Über 'Übernehmen' wird eine Kopie erstellt, in der du hier weiterschreiben kannst.",
        [
          { text: "Schließen", style: "cancel" },
          { text: "Als Kopie übernehmen", onPress: () => { if (activeMeta) forkReadOnlyChat(activeMeta); } },
        ],
      );
      return;
    }
    if (!message && pendingImages.length === 0 && pendingFiles.length === 0 && pendingDocuments.length === 0) return;
    let chatId = activeChatId;
    if (!chatId) chatId = newChat();
    if (busyChatIds.has(chatId)) return; // nur dieser Chat ist gerade beschäftigt
    haptic("light"); // Senden quittiert wie ChatGPT (UIImpactFeedbackGenerator.light)
    wentBackgroundRef.current = false; // neuer Turn → Hintergrund-Flag zurücksetzen
    let turnStillRunning = false; // Server-Turn läuft noch → kein Fehler, Busy-Polling übernimmt
    const isFirst = !chats.find((c) => c.id === chatId)?.messages.length;
    let finalMessage = message;
    const replyTo = replyingTo ? { text: replyingTo.text.replace(/\n+/g, " ").trim().slice(0, 200) } : undefined;
    if (replyTo) {
      finalMessage = `[Antwort auf: "${replyTo.text}"]\n${finalMessage}`;
    }
    if (pendingFiles.length) {
      const fileText = pendingFiles.map((f) => {
        // Dateinamen sind Nutzer-Eingaben → Control-Chars strippen + Länge deckeln,
        // damit kein Prompt-Injection-/Formatierungs-Bruch über den Namen entsteht.
        const name = (f.name || "Datei").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || "Datei";
        return `### ${name}\n${f.content}`;
      }).join("\n\n");
      finalMessage = finalMessage ? `${finalMessage}\n\n[Angehängte Dateien]\n${fileText}` : `[Angehängte Dateien]\n${fileText}`;
    }
    const images = pendingImages.map((im) => ({ data: im.data, mediaType: im.mediaType }));
    const documents = pendingDocuments.map((d) => ({ name: d.name, data: d.data, mimeType: d.mimeType }));
    if (!message && (images.length || documents.length)) {
      const hint = images.length ? "[Bild angehängt – analysiere es]" : "[PDF-Dokument angehängt – analysiere es]";
      finalMessage = finalMessage ? `${finalMessage}\n${hint}` : hint;
    }
    const imageUris = pendingImages.map((im) => ({ uri: im.uri }));
    setInput("");
    setChatThinking(chatId, "");
    setStatusByChat((prev) => ({ ...prev, [chatId]: "" }));
    // Anhänge mit Namen/Größe an der Blase festhalten (Bilder zeigen schon die
    // Thumbnails): so ist nach Chatwechsel/Reload sichtbar, was mitgeschickt wurde.
    const attList: { kind: string; name: string; sizeKB?: number }[] = [
      ...pendingDocuments.map((d) => ({
        kind: /^audio\//.test(d.mimeType || "") ? "audio" : "document",
        name: d.name,
        sizeKB: Math.round(((d.data || "").length * 0.75) / 1024),
      })),
      ...pendingFiles.map((f) => ({ kind: "file", name: f.name })),
    ];
    const userMsg: Msg = { id: uid("u"), role: "user", text: message || (imageUris.length ? "Bild" : documents.length ? "Dokument" : "Datei"), images: imageUris, attachments: attList.length ? attList : undefined, replyTo };
    const aiId = uid("a");
    setPendingImages([]);
    setPendingFiles([]);
    setPendingDocuments([]);
    setReplyingTo(null);
    const aiMsg: Msg = { id: aiId, role: "assistant", text: "", activity: [] };
    patchChat(chatId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? (deriveTitle(message) || c.title) : c.title,
      messages: [...c.messages, userMsg, aiMsg],
      updatedAt: Date.now(),
    }));
    // KI schlägt einen passenden Projektordner vor (nur beim ersten Turn, nicht-blockierend).
    if (isFirst && message.trim()) suggestFolder(chatId, message.trim());
    abortedRef.current.delete(chatId);
    const clientMessageId = uid("m");
    streamStateRef.current[chatId] = { turnId: "", lastSeq: 0, clientMessageId };
    persistStreamState(chatId);
    markBusy(chatId, true);
    // Nach dem Senden zur letzten Nachricht scrollen (einmalig, nicht bei jedem Stream-Zeichen).
    setTimeout(() => {
      isAutoScrollingRef.current = true;
      listRef.current?.scrollToEnd({ animated: true });
      // nach Animationsende Flag zurücksetzen, damit Nutzer-Scrolls wieder erkannt werden
      setTimeout(() => { isAutoScrollingRef.current = false; }, 800);
      setNearBottom(chatId, true);
    }, 60);

    try {
      await streamChat(finalMessage, chatId, aiId, images, documents, undefined, clientMessageId, voice);
    } catch (e) {
      if (abortedRef.current.has(chatId)) {
        abortedRef.current.delete(chatId);
        return; // Nutzer-Abbruch → kein Fallback
      }
      if (e instanceof BackgroundDetached) {
        // Erwarteter Vorgang: App war im Hintergrund, iOS hat die Verbindung gekillt.
        // Der Server-Turn läuft weiter. KEIN Fehler, KEIN Retry-Sturm — beim
        // Zurückkehren lädt der Vordergrund-Sync die Antwort per REST nach.
        turnStillRunning = true;
        setStatusByChat((prev) => ({ ...prev, [chatId]: "App im Hintergrund — Antwort läuft auf dem Server weiter …" }));
        return;
      }
      if (e instanceof StreamInterrupted) {
        // Stream still beendet (EOF ohne done/error): gezielt mit Resume an der
        // Abbruchstelle fortsetzen statt eine „Netzwerk unterbrochen"-Karte zu zeigen.
        // Max. 5 Versuche mit wachsendem Backoff; währenddessen KEINE Fehlerbubble
        // (der Server-Turn läuft unabhängig weiter und wird ggf. später gepollt).
        const backoffs = [1000, 2000, 4000, 8000, 15000];
        for (let attempt = 0; attempt < backoffs.length; attempt++) {
          await waitForForeground();
          if (abortedRef.current.has(chatId)) { setStatusByChat((prev) => ({ ...prev, [chatId]: "" })); return; }
          await new Promise((r) => setTimeout(r, backoffs[attempt]));
          if (abortedRef.current.has(chatId)) { setStatusByChat((prev) => ({ ...prev, [chatId]: "" })); return; }
          const st = streamStateRef.current[chatId];
          setThinkingByChat((p) => ({ ...p, [chatId]: "" }));
          try {
            // lastSeq aus dem REF (nicht aus `e.lastSeq`): ein teilweise erfolgreicher
            // Resume-Versuch hat den Ref bereits weitergezählt — der feste Wert aus dem
            // ersten StreamInterrupted würde Deltas doppelt anhängen (Text-Duplikation).
            await streamChat(finalMessage, chatId, aiId, images, documents, { turnId: st?.turnId || "", lastSeq: st?.lastSeq || 0, canReset: true }, clientMessageId, voice);
            setStatusByChat((prev) => ({ ...prev, [chatId]: "" }));
            return;
          } catch {
            // Erneut abgebrochen oder Resume nicht möglich → nächster Versuch.
          }
        }
        // Nach 5 Fehlversuchen keine harte Fehlerkarte. Läuft der Turn serverseitig noch,
        // busy BEHALTEN (Session-Polling liefert die Antwort nach); ist er tot, erst dann
        // die „wird nachgeliefert"-Karte zeigen (sonst bliebe die Bubble ewig leer).
        if (await serverTurnStillRunning(chatId)) {
          turnStillRunning = true;
          setStatusByChat((prev) => ({ ...prev, [chatId]: "Antwort wird auf dem Server verarbeitet …" }));
          return;
        }
        setErrorCard(chatId, aiId, "Verbindung unterbrochen – Antwort wird nachgeliefert.", true, "stream_interrupted");
        voiceHooks.error?.("Keine Antwort vom Server — bitte nochmal.");
        return;
      }
      // Auto-Wiederherstellung: bei Stream-Abbruch (Server-Neustart/Netz) mehrfach
      // retryen, damit sich der Chat von selbst fängt statt abzubrechen.
      const rawErr = e instanceof Error ? e.message : String(e);
      const retriable = /network|fetch failed|connection lost|timed out|request failed|prematurely closed|aborted|econnreset|socket hang up|bad gateway|502|503|504|5[0-9][0-9]/i.test(rawErr);
      if (retriable) {
        // Im Hintergrund NICHT retryen: iOS tötet die Socket-Verbindung beim Verlassen
        // der App. Erst auf Vordergrund warten — der Server-Turn läuft unabhängig weiter
        // und wird über turnRegistry gepuffert; Resume knüpft dann nahtlos an.
        if (appStateRef.current !== "active") {
          setStatusByChat((prev) => ({ ...prev, [chatId]: "App im Hintergrund — Antwort wird auf dem Server weiterverarbeitet …" }));
        }
        for (let attempt = 1; attempt <= 3; attempt++) {
          await waitForForeground();
          if (abortedRef.current.has(chatId)) { setStatusByChat((prev) => ({ ...prev, [chatId]: "" })); return; }
          try {
            setStatusByChat((prev) => ({ ...prev, [chatId]: `Verbindung verloren — neuer Versuch ${attempt}/3…` }));
            await new Promise((r) => setTimeout(r, 1200));
            if (abortedRef.current.has(chatId)) { setStatusByChat((prev) => ({ ...prev, [chatId]: "" })); return; }
            const st = streamStateRef.current[chatId];
            // Nur bei Voll-Replay (lastSeq=0) zurücksetzen: dann kommen alle Deltas erneut.
            // Bei Delta-Resume bleiben die schon gesehenen Teile des Denkvorgangs stehen.
            if (!st || !st.lastSeq) setThinkingByChat((p) => ({ ...p, [chatId]: "" }));
            if (st && st.turnId) {
              // Resumable: an der Abbruchstelle fortsetzen statt von vorn zu streamen.
              await streamChat(finalMessage, chatId, aiId, images, documents, { turnId: st.turnId, lastSeq: st.lastSeq || 0, canReset: true }, clientMessageId, voice);
            } else {
              // Kein turnId bekannt (App evtl. vor turn_start getötet) → Server sucht
              // den letzten Turn dieses Chats selbst (vermeidet doppeltes Senden).
              await streamChat(finalMessage, chatId, aiId, images, documents, { turnId: "", lastSeq: 0, canReset: true }, clientMessageId, voice);
            }
            setStatusByChat((prev) => ({ ...prev, [chatId]: "" }));
            return;
          } catch {
            // Resume war evtl. nicht möglich (Turn bereits aufgeräumt) → nächster
            // Versuch ohne Resume als Voll-Replay.
            delete streamStateRef.current[chatId];
          }
        }
      }
      setStatusByChat((prev) => ({ ...prev, [chatId]: "" })); // Status nach fehlgeschlagenem Retry löschen (Fallback übernimmt)
      // Fallback: KEIN neuer Turn! Stattdessen den letzten Turn dieses Chats über
      // clientMessageId resumen (Voll-Replay), damit nichts doppelt gesendet wird.
      await waitForForeground();
      if (abortedRef.current.has(chatId)) return;
      const st = streamStateRef.current[chatId];
      try {
        await streamChat(finalMessage, chatId, aiId, images, documents, { turnId: st?.turnId || "", lastSeq: st?.lastSeq || 0, canReset: true }, clientMessageId, voice);
        setStatusByChat((prev) => ({ ...prev, [chatId]: "" }));
      } catch (e2) {
        // Letzter Ausweg: Antwort aus der Server-Session-Datei holen (falls der Turn
        // serverseitig doch fertig wurde). Nur wenn das fehlschlägt → Fehler-Karte.
        const filled = await reloadFromServer(chatId);
        if (filled) { setStatusByChat((prev) => ({ ...prev, [chatId]: "" })); return; }
        // Turn läuft serverseitig noch (letzte Session-Nachricht ist die User-Nachricht)?
        // Dann ist das KEIN Netzwerkfehler — der Server verarbeitet weiter. Busy behalten,
        // das Session-Polling lädt die Antwort, sobald sie fertig ist (kein „Verbindung unterbrochen").
        if (await serverTurnStillRunning(chatId)) {
          turnStillRunning = true;
          setStatusByChat((prev) => ({ ...prev, [chatId]: "Antwort wird auf dem Server verarbeitet — wird automatisch geladen …" }));
          return;
        }
        const rawMsg = e2 instanceof Error ? e2.message : String(e2);
        // Netzwerk-/Stream-Fehler: NICHT aufgeben. iOS tötet die SSE-Verbindung beim
        // App-Wechsel, der Server-Turn läuft unabhängig weiter. Statt „Verbindung
        // unterbrochen" den Chat busy halten und automatisch neu verbinden — das
        // Session-Polling (alle 3 s) holt die Antwort, sobald das Netz zurück ist.
        if (/network|fetch failed|connection lost|request failed|prematurely closed|econnreset|socket hang up|timed out/i.test(rawMsg)) {
          // Ausnahme: die Nachricht hat den Server NACHWEISLICH nie erreicht (Send
          // während Offline). Dann existiert kein Server-Turn, der weiterlaufen könnte —
          // ewig pollen wäre falsch. Retry-Karte statt Reconnect.
          if (!(await messageReachedServer(chatId))) {
            setErrorCard(chatId, aiId, "Nicht gesendet — Netzwerk unterbrochen. Bitte erneut senden.", true, "send_offline");
            voiceHooks.error?.("Keine Antwort vom Server — bitte nochmal.");
            return;
          }
          turnStillRunning = true;
          setStatusByChat((prev) => ({ ...prev, [chatId]: "Verbindung verloren — verbinde automatisch neu …" }));
          return;
        }
        // Echter Server-Fehler (kein Netzproblem) → Fehler-Karte statt Text-Suffix.
        setErrorCard(chatId, aiId, classifyError(rawMsg), isRetryable(rawMsg), "send_failed", rawMsg);
        // Anhänge zurück in die Eingabezeile: nach einem echten Fehler muss der
        // Nutzer Bild/PDF/Audio nicht neu auswählen — ein Tippen auf Senden reicht.
        if (pendingImages.length) setPendingImages(pendingImages);
        if (pendingDocuments.length) setPendingDocuments(pendingDocuments);
        if (pendingFiles.length) setPendingFiles(pendingFiles);
        voiceHooks.error?.("Keine Antwort vom Server — bitte nochmal.");
      }
    } finally {
      setChatThinking(chatId, "");
      if (turnStillRunning) {
        // Turn läuft serverseitig noch → busy behalten (Session-Polling holt die Antwort)
        // und die leere KI-Bubble NICHT entfernen (reloadFromServer füllt sie gleich).
        return;
      }
      markBusy(chatId, false);
      // Weißen Balken vermeiden: nach JEDEM Turn (normal, Fehler, Abbruch, Timeout)
      // verwaiste leere KI-Bubbles entfernen — Nachrichten ohne sichtbaren Inhalt
      // bleiben sonst als leerer weißer Block stehen, auch bei neuen Nachrichten.
      setChats((cs) =>
        cs.map((c) =>
          c.id === chatId
            ? { ...c, messages: c.messages.filter((m) => !isEmptyAi(m)) }
            : c,
        ),
      );
    }
  }

  async function streamChat(message: string, chatId: string, aiId: string, images: { data: string; mediaType: string }[] = [], documents: { name: string; data: string; mimeType: string }[] = [], resume?: { turnId: string; lastSeq: number; canReset?: boolean }, clientMessageId?: string, voice?: boolean) {
    const controller = new AbortController();
    abortControllersRef.current.set(chatId, controller);
    const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
    let lastSeq = resume?.lastSeq ?? 0;
    let turnId = resume?.turnId ?? "";
    // Deaktivierte Slugs nie senden — der Server würde sie still auf flash biegen,
    // dann liefe der Chat mit einem anderen Modell als der Chip anzeigt.
    const requested = chatsRef.current.find((c) => c.id === chatId)?.model || chatModel;
    const model = isModelDeactivated(requested) ? fallbackModelKey() : requested;
    // Voll-Replay (lastSeq=0): bereits gestreamten Teiltext zurücksetzen, damit
    // die Deltas beim Replay nicht doppelt angehängt werden.
    if (resume && lastSeq === 0) {
      patchMsg(chatId, aiId, (m) => ({ ...m, text: "", activity: [] }));
    }
    try {
    const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/chat/stream`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(resume ? { chatId, resume, clientMessageId } : { message, chatId, images, documents, clientMessageId, model, ...(voice ? { voice: true } : {}) }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = (await res.text().catch(() => "")).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
      throw new Error(`HTTP ${res.status} ${errText}`);
    }

    const body = res.body;
    if (!body) throw new Error("Kein Streaming-Body verfügbar");

    const reader = body.getReader();
    const decoder = new Utf8Decoder();
    const parser = new SseParser(MAX_BUFFER_CHARS);
    let finalReply = "";
    let finalActivity: Activity[] = [];
    let finalDil: unknown[] | undefined;
    let finalImages: { uri: string }[] | undefined;
    let doneReceived = false;
    let errorReceived = false;

    const apply = (evt: unknown) => {
      const e = evt as { type?: string; data?: unknown };
      const t = e?.type;
      if (t === "text") {
        const delta = typeof e.data === "string" ? e.data : "";
        patchMsg(chatId, aiId, (m) => ({ ...m, text: (m.text + delta).slice(0, MAX_REPLY_CHARS) }));
        // Sprachmodus liest mit (satzweise Sprachausgabe schon waehrend des Streams)
        if (delta) voiceHooks.delta?.(delta);
      } else if (t === "dil") {
        patchMsg(chatId, aiId, (m) => ({ ...m, dil: Array.isArray(e.data) ? e.data : [] }));
      } else if (t === "thinking") {
        const delta = typeof e.data === "string" ? e.data : "";
        setThinkingByChat((prev) => ({ ...prev, [chatId]: ((prev[chatId] || "") + delta).slice(-MAX_THINKING_CHARS) }));
      } else if (t === "reset") {
        // Server hat den abgebrochenen Turn nach einem Neustart neu gestartet: die
        // bisher gesammelten Fragmente (Text/Denkvorgang/Activity) gehoeren zu einem
        // toten pi-Prozess und wuerden den neuen Text verfaelschen -> Bubble leeren.
        patchMsg(chatId, aiId, (m) => ({ ...m, text: "", activity: [], dil: undefined }));
        setThinkingByChat((prev) => ({ ...prev, [chatId]: "" }));
        setStatusByChat((prev) => ({ ...prev, [chatId]: "" }));
      } else if (t === "status") {
        const msg = typeof e.data === "string" ? e.data : "";
        setStatusByChat((prev) => ({ ...prev, [chatId]: msg }));
      } else if (t === "tool_start") {
        const d = (e.data || {}) as { id?: string; tool?: string; args?: unknown };
        const a: Activity = {
          id: d.id || `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          tool: d.tool || "?",
          status: "running",
          args: d.args,
        };
        patchMsg(chatId, aiId, (m) => ({ ...m, activity: [...(m.activity || []), a] }));
      } else if (t === "tool_update") {
        // Live-Ausgabe eines noch laufenden Tools (Claude zeigt partielles Ergebnis
        // während der Ausführung, nicht erst beim Abschluss).
        const d = (e.data || {}) as { id?: string; tool?: string; partial?: string };
        patchMsg(chatId, aiId, (m) => ({
          ...m,
          activity: (m.activity || []).map((x) =>
            x.id === d.id || (x.status === "running" && x.tool === d.tool)
              ? { ...x, result: (d.partial || "").slice(0, 2000) }
              : x,
          ),
        }));
      } else if (t === "tool_end") {
        const d = (e.data || {}) as { id?: string; tool?: string; error?: boolean; result?: string };
        const err = !!d.error;
        const result = (d.result || "").slice(0, 4000);
        patchMsg(chatId, aiId, (m) => ({
          ...m,
          activity: (m.activity || []).map((x) =>
            x.id === d.id || (x.status === "running" && x.tool === d.tool)
              ? { ...x, status: err ? ("error" as const) : ("ok" as const), result }
              : x,
          ),
        }));
      } else if (t === "permission_required" || t === "permission_resolved") {
        patchMsg(chatId, aiId, (m) => ({ ...m, permissions: applyPermission(m.permissions, t, e.data) }));
      } else if (t === "compaction_start") {
        setStatusByChat((prev) => ({ ...prev, [chatId]: "kompaktiere Kontext …" }));
      } else if (t === "compaction_end") {
        const d = (e.data || {}) as {
          aborted?: boolean;
          tokensBefore?: number | null;
          estimatedTokensAfter?: number | null;
          errorMessage?: string;
        };
        // Kein Erfolg melden, wenn gar nichts kompaktiert wurde: pi antwortet z. B. bei
        // einer bereits kompaktierten Session mit "Nothing to compact (session too small)"
        // und liefert keine Token-Zahlen. Vorher stand dann 4 s "Kontext kompaktiert
        // (0k → 0k Tokens)" in der Statuszeile (gemessen 18.11.2026).
        const hasNumbers = typeof d.tokensBefore === "number" && typeof d.estimatedTokensAfter === "number";
        const ok = !d.aborted && !d.errorMessage && hasNumbers;
        setStatusByChat((prev) => ({ ...prev, [chatId]: ok ? `Kontext kompaktiert (${Math.round((d.tokensBefore as number) / 1000)}k → ${Math.round((d.estimatedTokensAfter as number) / 1000)}k Tokens)` : "" }));
        if (!ok) return;
        setTimeout(() => setStatusByChat((prev) => (prev[chatId]?.startsWith("Kontext kompaktiert") ? { ...prev, [chatId]: "" } : prev)), 4000);
      } else if (t === "auto_retry_start" || t === "summarization_retry_attempt_start") {
        const d = (e.data || {}) as { attempt?: number; maxAttempts?: number };
        setStatusByChat((prev) => ({ ...prev, [chatId]: `Retry ${d.attempt ?? 0}/${d.maxAttempts ?? 0} …` }));
      } else if (t === "auto_retry_end" || t === "summarization_retry_finished") {
        setStatusByChat((prev) => ({ ...prev, [chatId]: "" }));
      } else if (t === "done") {
        doneReceived = true;
        const d = (e.data || {}) as { reply?: string; activity?: Activity[]; dil?: unknown[]; images?: { uri?: string }[]; thinking?: string };
        finalReply = (d.reply || "").trim().slice(0, MAX_REPLY_CHARS);
        // Nach einem Resume (App im Hintergrund/getötet) kommen keine thinking-Deltas mehr:
        // der Server schickt den Denkvorgang im done-Snapshot. Nur setzen, wenn lokal
        // noch nichts da ist — sonst würde ein doppelter Text angehängt.
        if (typeof d.thinking === "string" && d.thinking.trim()) {
          const t2 = d.thinking.slice(-MAX_THINKING_CHARS);
          setThinkingByChat((prev) => ((prev[chatId] || "").trim() ? prev : { ...prev, [chatId]: t2 }));
        }
        finalActivity = (Array.isArray(d.activity) ? d.activity : []).map((a) => ({ ...a, result: (a.result || "").slice(0, 4000) }));
        finalDil = Array.isArray(d.dil) ? d.dil : undefined;
        // Vom Server aus dem Antworttext gehobene Bilder (/generated/…) — relative
        // URIs gegen die Server-URL auflösen, sonst lädt iOS das Bild nicht.
        finalImages = resolveImageList(d.images, serverUrl);
        setStatusByChat((prev) => ({ ...prev, [chatId]: "" }));
        // Turn abgeschlossen: keinen Resume-Anker mehr hinterlassen (Auto-Resume idempotent).
        delete streamStateRef.current[chatId];
        persistStreamState(chatId);
      } else if (t === "resume_unavailable") {
        // Turn ist auf dem Server nicht mehr vorhanden → Voll-Replay erzwingen.
        throw new Error("resume_unavailable");
      } else if (t === "error") {
        errorReceived = true;
        const raw = typeof e.data === "string" ? e.data : String(e.data || "Fehler");
        // Server schickt optional eine praezise Ursache (kind) mit — die hat Vorrang
        // vor der Text-Heuristik, damit z. B. ein Compaction-Race nicht als
        // "Netzwerk unterbrochen" erscheint.
        const kind = typeof (e as { kind?: unknown }).kind === "string" ? String((e as { kind?: string }).kind) : "";
        const KIND_LABEL: Record<string, string> = {
          compaction_busy: "Kontext wird kompaktiert",
          progress_timeout: "Keine Antwort erhalten",
          empty_reply: "Keine Textantwort vom Modell",
          turn_timeout: "Zeitüberschreitung",
          session_reset: "Session zurückgesetzt",
          rate_limit: "Limit erreicht",
          quota: "Konto/Guthaben",
          context_too_long: "Kontext zu lang",
          engine_down: "Server nicht bereit",
          capacity: "Server ausgelastet",
          server_restart: "Server neu gestartet",
        };
        const label = KIND_LABEL[kind] || classifyError(raw);
        setErrorCard(chatId, aiId, label, isRetryable(raw), "sse_error", raw);
        voiceHooks.error?.("Keine Antwort vom Server — bitte nochmal.");
      }
    };

    const handle = (evt: unknown) => {
      const e0 = evt as { type?: string; data?: { turnId?: string }; seq?: number };
      if (typeof e0.seq === "number" && e0.seq > lastSeq) lastSeq = e0.seq;
      if (e0.type === "turn_start" && e0.data && e0.data.turnId) turnId = e0.data.turnId;
      // Sofort-ACK des Servers: die Turn-Id ist schon vergeben, waehrend die Nachricht
      // noch in der Warteschlange steht. Damit hat die App den Resume-Anker sofort
      // (App-Kill/Netzabbruch direkt nach dem Senden verliert nichts mehr).
      if (e0.type === "queued" && e0.data && e0.data.turnId) turnId = e0.data.turnId;
      streamStateRef.current[chatId] = { turnId, lastSeq, clientMessageId };
      if (e0.type === "turn_start" || e0.type === "queued") persistStreamState(chatId);
      apply(evt);
    };

    // Watchdog gegen still gestorbene Verbindungen: Der Server sendet alle 15 s
    // ein Keepalive (SSE-Kommentar `: ping`). Kommen 45 s lang keinerlei Bytes an,
    // ist die Socket-Verbindung still weg (iOS-Hintergrund, Mobilfunk-NAT, WLAN-Roaming)
    // — reader.read() würde sonst ewig hängen. Dann lieber als Netzwerkfehler
    // abbrechen, damit send() den Resume-/Reconnect-Flow anstößt.
    const readWithStallGuard = () => {
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const stall = new Promise<never>((_, reject) => {
        stallTimer = setTimeout(() => {
          // War die App zwischenzeitlich im Hintergrund, ist die Stille ERWARTET
          // (iOS friert Timer UND Socket ein). Dann kein Netzwerkfehler, sondern
          // bewusste Trennung → send() synct beim Vordergrund per REST.
          if (wentBackgroundRef.current) reject(new BackgroundDetached());
          else reject(new Error("Kein Datenfluss — Verbindung still beendet (network)"));
        }, STREAM_STALL_MS);
      });
      return Promise.race([reader.read(), stall]).finally(() => {
        if (stallTimer) clearTimeout(stallTimer);
      });
    };

    while (true) {
      const { done, value } = await readWithStallGuard();
      if (done) break;
      for (const evt of parser.push(decoder.decode(value as Uint8Array))) handle(evt);
    }
    // Stream zu Ende: Rest im Puffer noch verarbeiten (Event ohne finales \n\n).
    for (const evt of parser.flush()) handle(evt);

    // Weder "done" noch "error" empfangen → der Stream wurde still beendet
    // (iOS tötet die SSE-Verbindung im Hintergrund; read() liefert dann oft ein
    // sauberes EOF statt zu rejecten). Als Netzwerkfehler behandeln, damit send()
    // die Resume-/Reload-Logik anstößt — statt die Antwort mit "(keine Antwort)"
    // zu verwerfen. Der Server schreibt IMMER done ODER error vor Stream-Ende.
    if (!doneReceived && !errorReceived) {
      throw new StreamInterrupted(lastSeq);
    }

    const finalText = finalReply.trim() || "(keine Antwort)";
    patchMsg(chatId, aiId, (m) => ({
      ...m,
      // done-Event trägt die VOLLSTÄNDIGE Antwort (Snapshot) — die hat Vorrang vor
      // dem evtl. unvollständigen Stream-Text (abgebrochener Stream/Resume-Lücke).
      text: finalReply.trim() ? finalText : (m.text || finalText),
      activity: m.activity && m.activity.length ? m.activity : finalActivity,
      dil: finalDil !== undefined ? finalDil : m.dil,
      images: finalImages && finalImages.length ? finalImages : m.images,
      // Fehlerkarte eines Zwischenfehlers (Provider-Retry, Tool-Fehler) darf nicht
      // über der fertigen Antwort stehen bleiben → beim Abschluss immer löschen.
      error: undefined,
    }));
    voiceHooks.done?.(finalReply.trim());
    // Leerer Turn: der Sprachmodus wuerde sonst stumm bleiben -> Fehlerkanal.
    // Nur wenn der Server selbst mit done abgeschlossen hat; nach einem error-Event
    // hat der Handler oben schon gemeldet (kein Doppel-Feuern).
    if (doneReceived && !finalReply.trim()) voiceHooks.error?.("Keine Antwort vom Server — bitte nochmal.");
    // Im Sprachmodus liest VoiceMode selbst vor - speakReply wuerde doppelt sprechen
    if (speak && !voiceOpenRef.current && finalReply.trim()) speakReply(finalReply.trim());
    } catch (e) {
      // Nutzer-Abbruch (Stop gedrückt): nur WIRKLICH leere KI-Nachricht entfernen,
      // bereits gestreamten Teilext behalten.
      if (abortedRef.current.has(chatId)) {
        abortedRef.current.delete(chatId); // Cleanup nicht vom return/throw-Flow abhängig machen
        setChats((cs) =>
          cs.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  messages: c.messages.filter(
                    (m) =>
                      m.id !== aiId ||
                      (m.text && m.text.trim()) ||
                      (m.activity && m.activity.length) ||
                      (m.permissions && m.permissions.length) ||
                      (m.images && m.images.length),
                  ),
                }
              : c,
          ),
        );
        return;
      }
      // Timeout (65 min): partiell gestreamten Text behalten + Meldung anhängen.
      if (controller.signal.aborted) {
        // Bewusst getrennt (App ging in den Hintergrund) → KEIN Fehler.
        if (wentBackgroundRef.current) throw new BackgroundDetached();
        patchMsg(chatId, aiId, (m) => ({ ...m, error: { type: "Zeitüberschreitung", retryable: true } }));
        voiceHooks.error?.("Keine Antwort vom Server — bitte nochmal.");
        return;
      }
      // Netzwerk-/HTTP-Fehler: nicht verschlucken → sendChat-Retry + /chat-Fallback greifen.
      throw e;
    } finally {
      clearTimeout(timer);
      if (abortControllersRef.current.get(chatId) === controller) abortControllersRef.current.delete(chatId);
    }
  }

  // Freigabe-Entscheidung des Nutzers an den Server senden (Tool allow/deny).
  async function decidePermission(chatId: string, turnId: string, permissionId: string, decision: "allow" | "deny") {
    const nextStatus: PermissionRequest["status"] = decision === "allow" ? "allowed" : "denied";
    // Optimistisch markieren, damit die Karte sofort reagiert.
    patchChat(chatId, (c) => ({
      ...c,
      messages: c.messages.map((m) => ({
        ...m,
        permissions: (m.permissions || []).map((p) =>
          p.permissionId === permissionId ? { ...p, status: nextStatus } : p,
        ),
      })),
    }));
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/chat/permission`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ chatId, turnId, permissionId, decision }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // POST fehlgeschlagen → optimistische Markierung zurücknehmen, damit der
      // Nutzer es erneut versuchen kann (Server-Timeout → deny).
      patchChat(chatId, (c) => ({
        ...c,
        messages: c.messages.map((m) => ({
          ...m,
          permissions: (m.permissions || []).map((p) =>
            p.permissionId === permissionId ? { ...p, status: "pending" } : p,
          ),
        })),
      }));
    }
  }

  async function abort(chatId?: string) {
    if (chatId) {
      abortedRef.current.add(chatId);
      abortControllersRef.current.get(chatId)?.abort();
      abortControllersRef.current.delete(chatId);
      // Stop räumt auch den „verbinde automatisch neu"-Zustand auf (im Polling-Modus
      // gibt es keinen aktiven AbortController) → busy + Status sofort beenden.
      markBusy(chatId, false);
      setStatusByChat((prev) => ({ ...prev, [chatId]: "" }));
    }
    try {
      await fetch(`${serverUrl.replace(/\/+$/, "")}/api/abort`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ chatId: chatId || "" }),
      });
    } catch {
      // ignorieren
    }
  }

  // Native Spracherkennung (Diktieren) — transkribiert ins Eingabefeld.
  // Der Text bleibt stehen und editierbar; der Nutzer schickt manuell mit ➤ ab.
  useSpeechRecognitionEvent("start", () => {
    setListening(true);
    finalSegmentsRef.current = "";
    dictationBaseRef.current = inputRef.current.trim(); // schon Getipptes behalten
  });
  useSpeechRecognitionEvent("result", (event) => {
    // event.results sind Alternativen (maxAlternatives) — results[0] ist die beste.
    const transcript = (event.results[0]?.transcript ?? "").trim();
    const base = dictationBaseRef.current;
    if (event.isFinal) {
      // iOS 18 liefert Finals segmentweise (mit prependetem Leerzeichen ab dem
      // 2. Segment), Android ebenso → in beiden Fällen anhängen statt überschreiben.
      finalSegmentsRef.current = finalSegmentsRef.current
        ? `${finalSegmentsRef.current} ${transcript}`
        : transcript;
      setInput([base, finalSegmentsRef.current].filter(Boolean).join(" "));
    } else {
      // Interim live anzeigen: bisherige finale Segmente + aktuelles Partial
      const interim = [finalSegmentsRef.current, transcript].filter(Boolean).join(" ");
      setInput([base, interim].filter(Boolean).join(" "));
    }
  });
  useSpeechRecognitionEvent("end", () => {
    setListening(false);
    const base = dictationBaseRef.current;
    const text = [base, finalSegmentsRef.current].filter(Boolean).join(" ").trim();
    // Text bleibt im Eingabefeld – Nutzer kann korrigieren und dann ➤ drücken
    if (text) setInput(text);
    finalSegmentsRef.current = "";
    dictationBaseRef.current = "";
  });
  useSpeechRecognitionEvent("error", (event) => {
    setListening(false);
    const base = dictationBaseRef.current;
    const recognized = finalSegmentsRef.current;
    if (event.error === "no-speech" || event.error === "aborted") {
      // nichts erkannt / abgebrochen – Text im Feld bleibt unverändert
    } else {
      const msg = `Spracherkennung: ${event.message || event.error || "unbekannt"}`;
      // Erkannte Finals behalten, Meldung anhängen statt Feldinhalt ersetzen
      const text = [base, recognized].filter(Boolean).join(" ");
      setInput(text ? `${text}\n${msg}` : msg);
    }
    finalSegmentsRef.current = "";
    dictationBaseRef.current = "";
  });

  async function toggleMic() {
    if (listening) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        const base = inputRef.current.trim();
        setInput(base ? `${base}\nBitte Mikrofon & Spracherkennung in den Einstellungen erlauben.` : "Bitte Mikrofon & Spracherkennung in den Einstellungen erlauben.");
        return;
      }
      ExpoSpeechRecognitionModule.start({
        lang: "de-DE",
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        iosTaskHint: "dictation",
      });
    } catch (e) {
      setListening(false);
      const base = inputRef.current.trim();
      const msg = `Spracherkennung konnte nicht gestartet werden: ${e instanceof Error ? e.message : String(e)}`;
      setInput(base ? `${base}\n${msg}` : msg);
    }
  }

  async function loadTasks() {
    tasksAbortRef.current?.abort(); // vorherigen Poll abbrechen (kein konkurrierendes setTaskList)
    const ctrl = new AbortController();
    tasksAbortRef.current = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/tasks`, {
        headers: authHeaders(),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTaskList(Array.isArray(data.tasks) ? data.tasks : []);
      setScheduleList(Array.isArray(data.schedules) ? data.schedules : []);
    } catch {
      // Server nicht erreichbar – ignorieren
    } finally {
      clearTimeout(timer);
      if (tasksAbortRef.current === ctrl) tasksAbortRef.current = null;
    }
  }

  async function addTask() {
    const message = taskInput.trim();
    if (!message) return;
    setTaskInput("");
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      loadTasks();
    } catch {
      setTaskInput(message); // Eingabe wiederherstellen – nichts verlieren
    }
  }

  async function addSchedule() {
    const message = schedInput.trim();
    if (!message) return;
    const cron =
      schedPreset === "custom"
        ? schedCustomCron.trim()
        : presetCron(schedPreset, { time: schedTime, day: schedDay, dayOfMonth: Number(schedDom) || 1 });
    if (!cron) {
      Alert.alert("Zeitplan fehlerhaft", "Bitte einen gültigen Cron-Ausdruck angeben (5 Felder: Minute Stunde Tag Monat Wochentag).");
      return;
    }
    if (schedPreset === "custom" && !/^(\S+\s+){4}\S+$/.test(cron)) {
      Alert.alert("Zeitplan fehlerhaft", "Ungültiger Cron-Ausdruck — 5 Felder erwartet (Minute Stunde Tag Monat Wochentag).");
      return;
    }
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/schedule`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ message, cron }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        Alert.alert("Zeitplan fehlerhaft", (err && err.error) || `HTTP ${res.status}`);
        return;
      }
      setSchedInput("");
      loadTasks();
    } catch {
      // Server nicht erreichbar – Eingabe stehen lassen
    }
  }

  async function deleteSchedule(id: string) {
    try {
      await fetch(`${serverUrl.replace(/\/+$/, "")}/schedule/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
    } catch {
      // ignorieren
    }
    loadTasks();
  }

  // Fehlgeschlagene KI-Antwort erneut anstoßen: gleiche Bubble wiederverwenden (kein Duplikat).
  function retryMessage(aiMsg: Msg) {
    const chat = chats.find((c) => c.id === activeChatId);
    if (!chat || busyChatIds.has(chat.id)) return;
    const idx = chat.messages.findIndex((m) => m.id === aiMsg.id);
    const userMsg = [...chat.messages.slice(0, idx)].reverse().find((m) => m.role === "user");
    if (!userMsg) return;
    // Bild-Generierung: nicht als Chat-Turn wiederholen, sondern Bild neu erzeugen.
    if (aiMsg.error?.type?.startsWith("Bild-Generierung")) {
      patchMsg(chat.id, aiMsg.id, (m) => ({ ...m, text: "Bild wird erstellt …", images: undefined, error: undefined }));
      regenerateImage(chat.id, aiMsg.id, userMsg.text.trim());
      return;
    }
    const text = userMsg.text.trim();
    // Reine Anhang-Nachrichten ("Bild"/"PDF"/"Datei") können ohne
    // die Base64-Anhänge nicht korrekt wiederholt werden → Retry unterdrücken.
    if (!text || /^(Bild|PDF|Datei)$/.test(text)) return;
    // Reply-Kontext wiederherstellen (wie in send()) und die Bubble vollständig zurücksetzen
    // (auch alte images/dil/permissions der vorherigen Antwort, sonst erscheinen sie erneut).
    const fullText = userMsg.replyTo
      ? `[Antwort auf: "${userMsg.replyTo.text.replace(/\n+/g, " ").trim().slice(0, 200)}"]\n${text}`
      : text;
    patchMsg(chat.id, aiMsg.id, (m) => ({ ...m, text: "", activity: [], images: undefined, dil: undefined, permissions: undefined, error: undefined }));
    markBusy(chat.id, true);
    setChatThinking(chat.id, "");
    abortedRef.current.delete(chat.id);
    // Resume-Anker setzen, damit ein abgebrochener Retry-Stream fortgesetzt werden kann.
    const clientMessageId = uid("m");
    streamStateRef.current[chat.id] = { turnId: "", lastSeq: 0, clientMessageId };
    persistStreamState(chat.id);
    streamChat(fullText, chat.id, aiMsg.id, [], [], undefined, clientMessageId).catch((e) => {
      const raw = e instanceof Error ? e.message : String(e);
      patchMsg(chat.id, aiMsg.id, (m) => ({ ...m, error: { type: classifyError(raw), retryable: isRetryable(raw) } }));
    }).finally(() => {
      markBusy(chat.id, false);
      setChatThinking(chat.id, "");
    });
  }

  // Selbst-Diagnose: eine Blase, die die Höhengrenze reißt, wird EINMAL an den
  // Server gemeldet (Log: /opt/pi-app/logs/app-diag.log). Damit ist ohne Screenshot
  // nachweisbar, WELCHE Nachricht den weißen Riesenblock erzeugt.
  const diagSentRef = useRef<Set<string>>(new Set());
  function reportTooBig(m: Msg, height: number) {
    const chatId = activeChatId || "";
    const key = `${chatId}:${m.id}`;
    if (diagSentRef.current.has(key)) return;
    diagSentRef.current.add(key);
    const text = m.text || "";
    const payload = {
      chatId,
      msgId: m.id,
      role: m.role,
      height: Math.round(height),
      textLen: text.length,
      lineCount: text.split("\n").length,
      maxToken: Math.max(0, ...text.split(/\s+/).map((w) => w.length)),
      activity: (m.activity || []).length,
      permissions: (m.permissions || []).length,
      dil: Array.isArray(m.dil) ? m.dil.length : 0,
      images: (m.images || []).length,
      head: text.slice(0, 160),
    };
    fetch(`${serverUrl.replace(/\/+$/, "")}/api/diag`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    }).catch(() => {
      // Diagnose darf die UI nie stören
    });
  }

  function renderMessage({ item }: { item: Msg }) {
    const messages = activeChat?.messages || [];
    const isLast = messages.length > 0 && messages[messages.length - 1].id === item.id;
    return (
      <MessageBubble
        item={item}
        isLast={isLast}
        isBusy={isThisChatBusy}
        onReply={setReplyingTo}
        onRetry={retryMessage}
        onDilAction={(t) => void send(t)}
        onTooBig={reportTooBig}
        onPermission={(p, decision) => decidePermission(activeChat?.id || "", p.turnId, p.permissionId, decision)}
      />
    );
  }

  function renderChatItem({ item }: { item: Chat }) {
    const last = item.messages[item.messages.length - 1];
    const preview = last
      ? last.text.replace(/\n/g, " ").slice(0, 80)
      : item.preview
        ? item.preview.replace(/\n/g, " ").slice(0, 80)
        : item.remote
          ? "Verlauf vom Server"
          : "Neue Unterhaltung";
    const isActive = item.id === activeChatId;
    // Status-Ampel: rot = arbeitet (busy), grün = fertig (hat Nachrichten), weiß = unbenutzt (leer)
    const isBusy = busyChatIds.has(item.id);
    const hasMessages = item.messages.length > 0;
    const statusColor = isBusy ? colors.danger : hasMessages ? colors.success : "#ffffff";
    // Herkunft: WhatsApp / Terminal / anderes Gerät. Ohne Markierung sieht man nicht,
    // welcher Verlauf von wo kommt — und genau das war der Punkt.
    const srcBadge =
      item.source === "whatsapp"
        ? { text: "WhatsApp", color: "#25D366" }
        : item.source === "terminal"
          ? { text: "Terminal", color: "#8A8A8E" }
          : item.remote
            ? { text: "Server", color: colors.accent }
            : null;
    const avatarIcon = item.source === "whatsapp" ? "logo-whatsapp" : item.source === "terminal" ? "terminal-outline" : "chatbubbles-outline";
    return (
      <Pressable
        onPress={() => openChat(item.id)}
        onLongPress={() => (item.readOnly ? undefined : setAssignChatId(item.id))}
        accessibilityLabel={`${item.title || "Chat"}${item.source && item.source !== "app" ? `, ${item.source === "whatsapp" ? "WhatsApp" : "Terminal"}-Verlauf` : ""}`}
        accessibilityHint={item.readOnly ? "Nur lesbar" : "Öffnet den Verlauf; lange drücken zum Verschieben in einen Ordner"}
        selected={isActive}
        style={[styles.chatItem, isActive && styles.chatItemActive]}
      >
        <View style={[styles.chatAvatar, item.source === "whatsapp" && { backgroundColor: "#E7F9EE" }, item.source === "terminal" && { backgroundColor: "#EFEFF2" }]}>
          <Ionicons name={avatarIcon as any} size={20} color={item.source === "whatsapp" ? "#128C4A" : item.source === "terminal" ? "#5D5D5D" : colors.accent} />
          <View style={[styles.chatStatusDot, { backgroundColor: statusColor }]} />
        </View>
        <View style={styles.chatInfo}>
          <View style={styles.chatTitleRow}>
            <Text style={styles.chatTitle} numberOfLines={1}>{item.title}</Text>
            {srcBadge ? (
              <View style={[styles.srcBadge, { borderColor: srcBadge.color }]}>
                <Text style={[styles.srcBadgeText, { color: srcBadge.color }]}>{srcBadge.text}</Text>
              </View>
            ) : null}
            {item.readOnly ? <Ionicons name="lock-closed" size={11} color={colors.muted} /> : null}
          </View>
          <Text style={styles.chatPreview} numberOfLines={1}>{preview}</Text>
        </View>
        <View style={styles.chatRight}>
          <Text style={styles.chatTime}>{formatTime(item.updatedAt)}</Text>
          <View style={styles.chatRightRow}>
            {item.readOnly ? null : (
              <Pressable onPress={() => { setRenameChatId(item.id); setRenameInput(item.title); }} hitSlop={8} accessibilityRole="button" accessibilityLabel="Bearbeiten">
                <Ionicons name="pencil" size={13} color={colors.muted} />
              </Pressable>
            )}
            <Pressable onPress={() => (item.remote || item.readOnly ? deleteRemoteChat(item) : deleteChat(item.id))} hitSlop={8} accessibilityRole="button" accessibilityLabel="Chat löschen">
              <Ionicons name="close" size={14} color={colors.danger} />
            </Pressable>
          </View>
        </View>
      </Pressable>
    );
  }

  function renderTask(task: Task) {
    const statusInfo: Record<string, { label: string; color: string }> = {
      pending: { label: "wartet", color: colors.muted },
      running: { label: "läuft…", color: colors.accent },
      done: { label: "fertig", color: colors.success },
      error: { label: "fehler", color: colors.danger },
    };
    const s = statusInfo[task.status] || statusInfo.pending;
    return (
      <View key={task.id} style={styles.taskCard}>
        <View style={styles.taskHeader}>
          <Text style={styles.taskMessage} numberOfLines={2}>{task.message}</Text>
          <View style={[styles.taskBadge, { backgroundColor: s.color }]}>
            <Text style={styles.taskBadgeText}>{s.label}</Text>
          </View>
        </View>
        {task.result ? (
          <Text style={styles.taskResult} numberOfLines={4}>{task.result}</Text>
        ) : null}
      </View>
    );
  }

  const sortedChats = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const folderScoped = folderFilter ? sortedChats.filter((c) => c.folderId === folderFilter) : sortedChats;
  // Server-Verläufe (andere Geräte, WhatsApp, Terminal) hinten dran; in einem Ordner
  // haben sie nichts zu suchen (sie gehören keinem Projektordner).
  const mergedChats = [...folderScoped, ...(folderFilter ? [] : remoteChats)].sort((a, b) => b.updatedAt - a.updatedAt);
  const filteredChats =
    chatFilter === "all"
      ? mergedChats
      : chatFilter === "app"
        ? mergedChats.filter((c) => (c.source || "app") === "app" && !c.remote)
        : chatFilter === "server"
          ? mergedChats.filter((c) => (c.source || "app") === "app" && c.remote)
          : mergedChats.filter((c) => (c.source || "app") === chatFilter);

  // Titel-/Vorschau-Suche ueber der Liste: Titel + letzte Nachricht, Gross-/Kleinschreibung egal.
  // Volltext ueber alle Nachrichten folgt in Welle 2 (Index + Treffer-Snippets).
  // Volltext-Index ueber Titel, Vorschau und Nachrichten (nur lokale Verlaeufe —
  // Server-Verlaeufe haben hier keinen Text, sie bleiben ueber /api/chats suchbar).
  const searchDocs = useMemo(
    () => buildIndex([...folderScoped, ...(folderFilter ? [] : remoteChats)].map((c) => ({
      id: c.id,
      title: c.title,
      preview: c.preview,
      updatedAt: c.updatedAt,
      messages: c.messages,
    }))),
    [folderScoped, remoteChats, folderFilter],
  );
  const searchedChats = (() => {
    const q = chatSearch.trim();
    if (!q) return filteredChats;
    const lower = q.toLowerCase();
    const fullText = matchingChatIds(searchDocs, q);
    return filteredChats.filter(
      (c) => ((c.title || "") + " " + (c.preview || "")).toLowerCase().includes(lower) || fullText.has(c.id),
    );
  })();

  // Tastatur oeffnen: die Liste selbst resized nicht (der Eingabebalken macht das),
  // deshalb bleibt die letzte Bubble sonst hinter der Tastatur. ChatGPT haelt sie
  // sichtbar — nur wenn man schon unten stand, nie beim Lesen alter Nachrichten.
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", () => {
      if (!activeChatId) return;
      if (!isNearBottom(activeChatId)) return;
      listRef.current?.scrollToEnd({ animated: false });
    });
    return () => sub.remove();
  }, [activeChatId]);
  // Server-Verlauf löschen: liegt nur auf dem Hetzner (anderes Gerät, WhatsApp-Bot,
  // Terminal-Historie). Immer mit Rückfrage, denn löschen ist endgültig — bei
  // Terminal-Sessions ist es echte pi-Historie.
  function deleteRemoteChat(chat: Chat) {
    Alert.alert(
      chat.source === "terminal" ? "Terminal-Verlauf löschen?" : "Server-Verlauf löschen?",
      chat.source === "terminal"
        ? `"${chat.title}" wird auf dem Server gelöscht (pi-Historie ist danach weg).`
        : `"${chat.title}" wird auf dem Server gelöscht.`,
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Löschen",
          style: "destructive",
          onPress: async () => {
            const base = serverUrl.replace(/\/+$/, "");
            const url = `${base}/api/session/${encodeURIComponent(chat.id)}`;
            try {
              let r = await fetch(url, { method: "DELETE", headers: authHeaders() });
              if (r.status === 409) {
                // Laufender Chat: erst abbrechen, dann erneut versuchen.
                await fetch(`${base}/api/abort`, {
                  method: "POST",
                  headers: authHeaders(),
                  body: JSON.stringify({ chatId: chat.id }),
                }).catch(() => {});
                r = await fetch(url, { method: "DELETE", headers: authHeaders() });
              }
              if (!r.ok) {
                const d = await r.json().catch(() => ({} as any));
                Alert.alert("Löschen fehlgeschlagen", String(d?.error || `HTTP ${r.status}`));
                return;
              }
              setRemoteChats((cs) => cs.filter((c) => c.id !== chat.id));
              if (activeChatId === chat.id) setActiveChatId(null);
            } catch (e: any) {
              Alert.alert("Löschen fehlgeschlagen", String(e?.message || e));
            }
          },
        },
      ],
    );
  }

  function renderMetaList(list: { id: string; name: string; description?: string; cron?: string }[], title: string) {
    if (list.length === 0) {
      return (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Keine {title}</Text>
          <Text style={styles.emptyText}>Auf dem Server sind aktuell keine {title} verfügbar.</Text>
        </View>
      );
    }
    return (
      <View style={styles.metaList}>
        {list.map((m) => (
          <View key={m.id} style={styles.metaCard}>
            <Text style={styles.metaName}>{m.name}</Text>
            {m.description ? <Text style={styles.metaDesc} numberOfLines={3}>{m.description}</Text> : null}
            {m.cron ? <Text style={styles.metaCron}>{cronLabel(m.cron)}</Text> : null}
          </View>
        ))}
      </View>
    );
  }

  function renderConnectors() {
    return (
      <View style={styles.connectorsWrap}>
        <Text style={styles.pluginsHint}>Verbundene Apps & Connectoren. Neue Connectoren mit einem spezialisierten Agenten verbinden.</Text>
        <Text style={styles.pluginsSectionTitle}>Verbundene Plattformen</Text>
        {meta.platforms.length === 0 ? (
          <Text style={styles.pluginsEmpty}>Status wird geladen …</Text>
        ) : (
          <View style={styles.metaList}>
            {meta.platforms.map((p) => (
              <View key={p.id} style={styles.metaCard}>
                <View style={styles.metaCardHeader}>
                  <Text style={styles.metaName}>{p.name}</Text>
                  <View style={[styles.metaDot, { backgroundColor: p.status === "ok" ? colors.success : p.status === "warning" ? colors.warning : colors.danger }]} />
                </View>
                {p.detail ? <Text style={styles.metaDesc} numberOfLines={2}>{p.detail}</Text> : null}
              </View>
            ))}
          </View>
        )}
        <Text style={styles.pluginsSectionTitle}>Verfügbare Connectoren</Text>
        {meta.connectors.length === 0 ? (
          <Text style={styles.pluginsEmpty}>Keine MCP-Connectoren konfiguriert.</Text>
        ) : (
          <View style={styles.metaList}>
            {meta.connectors.map((c) => (
              <View key={c.id} style={styles.metaCard}>
                <View style={styles.metaCardHeader}>
                  <Text style={styles.metaName}>{c.name}</Text>
                  <View style={[styles.metaDot, { backgroundColor: c.enabled === false ? colors.muted : colors.success }]} />
                </View>
                {c.description ? <Text style={styles.metaDesc} numberOfLines={3}>{c.description}</Text> : null}
              </View>
            ))}
          </View>
        )}
        <Text style={styles.pluginsSectionTitle}>Eigene Connectors</Text>
        {connectorsList.length === 0 ? (
          <Text style={styles.pluginsEmpty}>Noch keine eigenen Connectors.</Text>
        ) : (
          <View style={styles.metaList}>
            {connectorsList.map((c) => (
              <View key={c.id} style={styles.metaCard}>
                <View style={styles.metaCardHeader}>
                  <Text style={styles.metaName}>{c.name}</Text>
                  <Pressable onPress={() => deleteConnector(c.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Connector löschen">
                    <Ionicons name="close" size={14} color={colors.danger} />
                  </Pressable>
                </View>
                {c.agent ? <Text style={styles.metaAgent}>Agent: {c.agent}</Text> : null}
                {c.description ? <Text style={styles.metaDesc} numberOfLines={3}>{c.description}</Text> : null}
              </View>
            ))}
          </View>
        )}
        <View style={styles.connectorForm}>
          <Text style={styles.pluginsSectionTitle}>Neuen Connector anlegen</Text>
          <TextInput
            style={styles.schedMessageInput}
            value={connectorForm.name}
            onChangeText={(t) => setConnectorForm((f) => ({ ...f, name: t }))}
            placeholder="Name (z. B. „Instagram-Connector“)"
            placeholderTextColor={colors.muted}
          />
          <TextInput
            style={styles.schedMessageInput}
            value={connectorForm.agent}
            onChangeText={(t) => setConnectorForm((f) => ({ ...f, agent: t }))}
            placeholder="Spezialisierter Agent (z. B. „instagram“)"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.schedMessageInput}
            value={connectorForm.description}
            onChangeText={(t) => setConnectorForm((f) => ({ ...f, description: t }))}
            placeholder="Beschreibung (optional)"
            placeholderTextColor={colors.muted}
            multiline
          />
          <Pressable onPress={addConnector} disabled={!connectorForm.name.trim()} style={[styles.schedAddBtn, !connectorForm.name.trim() && styles.sendBtnDisabled]} accessibilityRole="button" accessibilityLabel="Connector anlegen">
            <View style={styles.chipRow}>
              <Ionicons name="add" size={15} color="#fff" />
              <Text style={styles.schedAddText}>Connector anlegen</Text>
            </View>
          </Pressable>
        </View>
      </View>
    );
  }

  function renderFolders() {
    if (folders.length === 0) {
      return (
        <View style={styles.foldersBar}>
          <Pressable onPress={() => openFolderModal("create")} style={styles.folderChip} accessibilityRole="button" accessibilityLabel="Neuer Ordner">
            <Ionicons name="folder-open-outline" size={14} color={colors.accent} />
            <Text style={styles.folderChipText}>Ordner anlegen</Text>
          </Pressable>
        </View>
      );
    }
    const ordered = [...folders].sort((a, b) => a.order - b.order);
    return (
      <View style={styles.foldersBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.foldersBarContent}>
          <Pressable onPress={() => setFolderFilter(null)} style={[styles.folderChip, folderFilter === null && styles.folderChipActive]} accessibilityRole="button" accessibilityLabel="Ordner-Filter aufheben">
            <Text style={[styles.folderChipText, folderFilter === null && styles.folderChipTextActive]}>Alle</Text>
          </Pressable>
          {ordered.map((f) => (
            <Pressable key={f.id} onPress={() => setFolderFilter(folderFilter === f.id ? null : f.id)} onLongPress={() => openFolderModal("edit", f.id)} style={[styles.folderChip, folderFilter === f.id && styles.folderChipActive]} accessibilityRole="button" accessibilityLabel={`Ordner ${f.name}`} accessibilityState={{ selected: folderFilter === f.id }}>
              <Text style={[styles.folderChipText, folderFilter === f.id && styles.folderChipTextActive]}>{f.parentId ? "↳ " : ""}{f.name}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => openFolderModal("create")} style={styles.folderChip} accessibilityRole="button" accessibilityLabel="Neu">
            <Ionicons name="add" size={14} color={colors.accent} />
            <Text style={styles.folderChipText}>Ordner</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <VoiceMode
        visible={voiceOpen}
        serverUrl={serverUrl}
        authHeaders={authHeaders}
        busy={activeChatId ? busyChatIds.has(activeChatId) : false}
        colors={colors}
        onSend={(text: string, voice?: boolean) => { void send(text, voice); }}
        onInterrupt={() => { if (activeChatId) void abort(activeChatId); }}
        onClose={() => setVoiceOpen(false)}
      />

      <View style={styles.header}>
        {activeChatId && tab === "chats" ? (
          <Pressable onPress={() => openChat(null)} style={styles.backBtn} hitSlop={8} accessibilityRole="button" accessibilityLabel="Zurück">
            <Ionicons name="chevron-back" size={24} color={colors.accent} />
          </Pressable>
        ) : (
          <View style={styles.logo}>
            <Text style={styles.logoText}>K</Text>
          </View>
        )}
        <View style={styles.headerTitles}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {activeChatId && tab === "chats" ? activeChat?.title || "Chat" : "KittyAI"}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {activeChatId && tab === "chats" ? (
            <Pressable onPress={() => deleteChat(activeChatId)} style={styles.chip} hitSlop={6} accessibilityLabel="Chat löschen">
              <Ionicons name="trash-outline" size={16} color={colors.danger} />
            </Pressable>
          ) : (
            <Pressable onPress={() => newChat()} style={[styles.chip, styles.chipNew]} hitSlop={6} accessibilityLabel="Neuer Chat">
              <View style={styles.chipRow}>
                <Ionicons name="add" size={15} color="#fff" />
                <Text style={styles.chipNewText}>Neu</Text>
              </View>
            </Pressable>
          )}
          <Pressable onPress={() => setSpeak((s) => !s)} style={[styles.iconBtn, speak && styles.chipActive]} hitSlop={6} accessibilityLabel={speak ? "Antworten vorlesen: an" : "Antworten vorlesen: aus"}>
            <Ionicons name={speak ? "volume-high-outline" : "chatbubble-outline"} size={17} color={speak ? colors.accent : colors.text} />
          </Pressable>
        </View>
      </View>

      <TabsHeader
        items={[
          { key: "chats", label: "Chats", icon: "chatbubbles-outline" },
          { key: "plugins", label: "Plugins", icon: "grid-outline" },
          { key: "reha", label: "Reha", icon: "fitness-outline" },
        ]}
        value={tab === "plugins" ? "plugins" : tab === "reha" ? "reha" : "chats"}
        onChange={(k) => setTab(k)}
      />

      {tab === "reha" ? (
        <RehaTab serverUrl={serverUrl} authHeaders={authHeaders} />
      ) : tab === "chats" ? (
        activeChat ? (
          <>
            <FlatList ref={listRef} maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
              data={activeChat.messages}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              refreshControl={<PullToRefresh refreshing={refreshingChat} onRefresh={() => { void refreshActiveChat(); }} />}
              keyExtractor={(m) => m.id}
              renderItem={renderMessage}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              onScroll={(e) => {
                if (isAutoScrollingRef.current) return;
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                const dist = contentSize.height - (contentOffset.y + layoutMeasurement.height);
                setNearBottom(activeChat.id, dist < 80);
              }}
              onMomentumScrollEnd={() => {
                isAutoScrollingRef.current = false;
              }}
              onContentSizeChange={() => {
                if (!isNearBottom(activeChat.id)) return;
                const chatId = activeChat.id;
                const prev = contentSizeDebounceRef.current.get(chatId);
                if (prev) clearTimeout(prev);
                const t = setTimeout(() => {
                  isAutoScrollingRef.current = true;
                  requestAnimationFrame(() => {
                    listRef.current?.scrollToEnd({ animated: false });
                    setNearBottom(chatId, true);
                    isAutoScrollingRef.current = false;
                  });
                  contentSizeDebounceRef.current.set(chatId, null);
                }, 40);
                contentSizeDebounceRef.current.set(chatId, t);
              }}
              scrollEventThrottle={32}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>Hallo</Text>
                  <Text style={styles.emptyText}>Wie kann ich dir heute helfen?</Text>
                  <View style={styles.suggestionRow}>
                    {["Fasse den Tag zusammen", "Recherchiere etwas für mich", "Schreibe mir eine Nachricht", "Erkläre mir ein Thema"].map((s) => (
                      <Pressable key={s} accessibilityRole="button" accessibilityLabel={`Vorschlag: ${s}`} onPress={() => send(s)} style={styles.suggestionChip}>
                        <Text style={styles.suggestionChipText}>{s}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              }
              ListFooterComponent={
                isThisChatBusy ? (
                  thisThinking ? (
                    <ThinkingBlock text={thisThinking} />
                  ) : (
                    <View style={styles.thinking}>
                      <ActivityIndicator color={colors.accent} size="small" />
                      {thisStatus.startsWith("kompaktiere Kontext") ? (
                        <CompactionBar />
                      ) : thisStatus === "pi denkt …" ? (
                        // Standard-Denkphase (lange Prefill-/Reasoning-Stille bei den
                        // Goeran-Modellen): tickende Sekunden statt statischem Text, damit
                        // klar ist, dass die App lebt und NICHT die Verbindung abgebrochen ist.
                        <ElapsedLabel style={styles.thinkingText} />
                      ) : thisStatus ? (
                        <RotatingShimmerText messages={[thisStatus]} intervalMs={2000} style={styles.thinkingText} />
                      ) : listening ? (
                        <ShimmerText style={styles.thinkingText} durationMs={1400}>höre zu …</ShimmerText>
                      ) : (
                        <ElapsedLabel style={styles.thinkingText} />
                      )}
                    </View>
                  )
                ) : null
              }
            />

            {folderSuggestion && folderSuggestion.chatId === activeChatId ? (
              <View style={styles.folderSuggestion}>
                <Ionicons name="folder-open-outline" size={16} color={colors.accent} />
                <Text style={styles.folderSuggestionText} numberOfLines={1}>In Ordner „{folderSuggestion.name}“ verschieben?</Text>
                <Pressable onPress={() => assignChatToFolder(folderSuggestion.chatId, folderSuggestion.folderId)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Vorschlag annehmen">
                  <Text style={styles.folderSuggestionYes}>Ja</Text>
                </Pressable>
                <Pressable onPress={() => setFolderSuggestion(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Schließen">
                  <Ionicons name="close" size={16} color={colors.muted} />
                </Pressable>
              </View>
            ) : null}

            {activeChat.readOnly ? (
              <View style={styles.readOnlyBar}>
                <Ionicons name="lock-closed-outline" size={14} color={colors.muted} />
                <Text style={styles.readOnlyText} numberOfLines={2}>
                  {activeChat.source === "terminal"
                    ? "Terminal-Verlauf — hier nur lesbar. Weiterschreiben im Terminal (pi --resume)."
                    : "WhatsApp-Verlauf — Antworten laufen über WhatsApp."}
                </Text>
                <Pressable onPress={() => forkReadOnlyChat(activeChat)} hitSlop={8} style={styles.readOnlyBtn} accessibilityRole="button" accessibilityLabel="Als eigenen Chat fortsetzen">
                  <Text style={styles.readOnlyBtnText}>Übernehmen</Text>
                </Pressable>
              </View>
            ) : null}

            <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
              {replyingTo ? (
                <View style={styles.replyBar}>
                  <View style={styles.replyBarQuote}>
                    <Text style={styles.replyBarLabel}>Antwort auf:</Text>
                    <Text style={styles.replyBarText} numberOfLines={1}>
                      {replyingTo.text.replace(/\n+/g, " ").trim().slice(0, 120)}
                    </Text>
                  </View>
                  <Pressable onPress={() => setReplyingTo(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Antwort abbrechen">
                    <Ionicons name="close" size={16} color={colors.danger} />
                  </Pressable>
                </View>
              ) : null}
              {(pendingImages.length > 0 || pendingFiles.length > 0 || pendingDocuments.length > 0) && (
                <View style={styles.attachPreview}>
                  {pendingImages.map((im, i) => (
                    <View key={`img${i}`} style={styles.attachChipWrap}>
                      <Image source={{ uri: im.uri }} style={styles.attachThumb} resizeMode="cover" />
                    </View>
                  ))}
                  {pendingDocuments.map((d, i) => (
                    <View key={`doc${i}`} style={styles.attachChipWrap}>
                      <Ionicons name="document-text-outline" size={15} color={colors.accent} />
                      <Text style={styles.attachChip} numberOfLines={1}>{d.name}</Text>
                    </View>
                  ))}
                  {pendingFiles.map((f, i) => (
                    <View key={`file${i}`} style={styles.attachChipWrap}>
                      <Ionicons name="attach-outline" size={15} color={colors.accent} />
                      <Text style={styles.attachChip} numberOfLines={1}>{f.name}</Text>
                    </View>
                  ))}
                  <Pressable onPress={clearPendingAttachments} hitSlop={8} accessibilityRole="button" accessibilityLabel="Anhänge entfernen">
                    <Ionicons name="close" size={16} color={colors.danger} />
                  </Pressable>
                </View>
              )}
              <Modal
                visible={attachOpen}
                transparent
                animationType="fade"
                onDismiss={runPendingAttachAction}
                onRequestClose={() => setAttachOpen(false)}
              >
                <Pressable style={styles.sheetBackdrop} onPress={() => setAttachOpen(false)} accessibilityRole="button" accessibilityLabel="Anhang-Menü schließen">
                  <Pressable style={styles.attachSheet} onPress={() => {}} >
                    <View style={styles.attachSheetHandle} />
                    <Text style={styles.attachSheetTitle}>Anhang hinzufügen</Text>
                    <View style={styles.attachSheetRow}>
                      <Pressable onPress={() => presentAfterSheet(() => { void pickImage(); })} style={styles.attachSheetItem} accessibilityRole="button" accessibilityLabel="Bilder">
                        <View style={styles.attachSheetIcon}><Ionicons name="image-outline" size={22} color={colors.accent} /></View>
                        <Text style={styles.attachSheetLabel}>Bilder</Text>
                      </Pressable>
                      <Pressable onPress={() => presentAfterSheet(() => { void pickCameraImage(); })} style={styles.attachSheetItem} accessibilityRole="button" accessibilityLabel="Kamera">
                        <View style={styles.attachSheetIcon}><Ionicons name="camera-outline" size={22} color={colors.accent} /></View>
                        <Text style={styles.attachSheetLabel}>Kamera</Text>
                      </Pressable>
                      <Pressable onPress={() => presentAfterSheet(() => { void pickFile(); })} style={styles.attachSheetItem} accessibilityRole="button" accessibilityLabel="Datei">
                        <View style={styles.attachSheetIcon}><Ionicons name="attach-outline" size={22} color={colors.accent} /></View>
                        <Text style={styles.attachSheetLabel}>Datei</Text>
                      </Pressable>
                      <Pressable onPress={() => presentAfterSheet(() => { void generateImageInChat(); })} style={styles.attachSheetItem} accessibilityRole="button" accessibilityLabel="Bild erstellen">
                        <View style={styles.attachSheetIcon}><Ionicons name="color-palette-outline" size={22} color={colors.accent} /></View>
                        <Text style={styles.attachSheetLabel}>Bild erstellen</Text>
                      </Pressable>
                    </View>
                    <Pressable onPress={() => setAttachOpen(false)} style={styles.attachSheetCancel} accessibilityRole="button" accessibilityLabel="Abbrechen">
                      <Text style={styles.attachSheetCancelText}>Abbrechen</Text>
                    </Pressable>
                  </Pressable>
                </Pressable>
              </Modal>
              <View style={styles.counterRow}>
                <CharacterCounter value={input} />
              </View>
              <View style={styles.inputBar}>
                {isThisChatBusy ? (
                  <Pressable onPress={() => abort(activeChatId || undefined)} style={[styles.micBtn, styles.stopBtn]} accessibilityLabel="Antwort stoppen">
                    <Ionicons name="stop" size={16} color="#ffffff" />
                  </Pressable>
                ) : (
                  <Animated.View style={{ transform: [{ scale: micPulse }] }}>
                    <Pressable onPress={toggleMic} style={[styles.micBtn, listening && styles.micBtnActive]} accessibilityLabel={listening ? "Diktat beenden" : "Diktieren"}>
                      <Ionicons name="mic" size={18} color={listening ? "#ffffff" : colors.text} />
                    </Pressable>
                  </Animated.View>
                )}
                {/* Sprachmodus (Sprache-zu-Sprache): antippen -> zuhoeren -> Antwort wird
                    gesprochen -> Mikro geht wieder auf. Sitzt bewusst NEBEN dem Diktat-Mikrofon. */}
                <Pressable
                  onPress={() => { haptic("light"); setVoiceOpen(true); }}
                  style={[styles.micBtn, voiceOpen && styles.micBtnActive]}
                  accessibilityLabel="Sprachmodus: Sprache zu Sprache"
                >
                  <Ionicons name="radio-outline" size={18} color={voiceOpen ? "#ffffff" : colors.accent} />
                </Pressable>
                <Pressable onPress={() => setAttachOpen((o) => !o)} style={styles.micBtn} accessibilityLabel={attachOpen ? "Anhang-Menü schließen" : "Anhang hinzufügen"}>
                  <Ionicons name={attachOpen ? "close" : "add"} size={22} color={colors.accent} />
                </Pressable>
                <TextInput
                  style={styles.input}
                  value={input}
                  onChangeText={setInput}
                  placeholder="Nachricht an KittyAI …"
                  placeholderTextColor={colors.muted}
                  multiline
                  textAlignVertical="top"
                  autoCapitalize="sentences"
                  autoCorrect
                  spellCheck
                  scrollEnabled
                  onSubmitEditing={() => send()}
                  // ChatGPT-Verhalten: Return SENDET (statt Zeilenumbruch einzufügen),
                  // Tastatur bleibt offen. Zeilenumbruch weiter über die Grow-Höhe (max 120pt).
                  submitBehavior="submit"
                  returnKeyType="send"
                  accessibilityLabel="Nachricht an KittyAI"
                />
                <Animated.View style={{ transform: [{ scale: sendScale }] }}>
                  <Pressable
                    onPress={() => send()}
                    accessibilityLabel="Nachricht senden"
                    onPressIn={() => Animated.spring(sendScale, { toValue: 0.88, useNativeDriver: true, friction: 6 }).start()}
                    onPressOut={() => Animated.spring(sendScale, { toValue: 1, useNativeDriver: true, friction: 6 }).start()}
                    disabled={isThisChatBusy || (!input.trim() && !pendingImages.length && !pendingFiles.length && !pendingDocuments.length)}
                    style={[styles.sendBtn, (isThisChatBusy || (!input.trim() && !pendingImages.length && !pendingFiles.length && !pendingDocuments.length)) && styles.sendBtnDisabled]}
                  >
                    <Ionicons name="arrow-up" size={20} color="#ffffff" />
                  </Pressable>
                </Animated.View>
              </View>
              <View style={styles.modelBar}>
                <Pressable onPress={() => setModelMenuOpen(true)} style={styles.modelBarChip} hitSlop={6} accessibilityRole="button" accessibilityLabel="Modell wählen">
                  <Ionicons name="hardware-chip-outline" size={13} color={colors.muted} />
                  <Text style={styles.modelBarText} numberOfLines={1}>{modelOptions().find((o) => o.key === activeModel)?.label ?? "FLASH"}</Text>
                  <Ionicons name="chevron-down" size={12} color={colors.muted} />
                </Pressable>
              </View>
              <Text style={styles.disclaimer}>KittyAI kann Fehler machen — wichtige Informationen prüfen.</Text>
            </KeyboardAvoidingView>
          </>
        ) : (
          <>
            <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
              <SearchField value={chatSearch} onChangeText={setChatSearch} placeholder="Chats durchsuchen" />
            </View>
            {renderFolders()}
            <View style={styles.srcFilterRow}>
              {([["app", "Dieses Gerät"], ["server", "Server"], ["whatsapp", "WhatsApp"], ["terminal", "Terminal"], ["all", "Alle"]] as const).map(([k, label]) => (
                <Pressable key={k} onPress={() => setChatFilter(k as any)} style={[styles.srcFilterChip, chatFilter === k && styles.srcFilterChipActive]} hitSlop={4} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: chatFilter === k }}>
                  <Text style={[styles.srcFilterText, chatFilter === k && styles.srcFilterTextActive]}>{label}</Text>
                </Pressable>
              ))}
              <Pressable onPress={() => syncServerChats()} style={styles.srcFilterChip} hitSlop={6} accessibilityRole="button" accessibilityLabel="Server-Chats neu laden">
                <Ionicons name="refresh" size={13} color={colors.muted} />
              </Pressable>
            </View>
            <FlatList
              data={searchedChats}
              keyExtractor={(c) => c.id}
              renderItem={renderChatItem}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>Noch keine Chats</Text>
                  <Text style={styles.emptyText}>
                    Starte deine erste Unterhaltung –{"\n"}tippe oben auf „Neu".
                  </Text>
                </View>
              }
            />
          </>
        )
      ) : (
        <>
          <View style={styles.pluginsSubTabs}>
            {PLUGIN_TABS.map((p) => (
              <Pressable key={p.key} accessibilityRole="tab" accessibilityLabel={p.label} accessibilityState={{ selected: pluginsTab === p.key }} onPress={() => setPluginsTab(p.key)} style={[styles.pluginsSubTab, pluginsTab === p.key && styles.pluginsSubTabActive]}>
                <Text style={[styles.pluginsSubTabText, pluginsTab === p.key && styles.pluginsSubTabTextActive]}>{p.label}</Text>
              </Pressable>
            ))}
          </View>
          {pluginsTab === "tasks" ? (
          <>
          <View style={styles.taskInputBar}>
            <TextInput
              style={styles.input}
              value={taskInput}
              onChangeText={setTaskInput}
              placeholder="Langzeit-Aufgabe an KittyAI …"
              placeholderTextColor={colors.muted}
              multiline
            />
            <Pressable onPress={addTask} disabled={!taskInput.trim()} style={[styles.sendBtn, !taskInput.trim() && styles.sendBtnDisabled]} accessibilityRole="button" accessibilityLabel="Aufgabe hinzufügen">
              <Ionicons name="arrow-up" size={20} color="#ffffff" />
            </Pressable>
          </View>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            <Text style={styles.taskHint}>
              Aufgaben laufen im Hintergrund auf dem Server. Du bekommst eine Push-Nachricht, wenn eine fertig ist.
            </Text>
            {taskList.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>Noch keine Aufgaben</Text>
              </View>
            ) : (
              taskList.map(renderTask)
            )}

            <View style={styles.schedSection}>
              <Text style={styles.schedHeader}>Routinen (wiederkehrend)</Text>
              <TextInput
                style={styles.schedMessageInput}
                value={schedInput}
                onChangeText={setSchedInput}
                placeholder="Routine, z. B. „Fasse jeden Morgen meine Termine zusammen“"
                placeholderTextColor={colors.muted}
                multiline
              />
              <View style={styles.schedPresets}>
                {SCHEDULE_PRESETS.map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => setSchedPreset(p.id)}
                    style={[styles.schedChip, schedPreset === p.id && styles.schedChipActive]}
                   accessibilityRole="button" accessibilityLabel={p.label} accessibilityState={{ selected: schedPreset === p.id }}>
                    <Text style={[styles.schedChipText, schedPreset === p.id && styles.schedChipTextActive]}>{p.label}</Text>
                  </Pressable>
                ))}
              </View>
              {schedPreset !== "hourly" && schedPreset !== "custom" ? (
                <View style={styles.schedRow}>
                  <Text style={styles.schedLabel}>Uhrzeit</Text>
                  <TextInput
                    style={styles.schedField}
                    value={schedTime}
                    onChangeText={setSchedTime}
                    placeholder="09:00"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {schedPreset === "weekly" ? (
                    <View style={styles.schedDays}>
                      {WEEKDAYS_DE.map((d, i) => (
                        <Pressable
                          key={d} accessibilityRole="button" accessibilityLabel={`Wochentag ${d}`} accessibilityState={{ selected: schedDay === i }}
                          onPress={() => setSchedDay(i)}
                          style={[styles.dayChip, schedDay === i && styles.dayChipActive]}
                        >
                          <Text style={[styles.dayChipText, schedDay === i && styles.dayChipTextActive]}>{d}</Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                  {schedPreset === "monthly" ? (
                    <TextInput
                      style={styles.schedField}
                      value={schedDom}
                      onChangeText={setSchedDom}
                      placeholder="Tag"
                      keyboardType="number-pad"
                    />
                  ) : null}
                </View>
              ) : null}
              {schedPreset === "custom" ? (
                <TextInput
                  style={styles.schedField}
                  value={schedCustomCron}
                  onChangeText={setSchedCustomCron}
                  placeholder="Cron: Minute Stunde Tag Monat Wochentag (z. B. 30 7 * * *)"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              ) : null}
              <Pressable
                onPress={addSchedule}
                disabled={!schedInput.trim()}
                style={[styles.schedAddBtn, !schedInput.trim() && styles.sendBtnDisabled]}
               accessibilityRole="button" accessibilityLabel="Zeitplan">
                <View style={styles.chipRow}>
                  <Ionicons name="time-outline" size={15} color="#fff" />
                  <Text style={styles.schedAddText}>Routine anlegen</Text>
                </View>
              </Pressable>
              {scheduleList.length > 0 ? (
                <View style={styles.schedList}>
                  {scheduleList.map((s) => (
                    <View key={s.id} style={styles.schedCard}>
                      <View style={styles.schedCardText}>
                        <Text style={styles.schedCardLabel}>{cronLabel(s.cron)}</Text>
                        <Text style={styles.schedCardMsg} numberOfLines={2}>{s.message}</Text>
                      </View>
                      <Pressable onPress={() => deleteSchedule(s.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Zeitplan löschen">
                        <Ionicons name="close" size={14} color={colors.danger} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          </ScrollView>
          </>
          ) : (
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {pluginsTab === "connectors" ? renderConnectors() : pluginsTab === "skills" ? renderMetaList(meta.skills, "Skills") : pluginsTab === "agents" ? renderMetaList(meta.agents, "Agenten") : renderMetaList(meta.workflows, "Workflows")}
          </ScrollView>
          )}
        </>
      )}

      {/* Modell-Auswahl (Bottom-Sheet) */}
      <Modal visible={modelMenuOpen} transparent animationType="fade" onRequestClose={() => setModelMenuOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setModelMenuOpen(false)} accessibilityRole="button" accessibilityLabel="Modell-Menü schließen">
          <Pressable style={styles.attachSheet} onPress={() => {}} accessibilityElementsHidden>
            <View style={styles.attachSheetHandle} />
            <Text style={styles.attachSheetTitle}>Modell auswählen</Text>
            {modelOptions().map((o) => (
              <Pressable
                key={o.key}
                disabled={!!o.deactivated}
                onPress={() => setActiveModel(o.key)}
                style={[styles.modelMenuItem, activeModel === o.key && styles.modelMenuItemActive]}
               accessibilityRole="button" accessibilityLabel={`Modell ${o.label}`} accessibilityState={{ selected: activeModel === o.key }}>
                <Text style={[styles.modelMenuItemText, activeModel === o.key && styles.modelMenuItemTextActive, o.deactivated && styles.modelMenuItemTextDeactivated]}>
                  {o.label}{o.deactivated ? "  ·  INAKTIV" : ""}
                </Text>
                {activeModel === o.key ? <Ionicons name="checkmark" size={18} color={colors.accent} /> : o.deactivated ? <Ionicons name="close-circle-outline" size={16} color={colors.muted} /> : null}
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Chat umbenennen */}
      <Modal visible={!!renameChatId} transparent animationType="fade" onRequestClose={() => setRenameChatId(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Chat umbenennen</Text>
            <TextInput
              style={styles.urlInput}
              value={renameInput}
              onChangeText={setRenameInput}
              placeholder="Name (max. 22 Zeichen)"
              placeholderTextColor={colors.muted}
              autoFocus
              maxLength={MAX_TITLE_CHARS}
            />
            <View style={styles.modalButtons}>
              <Pressable onPress={() => setRenameChatId(null)} style={styles.modalCancel} accessibilityRole="button" accessibilityLabel="Abbrechen"><Text style={styles.modalCancelText}>Abbrechen</Text></Pressable>
              <Pressable onPress={() => { if (renameChatId) patchChat(renameChatId, (c) => ({ ...c, title: deriveTitle(renameInput) || c.title })); setRenameChatId(null); }} style={styles.modalSave} accessibilityRole="button" accessibilityLabel="Speichern"><Text style={styles.modalSaveText}>Speichern</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Ordner anlegen/bearbeiten */}
      <Modal visible={!!folderModal} transparent animationType="fade" onRequestClose={() => setFolderModal(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{folderModal?.mode === "create" ? (folderModal.parentId ? "Unterordner anlegen" : "Ordner anlegen") : "Ordner bearbeiten"}</Text>
            <TextInput
              style={styles.urlInput}
              value={folderInput}
              onChangeText={setFolderInput}
              placeholder="Name (max. 40 Zeichen)"
              placeholderTextColor={colors.muted}
              maxLength={MAX_FOLDER_NAME_CHARS}
            />
            <TextInput
              style={styles.urlInput}
              value={folderDescInput}
              onChangeText={setFolderDescInput}
              placeholder="Beschreibung (für die KI-Zuordnung)"
              placeholderTextColor={colors.muted}
              multiline
              maxLength={MAX_FOLDER_DESC_CHARS}
            />
            <View style={styles.modalButtons}>
              {folderModal?.mode === "edit" ? (
                <>
                  <Pressable onPress={() => openFolderModal("create", undefined, folderModal.folderId)} style={styles.modalCancel} accessibilityRole="button" accessibilityLabel="Unterordner anlegen">
                    <Text style={styles.folderSubBtn}>↳ Unterordner</Text>
                  </Pressable>
                  <Pressable onPress={() => { if (folderModal.folderId) deleteFolder(folderModal.folderId); setFolderModal(null); }} style={styles.modalCancel} accessibilityRole="button" accessibilityLabel="Löschen">
                    <Text style={styles.modalCancelText}>Löschen</Text>
                  </Pressable>
                </>
              ) : null}
              <Pressable onPress={() => setFolderModal(null)} style={styles.modalCancel} accessibilityRole="button" accessibilityLabel="Abbrechen"><Text style={styles.modalCancelText}>Abbrechen</Text></Pressable>
              <Pressable onPress={submitFolder} style={styles.modalSave} accessibilityRole="button" accessibilityLabel="Speichern"><Text style={styles.modalSaveText}>Speichern</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Chat einem Ordner zuordnen */}
      <Modal visible={!!assignChatId} transparent animationType="fade" onRequestClose={() => setAssignChatId(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setAssignChatId(null)} accessibilityRole="button" accessibilityLabel="Ordner-Menü schließen">
          <Pressable style={styles.attachSheet} onPress={() => {}} accessibilityElementsHidden>
            <View style={styles.attachSheetHandle} />
            <Text style={styles.attachSheetTitle}>In Ordner verschieben</Text>
            <Pressable onPress={() => { if (assignChatId) assignChatToFolder(assignChatId, null); }} style={styles.modelMenuItem} accessibilityRole="button" accessibilityLabel="Aus Ordner entfernen">
              <Text style={styles.modelMenuItemText}>Kein Ordner</Text>
            </Pressable>
            {folders.map((f) => (
              <Pressable key={f.id} onPress={() => { if (assignChatId) assignChatToFolder(assignChatId, f.id); }} style={styles.modelMenuItem} accessibilityRole="button" accessibilityLabel={`In Ordner ${f.name} verschieben`}>
                <Text style={styles.modelMenuItemText}>{f.name}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  attRow: { flexDirection: "row", flexWrap: "wrap", marginTop: 6, gap: 6 },
  attChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    maxWidth: "100%",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: "rgba(127,127,127,0.16)",
  },
  attChipText: { fontSize: 11, color: colors.muted, maxWidth: 200 },

  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  logo: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { color: "#fff", fontWeight: "800", fontSize: 18 },
  backBtn: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerTitles: { flex: 1, marginLeft: 10 },
  headerTitle: { fontSize: 17, fontWeight: "700", color: colors.text },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success },
  headerSub: { fontSize: 12, color: colors.muted },
  headerActions: { flexDirection: "row", gap: 7 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.surface2 },
  chipActive: { backgroundColor: colors.accentSoft },
  chipNew: { backgroundColor: colors.accent },
  chipNewText: { fontSize: 13, color: "#fff", fontWeight: "600" },
  chipRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  modelChipText: { fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  iconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 },
  tabs: { flexDirection: "row", backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  tab: { flex: 1, alignItems: "center", paddingVertical: 11 },
  tabActive: { borderBottomWidth: 2, borderBottomColor: colors.accent },
  tabText: { fontSize: 15, color: colors.muted },
  tabTextActive: { color: colors.accent, fontWeight: "700" },
  tabRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  list: { flex: 1 },
  listContent: { padding: 12, paddingBottom: 16 },
  // overflow:hidden ist der letzte Schutz: ein Kind mit zu großer intrinsischer Breite
  // (langer unbrechbarer String in einem Widget) darf nicht mehr aus der Blase malen.
  bubble: { maxWidth: "86%", padding: 12, borderRadius: 18, marginBottom: 8, overflow: "hidden" },
  // ChatGPT-Look: User rechts in hellgrauer Blase (oai-bg-user-message #0000000D), KI flach.
  userBubble: { alignSelf: "flex-end", backgroundColor: oaicolors.bgUserMessage },
  aiBubble: { backgroundColor: "transparent", borderBottomLeftRadius: 5 },
  aiBubbleRunning: { backgroundColor: "transparent" },
  aiBubbleDone: { backgroundColor: "transparent" },
  msgImage: { width: "100%", height: 260, borderRadius: 12, marginTop: 8, backgroundColor: "transparent" },
  imgFailedRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  imgFailedText: { color: colors.muted, fontSize: 13, fontStyle: "italic" },
  tooBigRow: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 6, marginBottom: 8, maxWidth: "86%", paddingHorizontal: 4 },
  msgActions: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 2, marginBottom: 10, paddingHorizontal: 6 },
  msgActionsUser: { alignSelf: "flex-end" },
  msgActionBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 3, paddingHorizontal: 2 },
  msgActionText: { color: colors.muted, fontSize: 12 },
  tooBigText: { flex: 1, color: colors.accent, fontSize: 12, lineHeight: 16 },
  userText: { color: colors.text, fontSize: 16, lineHeight: 22, fontFamily: uiFontFamily },
  aiText: { color: colors.text, fontSize: 17, lineHeight: 24, fontFamily: aiFontFamily },
  activityWrap: { gap: 6, marginTop: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8 },
  activitySummary: { color: colors.muted, fontSize: 12, fontWeight: "600", marginBottom: 2 },
  activityToggle: { paddingVertical: 4 },
  toolCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 4,
  },
  toolCardErr: { borderColor: colors.danger, backgroundColor: "#fdf3f1" },
  toolCardHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  toolCardIcon: { fontSize: 14 },
  toolCardLabel: { color: colors.text, fontSize: 13, fontWeight: "600", flex: 1 },
  toolCardStatus: { fontSize: 13 },
  toolDot: { width: 8, height: 8, borderRadius: 4 },
  toolCardArgs: { color: colors.muted, fontSize: 11, fontFamily: monoFontFamily, marginTop: 1 },
  activityResult: { color: colors.muted, fontSize: 11, fontFamily: monoFontFamily, marginTop: 2, lineHeight: 16 },
  permissionWrap: { gap: 6, marginTop: 8 },
  permissionCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
  permissionHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  permissionTitle: { color: colors.text, fontSize: 14, fontWeight: "600", flex: 1 },
  permissionDesc: { color: colors.muted, fontSize: 12, fontFamily: monoFontFamily, lineHeight: 17 },
  permissionActions: { flexDirection: "row", gap: 8, marginTop: 2 },
  permissionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  permissionAllow: { backgroundColor: colors.success },
  permissionDeny: { backgroundColor: colors.danger },
  permissionBtnDisabled: { opacity: 0.5 },
  permissionBtnText: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
  permissionStatus: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  empty: { alignItems: "center", marginTop: 70, paddingHorizontal: 28 },
  emptyTitle: { fontSize: 22, fontWeight: "800", color: colors.text, textAlign: "center" },
  emptyText: { fontSize: 15, color: colors.muted, textAlign: "center", marginTop: 10, lineHeight: 22 },
  suggestionRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 20 },
  suggestionChip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  suggestionChipText: { fontSize: 14, color: colors.text },
  thinking: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 4 },
  thinkingText: { color: colors.muted, fontSize: 13, flex: 1 },
  thinkingBlock: { backgroundColor: colors.surface2, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8 },
  thinkingHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  thinkingScroll: { maxHeight: 220, marginTop: 8 },
  thinkingDetail: { color: colors.muted, fontSize: 13, lineHeight: 19, fontFamily: monoFontFamily },
  errorCard: { marginTop: 8, padding: 12, borderRadius: 12, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, gap: 8 },
  errorCardText: { color: colors.danger, fontSize: 13, fontWeight: "600" },
  errorCardTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  errorRetryBtn: { alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.accent },
  errorRetryText: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
  errorRetryRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  compactionWrap: { alignItems: "center", gap: 6, flex: 1 },
  compactionTrack: { width: "100%", height: 4, borderRadius: 2, backgroundColor: colors.border },
  compactionFill: { height: "100%", borderRadius: 2, backgroundColor: colors.accent },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  taskInputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  taskHint: { fontSize: 13, color: colors.muted, lineHeight: 18, marginBottom: 4 },
  taskCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  taskHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  taskMessage: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.text },
  taskBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  taskBadgeText: { color: "#ffffff", fontSize: 11, fontWeight: "700" },
  taskResult: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  schedSection: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12, marginTop: 8, gap: 8 },
  schedHeader: { fontSize: 15, fontWeight: "700", color: colors.text },
  schedMessageInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface,
    minHeight: 44,
  },
  schedPresets: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  schedChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  schedChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  schedChipText: { fontSize: 12, color: colors.text },
  schedChipTextActive: { color: "#ffffff", fontWeight: "700" },
  schedRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  schedLabel: { fontSize: 13, color: colors.muted },
  schedField: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.text,
    backgroundColor: colors.surface2,
    minWidth: 72,
    textAlign: "center",
  },
  schedDays: { flexDirection: "row", gap: 4 },
  dayChip: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  dayChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  dayChipText: { fontSize: 12, color: colors.text },
  dayChipTextActive: { color: "#ffffff", fontWeight: "700" },
  schedAddBtn: { alignSelf: "flex-start", backgroundColor: colors.accent, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999 },
  schedAddText: { color: "#ffffff", fontSize: 14, fontWeight: "700" },
  schedList: { gap: 6, marginTop: 4 },
  schedCard: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 10 },
  schedCardText: { flex: 1 },
  schedCardLabel: { fontSize: 12, color: colors.accent, fontWeight: "700" },
  schedCardMsg: { fontSize: 14, color: colors.text, marginTop: 2 },
  chatItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chatItemActive: { borderColor: colors.accent },
  chatAvatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center", position: "relative" },
  chatStatusDot: { position: "absolute", top: -1, right: -1, width: 13, height: 13, borderRadius: 7, borderWidth: 2, borderColor: colors.surface },
  chatInfo: { flex: 1 },
  chatTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  chatPreview: { fontSize: 13, color: colors.muted, marginTop: 2 },
  chatTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  srcBadge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  srcBadgeText: { fontSize: 9, fontWeight: "700", letterSpacing: 0.3 },
  srcFilterRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  srcFilterChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  srcFilterChipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  srcFilterText: { fontSize: 12, color: colors.muted, fontWeight: "600" },
  srcFilterTextActive: { color: colors.accent },
  readOnlyBar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface2 },
  readOnlyText: { flex: 1, fontSize: 12, color: colors.muted },
  readOnlyBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.accentSoft },
  readOnlyBtnText: { fontSize: 12, fontWeight: "700", color: colors.accent },
  chatRight: { alignItems: "flex-end", gap: 6 },
  chatTime: { fontSize: 11, color: colors.muted },
  micBtn: { width: 42, height: 42, borderRadius: 999, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" },
  micBtnActive: { backgroundColor: colors.danger },
  attachPreview: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, padding: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(26,25,24,0.4)", justifyContent: "flex-end" },
  attachSheet: { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 10, paddingBottom: 30, paddingHorizontal: 20 },
  attachSheetHandle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 14 },
  attachSheetTitle: { fontSize: 13, fontWeight: "600", color: colors.muted, textAlign: "center", marginBottom: 18 },
  attachSheetRow: { flexDirection: "row", justifyContent: "space-around", flexWrap: "wrap", rowGap: 14, marginBottom: 18 },
  attachSheetItem: { alignItems: "center", gap: 8 },
  attachSheetIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" },
  attachSheetLabel: { fontSize: 13, color: colors.text },
  attachSheetCancel: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14, alignItems: "center" },
  attachSheetCancelText: { fontSize: 16, color: colors.danger },
  attachChip: { color: colors.text, fontSize: 13, maxWidth: 200 },
  attachChipWrap: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 12, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, maxWidth: 220 },
  attachThumb: { width: 46, height: 46, borderRadius: 8 },
  replyBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface2,
  },
  replyBarQuote: { flex: 1 },
  replyBarLabel: { fontSize: 11, color: colors.accent, fontWeight: "700" },
  replyBarText: { fontSize: 13, color: colors.muted, marginTop: 1 },
  replyQuote: {
    backgroundColor: "rgba(0,0,0,0.05)",
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 6,
  },
  replyQuoteText: { color: colors.muted, fontSize: 13, fontStyle: "italic" },
  stopBtn: { backgroundColor: colors.danger },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    borderWidth: 0,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface2,
  },
  counterRow: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", minHeight: 0 },
  sendBtn: { width: 42, height: 42, borderRadius: 999, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  sendBtnDisabled: { backgroundColor: colors.muted },
  disclaimer: { textAlign: "center", color: colors.muted, fontSize: 11, paddingTop: 2, paddingBottom: 6 },
  modelBar: { flexDirection: "row", paddingHorizontal: 12, paddingBottom: 4, backgroundColor: colors.surface },
  modelBarChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: colors.border, alignSelf: "flex-start" },
  modelBarText: { fontSize: 11, fontWeight: "700", color: colors.muted, letterSpacing: 0.4 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(26,25,24,0.35)", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: colors.surface, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: colors.border },
  modalTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  modalHint: { fontSize: 13, color: colors.muted, marginTop: 12, lineHeight: 18 },
  urlInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface2,
    marginTop: 6,
  },
  modalButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 },
  modalCancel: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  modalCancelText: { color: colors.muted, fontSize: 15 },
  folderSubBtn: { color: colors.accent, fontSize: 15, fontWeight: "600" },
  modalSave: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.accent },
  modalSaveText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
  chatRightRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  // Ordner/Projekte
  foldersBar: { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  foldersBarContent: { gap: 8, alignItems: "center" },
  folderChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
  folderChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  folderChipText: { fontSize: 13, color: colors.text },
  folderChipTextActive: { color: "#ffffff", fontWeight: "700" },
  folderSuggestion: { flexDirection: "row", alignItems: "center", gap: 8, padding: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.accentSoft },
  folderSuggestionText: { flex: 1, fontSize: 13, color: colors.text },
  folderSuggestionYes: { fontSize: 13, fontWeight: "700", color: colors.accent },
  // Plugins
  pluginsSubTabs: { flexDirection: "row", flexWrap: "wrap", gap: 6, padding: 10, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  pluginsSubTab: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
  pluginsSubTabActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  pluginsSubTabText: { fontSize: 13, color: colors.text },
  pluginsSubTabTextActive: { color: "#ffffff", fontWeight: "700" },
  pluginsHint: { fontSize: 13, color: colors.muted, lineHeight: 18, marginBottom: 12 },
  pluginsSectionTitle: { fontSize: 14, fontWeight: "700", color: colors.text, marginTop: 10, marginBottom: 6 },
  pluginsEmpty: { fontSize: 13, color: colors.muted, marginBottom: 6 },
  connectorsWrap: { gap: 4 },
  connectorForm: { marginTop: 8, gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 },
  metaList: { gap: 8 },
  metaCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 4 },
  metaCardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  metaName: { fontSize: 15, fontWeight: "700", color: colors.text, flex: 1 },
  metaDesc: { fontSize: 13, color: colors.muted, lineHeight: 18 },
  metaCron: { fontSize: 12, color: colors.accent, fontWeight: "700" },
  metaAgent: { fontSize: 12, color: colors.accent },
  metaDot: { width: 9, height: 9, borderRadius: 5 },
  // Modell-Menü
  modelMenuItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 13, paddingHorizontal: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  modelMenuItemActive: { backgroundColor: colors.accentSoft, borderRadius: 10, paddingHorizontal: 10 },
  modelMenuItemText: { fontSize: 15, color: colors.text },
  modelMenuItemTextActive: { color: colors.accent, fontWeight: "700" },
  // deaktiviert (z. B. Robotron via Laptop-Tunnel): sichtbar, aber ausgegraut
  modelMenuItemTextDeactivated: { color: colors.muted, opacity: 0.7 },
});
