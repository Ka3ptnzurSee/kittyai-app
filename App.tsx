import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  View,
} from "react-native";
import * as Speech from "expo-speech";
import { useAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { fetch as streamFetch } from "expo/fetch";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Ionicons, preloadIcons } from "./icons";
import { preloadFonts } from "./fonts";
import { Utf8Decoder, SseParser, argSummary, breakLongLines, breakUnbreakable, formatTime, uid, cronLabel, presetCron, WEEKDAYS_DE, toolMeta, applyPermission, type CronPreset, type PermissionRequest } from "./lib";
import { DilRichText } from "./Dil";
import { aiFontFamily, colors, monoFontFamily, oaicolors, uiFontFamily } from "./theme";

type Activity = { id: string; tool: string; status: "running" | "ok" | "error"; args?: unknown; result?: string };
type Msg = { id: string; role: "user" | "assistant"; text: string; activity?: Activity[]; permissions?: PermissionRequest[]; images?: { uri: string }[]; replyTo?: { text: string }; error?: { type: string; retryable: boolean } };
type Chat = { id: string; title: string; messages: Msg[]; createdAt: number; updatedAt: number };

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
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.thinkingHeader} hitSlop={6}>
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

// Fehler in menschenlesbare Kategorie übersetzen (statt rohem ⚠️-Text).
const AUTH_PATTERN = /401|403|unauthor|forbidden|invalid api key|invalid token|expired token|bad token/i;

function classifyError(raw: string): string {
  const s = raw.toLowerCase();
  if (/rate.?limit|429|too many|limit reached|fenster/i.test(s)) return "Limit erreicht";
  if (/quota|credits|billing|zahlung|payment|out of credits/i.test(s)) return "Konto/Guthaben";
  if (AUTH_PATTERN.test(s)) return "Zugriff verweigert";
  if (/timeout|timed out|zeitüberschreitung/i.test(s)) return "Zeitüberschreitung";
  if (/overload|busy|capacity|ausgelastet|überlast/i.test(s)) return "Server ausgelastet";
  if (/context length|maximum context|token limit/i.test(s)) return "Kontext zu lang";
  if (/network|fetch failed|connection|econnreset|socket|dns|netzwerk|verbindung/i.test(s)) return "Netzwerk unterbrochen";
  return "Fehler";
}

function isRetryable(raw: string): boolean {
  return !AUTH_PATTERN.test(raw)
    && !/quota|credits|billing|zahlung|payment/i.test(raw)
    && !/context length|maximum context|token limit/i.test(raw);
}

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
const CHATS_KEY = "pi-chats-v2";
const CWD_KEY = "pi-cwd";
const STREAM_STATE_KEY = "pi-stream-state-v1";
const STREAM_TIMEOUT_MS = 30 * 60 * 1000; // 30 min – deckt PROMPT_TIMEOUT_MS ab
const MAX_REPLY_CHARS = 20000; // Antworttext pro Nachricht deckeln (OOM-Schutz)
const MAX_BUFFER_CHARS = 200000; // SSE-Parser-Puffer deckeln
const MAX_THINKING_CHARS = 16000; // Denk-Text deckeln (vorher 800 → schnitt Reasoning sichtbar ab)
const MAX_TITLE_CHARS = 22;

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
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.activityToggle}>
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
          <Pressable onPress={() => decide("allow")} disabled={busy} style={[styles.permissionBtn, styles.permissionAllow, busy && styles.permissionBtnDisabled]}>
            <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
            <Text style={styles.permissionBtnText}>Erlauben</Text>
          </Pressable>
          <Pressable onPress={() => decide("deny")} disabled={busy} style={[styles.permissionBtn, styles.permissionDeny, busy && styles.permissionBtnDisabled]}>
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

function MessageBubble({
  item,
  isLast,
  isBusy,
  onReply,
  onRetry,
  onPermission,
}: {
  item: Msg;
  isLast: boolean;
  isBusy: boolean;
  onReply: (m: Msg) => void;
  onRetry?: (m: Msg) => void;
  onPermission?: (p: PermissionRequest, decision: "allow" | "deny") => void;
}) {
  const isUser = item.role === "user";
  const activity = !isUser ? item.activity || [] : [];
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
    <View style={[styles.bubble, bubbleStyle]} {...panResponder.panHandlers}>
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
          <DilRichText text={item.text || ""} />
          {isLast && isBusy && item.text ? <StreamingCursor /> : null}
          {item.error ? (
            <View style={styles.errorCard}>
              <View style={styles.errorCardTitleRow}>
                <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
                <Text style={styles.errorCardText}>{item.error.type}</Text>
              </View>
              {item.error.retryable && onRetry ? (
                <Pressable onPress={() => onRetry(item)} style={styles.errorRetryBtn}>
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
      {item.images && item.images.length > 0 ? (
        item.images.map((img, i) => (
          <Image key={i} source={{ uri: img.uri }} style={styles.msgImage} resizeMode="cover" />
        ))
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
  );
}

function deriveTitle(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (cleaned.length <= MAX_TITLE_CHARS) return cleaned;
  const cut = cleaned.slice(0, MAX_TITLE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const truncated = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return truncated ? `${truncated}…` : "";
}

// Leere KI-Nachricht (kein Text, keine Tools, keine Bilder) = „weißer Balken".
function isEmptyAi(m: Msg): boolean {
  return (
    m.role === "assistant" &&
    !(m.text && m.text.trim()) &&
    !(m.activity && m.activity.length) &&
    !(m.permissions && m.permissions.length) &&
    !(m.images && m.images.length) &&
    !m.error
  );
}

export default function App() {
  const [tab, setTab] = useState<"chats" | "tasks">("chats");
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busyChatIds, setBusyChatIds] = useState<Set<string>>(() => new Set());
  const [thinkingByChat, setThinkingByChat] = useState<Record<string, string>>({});
  const [statusByChat, setStatusByChat] = useState<Record<string, string>>({}); // z. B. "kompaktiere …", "Retry 2/3"
  const [listening, setListening] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const micPulse = useRef(new Animated.Value(1)).current;
  const sendScale = useRef(new Animated.Value(1)).current;
  const [replyingTo, setReplyingTo] = useState<Msg | null>(null);
  const [pendingImages, setPendingImages] = useState<{ data: string; mediaType: string; uri: string }[]>([]);
  const [pendingFiles, setPendingFiles] = useState<{ name: string; content: string }[]>([]);
  const [pendingDocuments, setPendingDocuments] = useState<{ name: string; data: string; mimeType: string }[]>([]);
  const [speak, setSpeak] = useState(false); // Standard: Textantwort; Sprachausgabe nur auf Wunsch
  const [chatModel, setChatModel] = useState<"pro" | "flash">("pro"); // Modellwechsel pro (Reasoning) ↔ flash (schnell)
  const [serverUrl, setServerUrl] = useState<string>(() => detectBase());
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
  const loadedRef = useRef(false);
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
  const nearBottomRef = useRef(true); // ob der Nutzer am Listenende ist (für Auto-Scroll)

  // App-Vordergrund/-Hintergrund: iOS beendet die Socket-Verbindung, sobald die App
  // in den Hintergrund geht. Retries deshalb erst im Vordergrund starten (siehe send()).
  const appStateRef = useRef(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      appStateRef.current = s;
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

  // Beim Öffnen eines Chats immer ganz nach unten springen (Fokus letzte Nachricht),
  // statt erste Nachricht oder Mitte. Kleiner Timeout, damit die FlatList erst gemountet ist.
  useEffect(() => {
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
    nearBottomRef.current = true; // neuer Chat = am Ende starten (sonst veralteter false-Wert aus vorherigem Chat)
    const t = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: false });
    }, 60);
    return () => clearTimeout(t);
  }, [activeChatId]);

  const activeChat = chats.find((c) => c.id === activeChatId) || null;
  const isThisChatBusy = activeChatId ? busyChatIds.has(activeChatId) : false;
  const thisThinking = activeChatId ? thinkingByChat[activeChatId] || "" : "";
  const thisStatus = activeChatId ? statusByChat[activeChatId] || "" : "";

  function markBusy(chatId: string, busy: boolean) {
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

  function authHeaders(): Record<string, string> {
    // Token nur über HTTPS senden – kein Klartext-Token im LAN-/Dev-Modus
    const secure = serverUrl.startsWith("https://");
    return { "Content-Type": "application/json", ...(apiToken && secure ? { "X-API-Token": apiToken } : {}) };
  }

  function patchChat(chatId: string, fn: (c: Chat) => Chat) {
    setChats((cs) => cs.map((c) => (c.id === chatId ? fn(c) : c)));
  }
  function patchMsg(chatId: string, msgId: string, fn: (m: Msg) => Msg) {
    setChats((cs) =>
      cs.map((c) =>
        c.id === chatId ? { ...c, updatedAt: Date.now(), messages: c.messages.map((m) => (m.id === msgId ? fn(m) : m)) } : c,
      ),
    );
  }
  function appendMsg(chatId: string, msg: Msg) {
    setChats((cs) =>
      cs.map((c) => (c.id === chatId ? { ...c, updatedAt: Date.now(), messages: [...c.messages, msg] } : c)),
    );
  }

  useEffect(() => {
    (async () => {
      preloadIcons(); // Vektor-Icons (Ionicons) beim Start laden — kein FOUC/Start-Crash
      preloadFonts(); // echte Claude-Fonts (Anthropic Serif/Sans + JetBrains Mono) laden
      // Server-URL ist fest verdrahtet (detectBase) — keine gespeicherte/manuelle URL mehr.
      const url = serverUrl;
      let savedToken = "";
      try {
        savedToken = (await AsyncStorage.getItem(TOKEN_KEY)) || "";
        // Auto-Token aus Build-Zeit-Secret (EXPO_PUBLIC_API_TOKEN) hat VORRANG:
        // nach einer Server-Token-Rotation übernimmt die App den neuen Token,
        // auch wenn noch ein alter Token im Speicher liegt.
        const cfgToken = ((process.env as any)?.EXPO_PUBLIC_API_TOKEN || "").trim();
        if (cfgToken && cfgToken !== savedToken) {
          savedToken = cfgToken;
          setApiToken(cfgToken);
          await AsyncStorage.setItem(TOKEN_KEY, cfgToken);
        } else if (savedToken) {
          setApiToken(savedToken);
        }
      } catch {
        // ignorieren
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
        const savedChats = await AsyncStorage.getItem(CHATS_KEY);
        if (savedChats) {
          const parsed = JSON.parse(savedChats);
          if (Array.isArray(parsed)) {
            // Verwaiste leere KI-Nachrichten entfernen (weiße Balken aus abgebrochenen Streams).
            // ABER: leere Bubble als Resume-Anker behalten, wenn ein Stream-State existiert.
            const cleaned = parsed.map((c: any) => ({
              ...c,
              messages: (Array.isArray(c.messages) ? c.messages : []).filter(
                (m: any) =>
                  m.role !== "assistant" ||
                  (m.text && String(m.text).trim()) ||
                  (m.activity && m.activity.length) ||
                  (m.permissions && m.permissions.length) ||
                  (m.images && m.images.length) ||
                  m.error ||
                  !!streamStateRef.current[c.id],
              ),
            }));
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
                .catch(() => {
                  // Resume nicht möglich (Turn aufgeräumt/offline) -> Karte als Fehler markieren.
                  patchMsg(chat.id, aiMsg.id, (m) => ({ ...m, error: { type: "Verbindung unterbrochen", retryable: true } }));
                })
                .finally(() => markBusy(chat.id, false));
            }
          }
        }
      } catch {
        // ignorieren
      }
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
            const serverLast = [...data.messages].reverse().find((m) => m.role === "assistant");
            // Server-Session ist die Wahrheit: eine (Resume-)Fehler-Karte auffüllen, wenn der
            // Server die finale Antwort WIRKLICH hat (letzte Server-Nachricht ist eine
            // Assistant-Antwort = Turn fertig). Bei fehlgeschlagenem Turn (letzte Nachricht
            // ist User) bleibt die Fehler-Karte — keine veraltete Antwort einfüllen.
            const lastServerMsg = data.messages[data.messages.length - 1];
            const serverHasFreshAnswer = !!serverLast && !!lastServerMsg && lastServerMsg.role === "assistant" && !!serverLast.text?.trim();
            if (lastAi && !lastAi.text.trim() && serverHasFreshAnswer) {
              return {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === lastAi.id ? { ...m, text: serverLast.text, images: serverLast.images || m.images, error: undefined } : m,
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
  }, [activeChatId, serverUrl, busyChatIds]);

  // Chats automatisch speichern (debounced; trimmen: max 50 Chats, 200 Nachrichten je Chat)
  useEffect(() => {
    if (!loadedRef.current) return;
    const t = setTimeout(() => {
      const trimmed = chats.slice(0, 50).map((c) => ({ ...c, title: deriveTitle(c.title || ""), messages: c.messages.slice(-200) }));
      AsyncStorage.setItem(CHATS_KEY, JSON.stringify(trimmed)).catch(() => {
        // ignorieren
      });
    }, 800);
    return () => clearTimeout(t);
  }, [chats]);

  // Aufgaben automatisch aktualisieren
  useEffect(() => {
    if (tab !== "tasks") return;
    loadTasks();
    const t = setInterval(loadTasks, 4000);
    return () => {
      clearInterval(t);
      tasksAbortRef.current?.abort();
    };
  }, [tab, serverUrl, apiToken]);

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

  function newChat(): string {
    const id = uid("c");
    const chat: Chat = { id, title: "Neuer Chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    setChats((cs) => [chat, ...cs]);
    setActiveChatId(id);
    setTab("chats");
    return id;
  }

  function deleteChat(chatId: string) {
    setChats((cs) => cs.filter((c) => c.id !== chatId));
    if (activeChatId === chatId) setActiveChatId(null);
    // Server-seitig aufräumen: laufende Antwort abbrechen + Session zurücksetzen,
    // damit kein toter pi-Prozess/keine tote Session weiterläuft.
    abortControllersRef.current.get(chatId)?.abort();
    abortControllersRef.current.delete(chatId);
    abortedRef.current.add(chatId);
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
      const data = await res.json();
      if (data.audioBase64) {
        const file = new File(Paths.cache, `tts-${Date.now()}.mp3`);
        file.create({ overwrite: true, intermediates: true });
        file.write(data.audioBase64, { encoding: "base64" });
        player.replace({ uri: file.uri });
        player.play();
        return;
      }
    } catch {
      // ElevenLabs/Edge nicht erreichbar → Fallback
    }
    Speech.speak(text, { language: "de-DE" });
  }

  async function pickImage() {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.7,
        allowsEditing: true,
      });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      if (a.fileSize && a.fileSize > 5 * 1024 * 1024) {
        Alert.alert("Bild zu groß", "Maximal 5 MB — bitte ein kleineres Bild wählen.");
        return;
      }
      const b64 = a.base64 ?? "";
      if (b64) {
        setPendingImages((p) => [...p, { data: b64, mediaType: a.mimeType || "image/jpeg", uri: a.uri }]);
      }
    } catch {
      // Galerie nicht verfügbar
    }
  }

  async function pickFile() {
    try {
      const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      const isPdf = a.mimeType === "application/pdf" || (a.name || "").toLowerCase().endsWith(".pdf");
      const maxBytes = isPdf ? 8 * 1024 * 1024 : 2 * 1024 * 1024;
      if (a.size && a.size > maxBytes) {
        Alert.alert("Datei zu groß", isPdf ? "Maximal 8 MB für PDFs" : "Maximal 2 MB");
        return;
      }
      const f = new File(a.uri);
      if (isPdf) {
        const b64 = await f.base64();
        setPendingDocuments((p) => [...p, { name: a.name || "dokument.pdf", data: b64, mimeType: "application/pdf" }]);
      } else {
        const content = await f.text();
        setPendingFiles((p) => [...p, { name: a.name || "datei", content: content.slice(0, 20000) }]);
      }
    } catch {
      // Datei nicht lesbar
    }
  }

  async function generateImageInChat() {
    const prompt = input.trim();
    if (!prompt || isThisChatBusy) return;
    let chatId = activeChatId;
    if (!chatId) chatId = newChat();
    setInput("");
    const userMsg: Msg = { id: uid("u"), role: "user", text: prompt };
    const aiId = uid("a");
    const aiMsg: Msg = { id: aiId, role: "assistant", text: "", images: [] };
    patchChat(chatId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? (deriveTitle(prompt) || c.title) : c.title,
      messages: [...c.messages, userMsg, aiMsg],
      updatedAt: Date.now(),
    }));
    markBusy(chatId, true);
    const ctrl = new AbortController();
    abortControllersRef.current.set(chatId, ctrl);
    const timer = setTimeout(() => ctrl.abort(), 180000);
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/image`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ prompt }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const imgUri = `${serverUrl.replace(/\/+$/, "")}${data.url}`;
      patchMsg(chatId, aiId, (m) => ({ ...m, text: "", images: [{ uri: imgUri }] }));
      if (speak) speakReply("Hier ist das Bild.");
    } catch (e) {
      const msg = ctrl.signal.aborted ? "Zeitüberschreitung bei der Bild-Generierung" : (e instanceof Error ? e.message : String(e));
      appendMsg(chatId, { id: uid("e"), role: "assistant", text: `Bild-Generierung fehlgeschlagen: ${classifyError(msg)}` });
    } finally {
      clearTimeout(timer);
      if (abortControllersRef.current.get(chatId) === ctrl) abortControllersRef.current.delete(chatId);
      markBusy(chatId, false);
    }
  }

  async function send(text?: string) {
    const message = (text ?? input).trim();
    if (!message && pendingImages.length === 0 && pendingFiles.length === 0 && pendingDocuments.length === 0) return;
    let chatId = activeChatId;
    if (!chatId) chatId = newChat();
    if (busyChatIds.has(chatId)) return; // nur dieser Chat ist gerade beschäftigt
    let finalMessage = message;
    const replyTo = replyingTo ? { text: replyingTo.text.replace(/\n+/g, " ").trim().slice(0, 200) } : undefined;
    if (replyTo) {
      finalMessage = `[Antwort auf: "${replyTo.text}"]\n${finalMessage}`;
    }
    if (pendingFiles.length) {
      const fileText = pendingFiles.map((f) => `### ${f.name}\n${f.content}`).join("\n\n");
      finalMessage = message ? `${message}\n\n[Angehängte Dateien]\n${fileText}` : `[Angehängte Dateien]\n${fileText}`;
    }
    const images = pendingImages.map((im) => ({ data: im.data, mediaType: im.mediaType }));
    const documents = pendingDocuments.map((d) => ({ name: d.name, data: d.data, mimeType: d.mimeType }));
    if (!finalMessage && (images.length || documents.length)) {
      finalMessage = images.length ? "[Bild angehängt – analysiere es]" : "[PDF-Dokument angehängt – analysiere es]";
    }
    const imageUris = pendingImages.map((im) => ({ uri: im.uri }));
    setInput("");
    setChatThinking(chatId, "");
    setStatusByChat((prev) => ({ ...prev, [chatId]: "" }));
    const userMsg: Msg = { id: uid("u"), role: "user", text: message || (imageUris.length ? "Bild" : documents.length ? "PDF" : "Datei"), images: imageUris, replyTo };
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
    abortedRef.current.delete(chatId);
    const clientMessageId = uid("m");
    streamStateRef.current[chatId] = { turnId: "", lastSeq: 0, clientMessageId };
    persistStreamState(chatId);
    markBusy(chatId, true);
    // Nach dem Senden zur letzten Nachricht scrollen (einmalig, nicht bei jedem Stream-Zeichen).
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);

    try {
      await streamChat(finalMessage, chatId, aiId, images, documents, undefined, clientMessageId);
    } catch (e) {
      if (abortedRef.current.has(chatId)) {
        abortedRef.current.delete(chatId);
        return; // Nutzer-Abbruch → kein Fallback
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
            setThinkingByChat((p) => ({ ...p, [chatId]: "" }));
            if (st && st.turnId) {
              // Resumable: an der Abbruchstelle fortsetzen statt von vorn zu streamen.
              await streamChat(finalMessage, chatId, aiId, images, documents, { turnId: st.turnId, lastSeq: st.lastSeq || 0 }, clientMessageId);
            } else {
              // Kein turnId bekannt (App evtl. vor turn_start getötet) → Server sucht
              // den letzten Turn dieses Chats selbst (vermeidet doppeltes Senden).
              await streamChat(finalMessage, chatId, aiId, images, documents, { turnId: "", lastSeq: 0 }, clientMessageId);
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
        await streamChat(finalMessage, chatId, aiId, images, documents, { turnId: st?.turnId || "", lastSeq: st?.lastSeq || 0 }, clientMessageId);
        setStatusByChat((prev) => ({ ...prev, [chatId]: "" }));
      } catch (e2) {
        const rawMsg = e2 instanceof Error ? e2.message : String(e2);
        const msg = /network|fetch failed|connection lost|request failed/i.test(rawMsg)
          ? "Verbindung unterbrochen (Netzwerk) — bitte erneut senden"
          : rawMsg;
        // Fehler als eigene Karte statt als Text-Suffix in die Antwort.
        patchMsg(chatId, aiId, (m) => ({ ...m, error: { type: classifyError(msg), retryable: isRetryable(msg) } }));
      }
    } finally {
      markBusy(chatId, false);
      setChatThinking(chatId, "");
      // Weißen Balken vermeiden: nach JEDEM Turn (normal, Fehler, Abbruch, Timeout)
      // verwaiste leere KI-Bubbles entfernen — Nachrichten ohne Text/Tool/Anhang
      // bleiben sonst als leerer weißer Block stehen, auch bei neuen Nachrichten.
      setChats((cs) =>
        cs.map((c) =>
          c.id === chatId
            ? {
                ...c,
                messages: c.messages.filter(
                  (m) =>
                    m.role !== "assistant" ||
                    (m.text && m.text.trim()) ||
                    (m.activity && m.activity.length) ||
                    (m.permissions && m.permissions.length) ||
                    (m.images && m.images.length) ||
                    m.error,
                ),
              }
            : c,
        ),
      );
    }
  }

  async function streamChat(message: string, chatId: string, aiId: string, images: { data: string; mediaType: string }[] = [], documents: { name: string; data: string; mimeType: string }[] = [], resume?: { turnId: string; lastSeq: number }, clientMessageId?: string) {
    const controller = new AbortController();
    abortControllersRef.current.set(chatId, controller);
    const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
    let lastSeq = resume?.lastSeq ?? 0;
    let turnId = resume?.turnId ?? "";
    // Voll-Replay (lastSeq=0): bereits gestreamten Teiltext zurücksetzen, damit
    // die Deltas beim Replay nicht doppelt angehängt werden.
    if (resume && lastSeq === 0) {
      patchMsg(chatId, aiId, (m) => ({ ...m, text: "", activity: [] }));
    }
    try {
    const res = await streamFetch(`${serverUrl.replace(/\/+$/, "")}/api/chat/stream`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(resume ? { chatId, resume, clientMessageId } : { message, chatId, images, documents, clientMessageId, model: chatModel }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${errText.slice(0, 200)}`);
    }

    const body = res.body;
    if (!body) throw new Error("Kein Streaming-Body verfügbar");

    const reader = body.getReader();
    const decoder = new Utf8Decoder();
    const parser = new SseParser(MAX_BUFFER_CHARS);
    let finalReply = "";
    let finalActivity: Activity[] = [];

    const apply = (evt: unknown) => {
      const e = evt as { type?: string; data?: unknown };
      const t = e?.type;
      if (t === "text") {
        const delta = typeof e.data === "string" ? e.data : "";
        patchMsg(chatId, aiId, (m) => ({ ...m, text: (m.text + delta).slice(0, MAX_REPLY_CHARS) }));
      } else if (t === "thinking") {
        const delta = typeof e.data === "string" ? e.data : "";
        setThinkingByChat((prev) => ({ ...prev, [chatId]: ((prev[chatId] || "") + delta).slice(-MAX_THINKING_CHARS) }));
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
        const d = (e.data || {}) as { aborted?: boolean; tokensBefore?: number | null; estimatedTokensAfter?: number | null };
        setStatusByChat((prev) => ({ ...prev, [chatId]: d.aborted ? "" : `Kontext kompaktiert (${Math.round((d.tokensBefore ?? 0) / 1000)}k → ${Math.round((d.estimatedTokensAfter ?? 0) / 1000)}k Tokens)` }));
        setTimeout(() => setStatusByChat((prev) => (prev[chatId]?.startsWith("Kontext kompaktiert") ? { ...prev, [chatId]: "" } : prev)), 4000);
      } else if (t === "auto_retry_start" || t === "summarization_retry_attempt_start") {
        const d = (e.data || {}) as { attempt?: number; maxAttempts?: number };
        setStatusByChat((prev) => ({ ...prev, [chatId]: `Retry ${d.attempt ?? 0}/${d.maxAttempts ?? 0} …` }));
      } else if (t === "auto_retry_end" || t === "summarization_retry_finished") {
        setStatusByChat((prev) => ({ ...prev, [chatId]: "" }));
      } else if (t === "done") {
        const d = (e.data || {}) as { reply?: string; activity?: Activity[] };
        finalReply = (d.reply || "").trim().slice(0, MAX_REPLY_CHARS);
        finalActivity = (Array.isArray(d.activity) ? d.activity : []).map((a) => ({ ...a, result: (a.result || "").slice(0, 4000) }));
        setStatusByChat((prev) => ({ ...prev, [chatId]: "" }));
        // Turn abgeschlossen: keinen Resume-Anker mehr hinterlassen (Auto-Resume idempotent).
        delete streamStateRef.current[chatId];
        persistStreamState(chatId);
      } else if (t === "resume_unavailable") {
        // Turn ist auf dem Server nicht mehr vorhanden → Voll-Replay erzwingen.
        throw new Error("resume_unavailable");
      } else if (t === "error") {
        const raw = typeof e.data === "string" ? e.data : String(e.data || "Fehler");
        patchMsg(chatId, aiId, (m) => ({ ...m, error: { type: classifyError(raw), retryable: isRetryable(raw) } }));
      }
    };

    const handle = (evt: unknown) => {
      const e0 = evt as { type?: string; data?: { turnId?: string }; seq?: number };
      if (typeof e0.seq === "number" && e0.seq > lastSeq) lastSeq = e0.seq;
      if (e0.type === "turn_start" && e0.data && e0.data.turnId) turnId = e0.data.turnId;
      streamStateRef.current[chatId] = { turnId, lastSeq, clientMessageId };
      if (e0.type === "turn_start") persistStreamState(chatId);
      apply(evt);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const evt of parser.push(decoder.decode(value as Uint8Array))) handle(evt);
    }
    // Stream zu Ende: Rest im Puffer noch verarbeiten (Event ohne finales \n\n).
    for (const evt of parser.flush()) handle(evt);

    const finalText = finalReply.trim() || "(keine Antwort)";
    patchMsg(chatId, aiId, (m) => ({
      ...m,
      text: m.text || finalText,
      activity: m.activity && m.activity.length ? m.activity : finalActivity,
    }));
    if (speak && finalReply.trim()) speakReply(finalReply.trim());
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
                      (m.images && m.images.length) ||
                      m.error,
                  ),
                }
              : c,
          ),
        );
        return;
      }
      // Timeout (30 min): partiell gestreamten Text behalten + Meldung anhängen.
      if (controller.signal.aborted) {
        patchMsg(chatId, aiId, (m) => ({ ...m, error: { type: "Zeitüberschreitung", retryable: true } }));
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
      await fetch(`${serverUrl.replace(/\/+$/, "")}/schedule/${id}`, {
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
    const text = userMsg.text.trim();
    // Reine Anhang-Nachrichten ("Bild"/"PDF"/"Datei") können ohne
    // die Base64-Anhänge nicht korrekt wiederholt werden → Retry unterdrücken.
    if (!text || /^(Bild|PDF|Datei)$/.test(text)) return;
    patchMsg(chat.id, aiMsg.id, (m) => ({ ...m, text: "", activity: [], error: undefined }));
    markBusy(chat.id, true);
    setChatThinking(chat.id, "");
    abortedRef.current.delete(chat.id);
    delete streamStateRef.current[chat.id];
    streamChat(text, chat.id, aiMsg.id).catch((e) => {
      const raw = e instanceof Error ? e.message : String(e);
      patchMsg(chat.id, aiMsg.id, (m) => ({ ...m, error: { type: classifyError(raw), retryable: isRetryable(raw) } }));
    }).finally(() => {
      markBusy(chat.id, false);
      setChatThinking(chat.id, "");
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
        onPermission={(p, decision) => decidePermission(activeChat?.id || "", p.turnId, p.permissionId, decision)}
      />
    );
  }

  function renderChatItem({ item }: { item: Chat }) {
    const last = item.messages[item.messages.length - 1];
    const preview = last ? last.text.replace(/\n/g, " ").slice(0, 80) : "Neue Unterhaltung";
    const isActive = item.id === activeChatId;
    // Status-Ampel: rot = arbeitet (busy), grün = fertig (hat Nachrichten), weiß = unbenutzt (leer)
    const isBusy = busyChatIds.has(item.id);
    const hasMessages = item.messages.length > 0;
    const statusColor = isBusy ? colors.danger : hasMessages ? colors.success : "#ffffff";
    return (
      <Pressable onPress={() => setActiveChatId(item.id)} style={[styles.chatItem, isActive && styles.chatItemActive]}>
        <View style={styles.chatAvatar}>
          <Ionicons name="chatbubbles-outline" size={20} color={colors.accent} />
          <View style={[styles.chatStatusDot, { backgroundColor: statusColor }]} />
        </View>
        <View style={styles.chatInfo}>
          <Text style={styles.chatTitle} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.chatPreview} numberOfLines={1}>{preview}</Text>
        </View>
        <View style={styles.chatRight}>
          <Text style={styles.chatTime}>{formatTime(item.updatedAt)}</Text>
          <Pressable onPress={() => deleteChat(item.id)} hitSlop={8}>
            <Ionicons name="close" size={14} color={colors.danger} />
          </Pressable>
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

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />

      <View style={styles.header}>
        {activeChatId && tab === "chats" ? (
          <Pressable onPress={() => setActiveChatId(null)} style={styles.backBtn} hitSlop={8}>
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
            <Pressable onPress={() => deleteChat(activeChatId)} style={styles.chip} hitSlop={6}>
              <Ionicons name="trash-outline" size={16} color={colors.danger} />
            </Pressable>
          ) : (
            <Pressable onPress={() => newChat()} style={[styles.chip, styles.chipNew]} hitSlop={6}>
              <View style={styles.chipRow}>
                <Ionicons name="add" size={15} color="#fff" />
                <Text style={styles.chipNewText}>Neu</Text>
              </View>
            </Pressable>
          )}
          <Pressable onPress={() => setSpeak((s) => !s)} style={[styles.iconBtn, speak && styles.chipActive]} hitSlop={6}>
            <Ionicons name={speak ? "volume-high-outline" : "chatbubble-outline"} size={17} color={speak ? colors.accent : colors.text} />
          </Pressable>
          <Pressable onPress={() => setChatModel((m) => (m === "pro" ? "flash" : "pro"))} style={[styles.iconBtn, chatModel === "pro" && styles.chipActive]} hitSlop={6}>
            <Text style={[styles.modelChipText, chatModel === "pro" ? { color: colors.accent } : { color: colors.muted }]} numberOfLines={1}>{chatModel === "pro" ? "PRO" : "FLASH"}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.tabs}>
        <Pressable onPress={() => setTab("chats")} style={[styles.tab, tab === "chats" && styles.tabActive]}>
          <View style={styles.tabRow}>
            <Ionicons name="chatbubbles-outline" size={16} color={tab === "chats" ? colors.accent : colors.muted} />
            <Text style={[styles.tabText, tab === "chats" && styles.tabTextActive]}>Chats</Text>
          </View>
        </Pressable>
        <Pressable onPress={() => setTab("tasks")} style={[styles.tab, tab === "tasks" && styles.tabActive]}>
          <View style={styles.tabRow}>
            <Ionicons name="clipboard-outline" size={16} color={tab === "tasks" ? colors.accent : colors.muted} />
            <Text style={[styles.tabText, tab === "tasks" && styles.tabTextActive]}>Aufgaben</Text>
          </View>
        </Pressable>
      </View>

      {tab === "chats" ? (
        activeChat ? (
          <>
            <FlatList
              ref={listRef}
              data={activeChat.messages}
              keyExtractor={(m) => m.id}
              renderItem={renderMessage}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              onScroll={(e) => {
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                const dist = contentSize.height - (contentOffset.y + layoutMeasurement.height);
                nearBottomRef.current = dist < 80;
              }}
              onContentSizeChange={() => {
                if (nearBottomRef.current) listRef.current?.scrollToEnd({ animated: false });
              }}
              scrollEventThrottle={32}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>Hallo</Text>
                  <Text style={styles.emptyText}>Wie kann ich dir heute helfen?</Text>
                  <View style={styles.suggestionRow}>
                    {["Fasse den Tag zusammen", "Recherchiere etwas für mich", "Schreibe mir eine Nachricht", "Erkläre mir ein Thema"].map((s) => (
                      <Pressable key={s} onPress={() => send(s)} style={styles.suggestionChip}>
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
                      {thisStatus ? (
                        thisStatus.startsWith("kompaktiere Kontext") ? (
                          <CompactionBar />
                        ) : (
                          <Text style={styles.thinkingText} numberOfLines={1}>{thisStatus}</Text>
                        )
                      ) : listening ? (
                        <Text style={styles.thinkingText} numberOfLines={1}>höre zu …</Text>
                      ) : (
                        <ElapsedLabel style={styles.thinkingText} />
                      )}
                    </View>
                  )
                ) : null
              }
            />

            <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
              {replyingTo ? (
                <View style={styles.replyBar}>
                  <View style={styles.replyBarQuote}>
                    <Text style={styles.replyBarLabel}>Antwort auf:</Text>
                    <Text style={styles.replyBarText} numberOfLines={1}>
                      {replyingTo.text.replace(/\n+/g, " ").trim().slice(0, 120)}
                    </Text>
                  </View>
                  <Pressable onPress={() => setReplyingTo(null)} hitSlop={8}>
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
                  <Pressable onPress={() => { setPendingImages([]); setPendingFiles([]); setPendingDocuments([]); }} hitSlop={8}>
                    <Ionicons name="close" size={16} color={colors.danger} />
                  </Pressable>
                </View>
              )}
              <Modal
                visible={attachOpen}
                transparent
                animationType="fade"
                onRequestClose={() => setAttachOpen(false)}
              >
                <Pressable style={styles.sheetBackdrop} onPress={() => setAttachOpen(false)}>
                  <Pressable style={styles.attachSheet} onPress={() => {}}>
                    <View style={styles.attachSheetHandle} />
                    <Text style={styles.attachSheetTitle}>Anhang hinzufügen</Text>
                    <View style={styles.attachSheetRow}>
                      <Pressable onPress={() => { pickImage(); setAttachOpen(false); }} style={styles.attachSheetItem}>
                        <View style={styles.attachSheetIcon}><Ionicons name="image-outline" size={22} color={colors.accent} /></View>
                        <Text style={styles.attachSheetLabel}>Bild</Text>
                      </Pressable>
                      <Pressable onPress={() => { pickFile(); setAttachOpen(false); }} style={styles.attachSheetItem}>
                        <View style={styles.attachSheetIcon}><Ionicons name="attach-outline" size={22} color={colors.accent} /></View>
                        <Text style={styles.attachSheetLabel}>Datei</Text>
                      </Pressable>
                      <Pressable onPress={() => { generateImageInChat(); setAttachOpen(false); }} style={styles.attachSheetItem}>
                        <View style={styles.attachSheetIcon}><Ionicons name="color-palette-outline" size={22} color={colors.accent} /></View>
                        <Text style={styles.attachSheetLabel}>Bild erstellen</Text>
                      </Pressable>
                    </View>
                    <Pressable onPress={() => setAttachOpen(false)} style={styles.attachSheetCancel}>
                      <Text style={styles.attachSheetCancelText}>Abbrechen</Text>
                    </Pressable>
                  </Pressable>
                </Pressable>
              </Modal>
              <View style={styles.inputBar}>
                {isThisChatBusy ? (
                  <Pressable onPress={() => abort(activeChatId || undefined)} style={[styles.micBtn, styles.stopBtn]}>
                    <Ionicons name="stop" size={16} color="#ffffff" />
                  </Pressable>
                ) : (
                  <Animated.View style={{ transform: [{ scale: micPulse }] }}>
                    <Pressable onPress={toggleMic} style={[styles.micBtn, listening && styles.micBtnActive]}>
                      <Ionicons name="mic" size={18} color={listening ? "#ffffff" : colors.text} />
                    </Pressable>
                  </Animated.View>
                )}
                <Pressable onPress={() => setAttachOpen((o) => !o)} style={styles.micBtn}>
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
                  onSubmitEditing={() => send()}
                  returnKeyType="send"
                />
                <Animated.View style={{ transform: [{ scale: sendScale }] }}>
                  <Pressable
                    onPress={() => send()}
                    onPressIn={() => Animated.spring(sendScale, { toValue: 0.88, useNativeDriver: true, friction: 6 }).start()}
                    onPressOut={() => Animated.spring(sendScale, { toValue: 1, useNativeDriver: true, friction: 6 }).start()}
                    disabled={isThisChatBusy || !input.trim()}
                    style={[styles.sendBtn, (isThisChatBusy || !input.trim()) && styles.sendBtnDisabled]}
                  >
                    <Ionicons name="arrow-up" size={20} color="#ffffff" />
                  </Pressable>
                </Animated.View>
              </View>
              <Text style={styles.disclaimer}>KittyAI kann Fehler machen — wichtige Informationen prüfen.</Text>
            </KeyboardAvoidingView>
          </>
        ) : (
          <>
            <FlatList
              data={sortedChats}
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
          <View style={styles.taskInputBar}>
            <TextInput
              style={styles.input}
              value={taskInput}
              onChangeText={setTaskInput}
              placeholder="Langzeit-Aufgabe an KittyAI …"
              placeholderTextColor={colors.muted}
              multiline
            />
            <Pressable onPress={addTask} disabled={!taskInput.trim()} style={[styles.sendBtn, !taskInput.trim() && styles.sendBtnDisabled]}>
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
                  >
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
                          key={d}
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
              >
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
                      <Pressable onPress={() => deleteSchedule(s.id)} hitSlop={8}>
                        <Ionicons name="close" size={14} color={colors.danger} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          </ScrollView>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
  bubble: { maxWidth: "86%", padding: 12, borderRadius: 18, marginBottom: 8 },
  // ChatGPT-Look: User rechts in hellgrauer Blase (oai-bg-user-message #0000000D), KI flach.
  userBubble: { alignSelf: "flex-end", backgroundColor: oaicolors.bgUserMessage },
  aiBubble: { alignSelf: "flex-start", backgroundColor: "transparent", borderBottomLeftRadius: 5 },
  aiBubbleRunning: { alignSelf: "flex-start", backgroundColor: "transparent" },
  aiBubbleDone: { alignSelf: "flex-start", backgroundColor: "transparent" },
  msgImage: { width: "100%", height: 260, borderRadius: 12, marginTop: 8, backgroundColor: colors.surface2 },
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
  chatRight: { alignItems: "flex-end", gap: 6 },
  chatTime: { fontSize: 11, color: colors.muted },
  micBtn: { width: 42, height: 42, borderRadius: 999, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" },
  micBtnActive: { backgroundColor: colors.danger },
  attachPreview: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, padding: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(26,25,24,0.4)", justifyContent: "flex-end" },
  attachSheet: { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 10, paddingBottom: 30, paddingHorizontal: 20 },
  attachSheetHandle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 14 },
  attachSheetTitle: { fontSize: 13, fontWeight: "600", color: colors.muted, textAlign: "center", marginBottom: 18 },
  attachSheetRow: { flexDirection: "row", justifyContent: "space-around", marginBottom: 18 },
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
  sendBtn: { width: 42, height: 42, borderRadius: 999, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  sendBtnDisabled: { backgroundColor: colors.muted },
  disclaimer: { textAlign: "center", color: colors.muted, fontSize: 11, paddingTop: 2, paddingBottom: 6 },
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
  modalSave: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.accent },
  modalSaveText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
});
