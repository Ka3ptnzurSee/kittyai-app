import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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

type Activity = { id: string; tool: string; status: "running" | "ok" | "error"; args?: unknown; result?: string };
type Msg = { id: string; role: "user" | "assistant"; text: string; activity?: Activity[] };
type Chat = { id: string; title: string; messages: Msg[]; createdAt: number; updatedAt: number };
type Task = {
  id: string;
  message: string;
  status: "pending" | "running" | "done" | "error";
  result?: string;
  createdAt?: string;
  doneAt?: string;
};

// Kleiner inkrementeller UTF-8-Decoder (kein globaler TextDecoder nötig).
class Utf8Decoder {
  private pending: number[] = [];
  private expected = 0;
  decode(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (this.expected === 0) {
        if (b < 0x80) out += String.fromCharCode(b);
        else if ((b >> 5) === 0b110) { this.pending = [b]; this.expected = 1; }
        else if ((b >> 4) === 0b1110) { this.pending = [b]; this.expected = 2; }
        else if ((b >> 3) === 0b11110) { this.pending = [b]; this.expected = 3; }
        else out += "\uFFFD";
      } else {
        this.pending.push(b);
        this.expected--;
        if (this.expected === 0) out += this.flush();
      }
    }
    return out;
  }
  private flush(): string {
    const p = this.pending;
    this.pending = [];
    let cp: number;
    if (p.length === 2) cp = ((p[0] & 0x1f) << 6) | (p[1] & 0x3f);
    else if (p.length === 3) cp = ((p[0] & 0x0f) << 12) | ((p[1] & 0x3f) << 6) | (p[2] & 0x3f);
    else cp = ((p[0] & 0x07) << 18) | ((p[1] & 0x3f) << 12) | ((p[2] & 0x3f) << 6) | (p[3] & 0x3f);
    if (cp > 0xffff) {
      cp -= 0x10000;
      return String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
    return String.fromCharCode(cp);
  }
}

function argSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path;
  if (typeof a.url === "string") return a.url;
  const keys = Object.keys(a);
  if (keys.length) {
    const v = a[keys[0]];
    if (typeof v === "string") return v.slice(0, 60);
    return keys[0];
  }
  return "";
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

const STORAGE_KEY = "pi-server-url";
const TOKEN_KEY = "pi-api-token";
const CHATS_KEY = "pi-chats-v2";
const CWD_KEY = "pi-cwd";

// Dark Theme
const colors = {
  bg: "#0b0e14",
  surface: "#141926",
  surface2: "#1c2333",
  text: "#eef2f8",
  muted: "#8a93a6",
  accent: "#5b7cfa",
  accentSoft: "#26304d",
  border: "#232b3d",
  danger: "#ff5c6a",
  success: "#34d399",
  warning: "#f5a623",
};

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
  return "https://lawnware.uk:8446";
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

export default function App() {
  const [tab, setTab] = useState<"chats" | "tasks">("chats");
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState("");
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(true);
  const [serverUrl, setServerUrl] = useState<string>(() => detectBase());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState<string>(() => detectBase());
  const [apiToken, setApiToken] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [cwdDraft, setCwdDraft] = useState("");
  const [cwd, setCwd] = useState("");
  const [taskList, setTaskList] = useState<Task[]>([]);
  const [taskInput, setTaskInput] = useState("");
  const listRef = useRef<FlatList<Msg>>(null);
  const loadedRef = useRef(false);
  const finalTranscriptRef = useRef("");
  const player = useAudioPlayer();

  const activeChat = chats.find((c) => c.id === activeChatId) || null;

  function authHeaders(): Record<string, string> {
    return { "Content-Type": "application/json", ...(apiToken ? { "X-API-Token": apiToken } : {}) };
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
      let url = serverUrl;
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved) {
          url = saved;
          setServerUrl(saved);
          setUrlDraft(saved);
        }
      } catch {
        // ignorieren
      }
      let savedToken = "";
      try {
        savedToken = (await AsyncStorage.getItem(TOKEN_KEY)) || "";
        if (savedToken) setApiToken(savedToken);
      } catch {
        // ignorieren
      }
      try {
        const savedCwd = await AsyncStorage.getItem(CWD_KEY);
        if (savedCwd) {
          setCwdDraft(savedCwd);
          setCwd(savedCwd);
        }
      } catch {
        // ignorieren
      }
      try {
        const savedChats = await AsyncStorage.getItem(CHATS_KEY);
        if (savedChats) {
          const parsed = JSON.parse(savedChats);
          if (Array.isArray(parsed)) setChats((prev) => (prev.length ? prev : parsed));
        }
      } catch {
        // ignorieren
      }
      loadedRef.current = true;
      registerPush(url, savedToken);
    })();
  }, []);

  // Chats automatisch speichern (debounced; trimmen: max 50 Chats, 200 Nachrichten je Chat)
  useEffect(() => {
    if (!loadedRef.current) return;
    const t = setTimeout(() => {
      const trimmed = chats.slice(0, 50).map((c) => ({ ...c, messages: c.messages.slice(-200) }));
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
    return () => clearInterval(t);
  }, [tab, serverUrl]);

  async function registerPush(url: string, tok?: string) {
    try {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== "granted") return;
      const token = (await Notifications.getExpoPushTokenAsync()).data;
      await fetch(`${url.replace(/\/+$/, "")}/register-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(tok ? { "X-API-Token": tok } : {}) },
        body: JSON.stringify({ token }),
      });
    } catch {
      // In Expo Go sind Push-Benachrichtigungen nicht verfügbar – ignorieren.
    }
  }

  function newChat(): string {
    const id = `c${Date.now()}`;
    const chat: Chat = { id, title: "Neuer Chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    setChats((cs) => [chat, ...cs]);
    setActiveChatId(id);
    setTab("chats");
    return id;
  }

  function deleteChat(chatId: string) {
    setChats((cs) => cs.filter((c) => c.id !== chatId));
    if (activeChatId === chatId) setActiveChatId(null);
  }

  function openSettings() {
    setUrlDraft(serverUrl);
    setTokenDraft(apiToken);
    setSettingsOpen(true);
  }

  async function saveSettings() {
    const url = urlDraft.trim().replace(/\/+$/, "");
    const tok = tokenDraft.trim();
    const cwdVal = cwdDraft.trim();
    setServerUrl(url);
    setApiToken(tok);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, url);
      if (tok) await AsyncStorage.setItem(TOKEN_KEY, tok);
      else await AsyncStorage.removeItem(TOKEN_KEY);
      if (cwdVal) await AsyncStorage.setItem(CWD_KEY, cwdVal);
    } catch {
      // ignorieren
    }
    // Nur bei tatsächlicher Änderung den Server wechseln (vermeidet unnötigen pi-Neustart)
    if (cwdVal && cwdVal !== cwd) {
      try {
        await fetch(`${url}/api/set-cwd`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(tok ? { "X-API-Token": tok } : {}) },
          body: JSON.stringify({ cwd: cwdVal }),
        });
        setCwd(cwdVal);
      } catch {
        // ignorieren
      }
    }
    setSettingsOpen(false);
    registerPush(url, tok);
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

  async function send(text?: string) {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    let chatId = activeChatId;
    if (!chatId) chatId = newChat();
    setInput("");
    setThinking("");
    const userMsg: Msg = { id: `u${Date.now()}`, role: "user", text: message };
    const aiId = `a${Date.now()}`;
    const aiMsg: Msg = { id: aiId, role: "assistant", text: "", activity: [] };
    patchChat(chatId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? message.slice(0, 40) : c.title,
      messages: [...c.messages, userMsg, aiMsg],
      updatedAt: Date.now(),
    }));
    setBusy(true);

    try {
      await streamChat(message, chatId, aiId);
    } catch (e) {
      // Fallback: synchroner /chat
      try {
        const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/chat`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ message, chatId }),
        });
        const data = await res.json();
        const reply = (data.reply || data.error || "(keine Antwort)").trim();
        const activity: Activity[] = Array.isArray(data.activity) ? data.activity : [];
        patchMsg(chatId, aiId, (m) => ({ ...m, text: reply, activity }));
        if (speak && data.reply) speakReply(data.reply);
      } catch (e2) {
        appendMsg(chatId, {
          id: `e${Date.now()}`,
          role: "assistant",
          text: `Fehler: ${e2 instanceof Error ? e2.message : String(e2)}\n\nLäuft der Server? Server-URL: ${serverUrl}`,
        });
      }
    } finally {
      setBusy(false);
      setThinking("");
    }
  }

  async function streamChat(message: string, chatId: string, aiId: string) {
    const res = await streamFetch(`${serverUrl.replace(/\/+$/, "")}/api/chat/stream`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ message, chatId }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${errText.slice(0, 200)}`);
    }

    const body = res.body;
    if (!body) throw new Error("Kein Streaming-Body verfügbar");

    const reader = body.getReader();
    const decoder = new Utf8Decoder();
    let buffer = "";
    let finalReply = "";
    let finalActivity: Activity[] = [];

    const apply = (evt: unknown) => {
      const e = evt as { type?: string; data?: unknown };
      const t = e?.type;
      if (t === "text") {
        const delta = typeof e.data === "string" ? e.data : "";
        patchMsg(chatId, aiId, (m) => ({ ...m, text: m.text + delta }));
      } else if (t === "thinking") {
        const delta = typeof e.data === "string" ? e.data : "";
        setThinking((prev) => (prev + delta).slice(-800));
      } else if (t === "tool_start") {
        const d = (e.data || {}) as { id?: string; tool?: string; args?: unknown };
        const a: Activity = {
          id: d.id || `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          tool: d.tool || "?",
          status: "running",
          args: d.args,
        };
        patchMsg(chatId, aiId, (m) => ({ ...m, activity: [...(m.activity || []), a] }));
      } else if (t === "tool_end") {
        const d = (e.data || {}) as { id?: string; tool?: string; error?: boolean; result?: string };
        const err = !!d.error;
        const result = d.result || "";
        patchMsg(chatId, aiId, (m) => ({
          ...m,
          activity: (m.activity || []).map((x) =>
            x.id === d.id || (x.status === "running" && x.tool === d.tool)
              ? { ...x, status: err ? ("error" as const) : ("ok" as const), result }
              : x,
          ),
        }));
      } else if (t === "done") {
        const d = (e.data || {}) as { reply?: string; activity?: Activity[] };
        finalReply = d.reply || "";
        finalActivity = Array.isArray(d.activity) ? d.activity : [];
      } else if (t === "error") {
        const msg2 = typeof e.data === "string" ? e.data : String(e.data || "Fehler");
        appendMsg(chatId, { id: `e${Date.now()}`, role: "assistant", text: `⚠️ ${msg2}` });
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value as Uint8Array);
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        let evt: unknown;
        try {
          evt = JSON.parse(dataLine.slice(6));
        } catch {
          continue;
        }
        apply(evt);
      }
    }

    const finalText = finalReply.trim() || "(keine Antwort)";
    patchMsg(chatId, aiId, (m) => ({
      ...m,
      text: m.text || finalText,
      activity: m.activity && m.activity.length ? m.activity : finalActivity,
    }));
    if (speak && finalReply.trim()) speakReply(finalReply.trim());
  }

  async function abort() {
    try {
      await fetch(`${serverUrl.replace(/\/+$/, "")}/api/abort`, { method: "POST", headers: authHeaders() });
    } catch {
      // ignorieren
    }
  }

  // Native Spracherkennung (Diktieren) — Events registrieren
  useSpeechRecognitionEvent("start", () => {
    setListening(true);
    finalTranscriptRef.current = "";
  });
  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results[0]?.transcript ?? "";
    if (transcript) setInput(transcript);
    if (event.isFinal) finalTranscriptRef.current = transcript;
  });
  useSpeechRecognitionEvent("end", () => {
    setListening(false);
    const text = finalTranscriptRef.current.trim();
    finalTranscriptRef.current = "";
    if (text) send(text);
  });
  useSpeechRecognitionEvent("error", (event) => {
    setListening(false);
    finalTranscriptRef.current = "";
    if (event.error === "no-speech" || event.error === "aborted") {
      // nichts erkannt / abgebrochen – einfach zurücksetzen
    } else {
      setInput(`Spracherkennung: ${event.message || event.error}`);
    }
  });

  async function toggleMic() {
    if (listening) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        setInput("Bitte Mikrofon & Spracherkennung in den Einstellungen erlauben.");
        return;
      }
      setInput("");
      finalTranscriptRef.current = "";
      ExpoSpeechRecognitionModule.start({
        lang: "de-DE",
        interimResults: true,
        continuous: false,
        addsPunctuation: true,
        iosTaskHint: "dictation",
      });
    } catch {
      // ignorieren
    }
  }

  async function loadTasks() {
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/tasks`, { headers: authHeaders() });
      const data = await res.json();
      setTaskList(data.tasks || []);
    } catch {
      // Server nicht erreichbar – ignorieren
    }
  }

  async function addTask() {
    const message = taskInput.trim();
    if (!message) return;
    setTaskInput("");
    try {
      await fetch(`${serverUrl.replace(/\/+$/, "")}/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ message }),
      });
      loadTasks();
    } catch {
      // ignorieren
    }
  }

  function renderMessage({ item }: { item: Msg }) {
    const isUser = item.role === "user";
    const activity = !isUser ? item.activity || [] : [];
    return (
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.aiBubble]}>
        <Text style={isUser ? styles.userText : styles.aiText}>{item.text || (isUser ? "" : "…")}</Text>
        {activity.length > 0 ? (
          <View style={styles.activityWrap}>
            {activity.map((a) => (
              <View key={a.id} style={[styles.activityLine, a.status === "error" && styles.activityLineErr]}>
                <Text style={styles.activityText} numberOfLines={1}>
                  {a.status === "running" ? "⏳" : a.status === "ok" ? "✅" : "❌"} {a.tool}
                  {argSummary(a.args) ? `  ${argSummary(a.args)}` : ""}
                </Text>
                {a.result ? (
                  <Text style={styles.activityResult} numberOfLines={3}>
                    {a.result}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}
      </View>
    );
  }

  function renderChatItem({ item }: { item: Chat }) {
    const last = item.messages[item.messages.length - 1];
    const preview = last ? last.text.replace(/\n/g, " ").slice(0, 80) : "Neue Unterhaltung";
    const isActive = item.id === activeChatId;
    return (
      <Pressable onPress={() => setActiveChatId(item.id)} style={[styles.chatItem, isActive && styles.chatItemActive]}>
        <View style={styles.chatAvatar}>
          <Text style={styles.chatAvatarText}>💬</Text>
        </View>
        <View style={styles.chatInfo}>
          <Text style={styles.chatTitle} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.chatPreview} numberOfLines={1}>{preview}</Text>
        </View>
        <View style={styles.chatRight}>
          <Text style={styles.chatTime}>{formatTime(item.updatedAt)}</Text>
          <Pressable onPress={() => deleteChat(item.id)} hitSlop={8}>
            <Text style={styles.chatDelete}>✕</Text>
          </Pressable>
        </View>
      </Pressable>
    );
  }

  function renderTask(task: Task) {
    const statusInfo: Record<string, { label: string; color: string }> = {
      pending: { label: "wartet", color: "#94a3b8" },
      running: { label: "läuft…", color: "#f59e0b" },
      done: { label: "fertig", color: "#22c55e" },
      error: { label: "fehler", color: "#ef4444" },
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
      <StatusBar style="light" />

      <View style={styles.header}>
        {activeChatId && tab === "chats" ? (
          <Pressable onPress={() => setActiveChatId(null)} style={styles.backBtn} hitSlop={8}>
            <Text style={styles.backText}>‹</Text>
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
          <View style={styles.statusRow}>
            <View style={styles.dot} />
            <Text style={styles.headerSub}>verbunden</Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          {activeChatId && tab === "chats" ? (
            <Pressable onPress={() => deleteChat(activeChatId)} style={styles.chip} hitSlop={6}>
              <Text style={styles.chipText}>🗑️</Text>
            </Pressable>
          ) : (
            <Pressable onPress={() => newChat()} style={[styles.chip, styles.chipNew]} hitSlop={6}>
              <Text style={styles.chipNewText}>✚ Neu</Text>
            </Pressable>
          )}
          <Pressable onPress={() => setSpeak((s) => !s)} style={[styles.chip, speak && styles.chipActive]} hitSlop={6}>
            <Text style={styles.chipText}>{speak ? "🔊" : "🔇"}</Text>
          </Pressable>
          <Pressable onPress={openSettings} style={styles.chip} hitSlop={6}>
            <Text style={styles.chipText}>⚙️</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.tabs}>
        <Pressable onPress={() => setTab("chats")} style={[styles.tab, tab === "chats" && styles.tabActive]}>
          <Text style={[styles.tabText, tab === "chats" && styles.tabTextActive]}>💬 Chats</Text>
        </Pressable>
        <Pressable onPress={() => setTab("tasks")} style={[styles.tab, tab === "tasks" && styles.tabActive]}>
          <Text style={[styles.tabText, tab === "tasks" && styles.tabTextActive]}>📋 Aufgaben</Text>
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
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>Womit kann ich helfen? 👋</Text>
                  <Text style={styles.emptyText}>
                    Schreib mir oder tippe auf 🎤 und sprich.{"\n"}Ich kann Dateien ändern, Code ausführen und recherchieren.
                  </Text>
                </View>
              }
              ListFooterComponent={
                busy ? (
                  <View style={styles.thinking}>
                    <ActivityIndicator color={colors.accent} size="small" />
                    <Text style={styles.thinkingText} numberOfLines={1}>
                      {thinking ? `💭 ${thinking}` : listening ? "höre zu …" : "denkt nach …"}
                    </Text>
                  </View>
                ) : null
              }
            />

            <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
              <View style={styles.inputBar}>
                {busy ? (
                  <Pressable onPress={abort} style={[styles.micBtn, styles.stopBtn]}>
                    <Text style={styles.micText}>⏹</Text>
                  </Pressable>
                ) : (
                  <Pressable onPress={toggleMic} style={[styles.micBtn, listening && styles.micBtnActive]}>
                    <Text style={styles.micText}>🎤</Text>
                  </Pressable>
                )}
                <TextInput
                  style={styles.input}
                  value={input}
                  onChangeText={setInput}
                  placeholder="Nachricht an KittyAI …"
                  placeholderTextColor={colors.muted}
                  multiline
                  onSubmitEditing={() => send()}
                  returnKeyType="send"
                />
                <Pressable
                  onPress={() => send()}
                  disabled={busy || !input.trim()}
                  style={[styles.sendBtn, (busy || !input.trim()) && styles.sendBtnDisabled]}
                >
                  <Text style={styles.sendText}>➤</Text>
                </Pressable>
              </View>
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
                  <Text style={styles.emptyTitle}>Noch keine Chats 💬</Text>
                  <Text style={styles.emptyText}>
                    Starte deine erste Unterhaltung –{"\n"}tippe oben auf „✚ Neu".
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
              <Text style={styles.sendText}>➤</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            <Text style={styles.taskHint}>
              Aufgaben laufen im Hintergrund auf dem Server. Du bekommst eine Push-Nachricht, wenn eine fertig ist.
            </Text>
            {taskList.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>Noch keine Aufgaben 📋</Text>
              </View>
            ) : (
              taskList.map(renderTask)
            )}
          </ScrollView>
        </>
      )}

      <Modal visible={settingsOpen} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Server-Einstellungen</Text>
            <Text style={styles.modalHint}>Server-Adresse (normalerweise automatisch erkannt):</Text>
            <TextInput
              style={styles.urlInput}
              value={urlDraft}
              onChangeText={setUrlDraft}
              placeholder="https://lawnware.uk:8446"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Text style={styles.modalHint}>API-Token (aus /etc/pi-app-secrets.env):</Text>
            <TextInput
              style={styles.urlInput}
              value={tokenDraft}
              onChangeText={setTokenDraft}
              placeholder="API-Token"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Text style={styles.modalHint}>Arbeitsverzeichnis (wo pi arbeitet, z. B. /opt/pi-app):</Text>
            <TextInput
              style={styles.urlInput}
              value={cwdDraft}
              onChangeText={setCwdDraft}
              placeholder="/opt/pi-app/memory"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.modalButtons}>
              <Pressable
                onPress={() => {
                  const auto = detectBase();
                  setUrlDraft(auto);
                  setServerUrl(auto);
                  AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
                  setSettingsOpen(false);
                }}
                style={styles.modalCancel}
              >
                <Text style={styles.modalCancelText}>Auto</Text>
              </Pressable>
              <Pressable onPress={() => setSettingsOpen(false)} style={styles.modalCancel}>
                <Text style={styles.modalCancelText}>Abbrechen</Text>
              </Pressable>
              <Pressable onPress={saveSettings} style={styles.modalSave}>
                <Text style={styles.modalSaveText}>Speichern</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
  backText: { color: colors.accent, fontSize: 32, lineHeight: 34, fontWeight: "600" },
  headerTitles: { flex: 1, marginLeft: 10 },
  headerTitle: { fontSize: 17, fontWeight: "700", color: colors.text },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success },
  headerSub: { fontSize: 12, color: colors.muted },
  headerActions: { flexDirection: "row", gap: 7 },
  chip: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.surface2 },
  chipActive: { backgroundColor: colors.accentSoft },
  chipNew: { backgroundColor: colors.accent },
  chipNewText: { fontSize: 13, color: "#fff", fontWeight: "600" },
  chipText: { fontSize: 13, color: colors.text },
  tabs: { flexDirection: "row", backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  tab: { flex: 1, alignItems: "center", paddingVertical: 11 },
  tabActive: { borderBottomWidth: 2, borderBottomColor: colors.accent },
  tabText: { fontSize: 15, color: colors.muted },
  tabTextActive: { color: colors.accent, fontWeight: "700" },
  list: { flex: 1 },
  listContent: { padding: 12, gap: 8 },
  bubble: { maxWidth: "86%", padding: 12, borderRadius: 18 },
  userBubble: { alignSelf: "flex-end", backgroundColor: colors.accent, borderBottomRightRadius: 5 },
  aiBubble: { alignSelf: "flex-start", backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderBottomLeftRadius: 5 },
  userText: { color: "#ffffff", fontSize: 16, lineHeight: 22 },
  aiText: { color: colors.text, fontSize: 16, lineHeight: 22 },
  activityWrap: { gap: 3, marginTop: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 6 },
  activityLine: {
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  activityLineErr: { borderColor: colors.danger },
  activityText: { color: colors.muted, fontSize: 12 },
  activityResult: { color: colors.muted, fontSize: 11, fontFamily: "Courier", marginTop: 2 },
  empty: { alignItems: "center", marginTop: 70, paddingHorizontal: 28 },
  emptyTitle: { fontSize: 22, fontWeight: "800", color: colors.text, textAlign: "center" },
  emptyText: { fontSize: 15, color: colors.muted, textAlign: "center", marginTop: 10, lineHeight: 22 },
  thinking: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 4 },
  thinkingText: { color: colors.muted, fontSize: 13, flex: 1 },
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
  chatAvatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" },
  chatAvatarText: { fontSize: 18 },
  chatInfo: { flex: 1 },
  chatTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  chatPreview: { fontSize: 13, color: colors.muted, marginTop: 2 },
  chatRight: { alignItems: "flex-end", gap: 6 },
  chatTime: { fontSize: 11, color: colors.muted },
  chatDelete: { fontSize: 14, color: colors.danger, fontWeight: "700" },
  micBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" },
  micBtnActive: { backgroundColor: colors.danger },
  stopBtn: { backgroundColor: colors.danger },
  micText: { fontSize: 20 },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 21,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface2,
  },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  sendBtnDisabled: { backgroundColor: "#3a4150" },
  sendText: { color: "#ffffff", fontSize: 18 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(8,11,18,0.7)", justifyContent: "center", padding: 24 },
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
