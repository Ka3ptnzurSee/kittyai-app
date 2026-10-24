import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
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
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { Utf8Decoder, argSummary, formatTime, uid } from "./lib";
import * as Clipboard from "expo-clipboard";

type Activity = { id: string; tool: string; status: "running" | "ok" | "error"; args?: unknown; result?: string };
type Msg = { id: string; role: "user" | "assistant"; text: string; activity?: Activity[]; images?: { uri: string }[]; replyTo?: { text: string } };
type Chat = { id: string; title: string; messages: Msg[]; createdAt: number; updatedAt: number };
type Task = {
  id: string;
  message: string;
  status: "pending" | "running" | "done" | "error";
  result?: string;
  createdAt?: string;
  doneAt?: string;
};

const STORAGE_KEY = "pi-server-url";
const TOKEN_KEY = "pi-api-token";
const CHATS_KEY = "pi-chats-v2";
const CWD_KEY = "pi-cwd";
const STREAM_TIMEOUT_MS = 30 * 60 * 1000; // 30 min – deckt PROMPT_TIMEOUT_MS ab
const MAX_REPLY_CHARS = 20000; // Antworttext pro Nachricht deckeln (OOM-Schutz)
const MAX_BUFFER_CHARS = 200000; // SSE-Parser-Puffer deckeln

// Claude-Design (anthropic Design-Tokens, warmes Hell-Theme)
// Quelle: https://claude.com (offizielle CSS-Design-Tokens)
const colors = {
  bg: "#faf9f5", // --color-gray-050
  surface: "#ffffff", // --color-gray-000
  surface2: "#f5f4ed", // --color-gray-100
  text: "#141413", // --color-gray-950
  muted: "#87867f", // --color-gray-500
  accent: "#d97757", // --color-clay
  accentHover: "#c46849", // --color-clay-dark
  accentSoft: "#f5f4ed", // --color-gray-100
  border: "#e8e6dc", // --color-gray-200
  danger: "#bf4d43", // --color-error
  success: "#629987", // --color-mineral
  warning: "#d97757", // --color-clay
};

// Claude rendert KI-Antworten in einer Serifenschrift (Markenzeichen).
// Auf iOS: Georgia, auf Android: systemeigene Serif.
const aiFontFamily = Platform.select({ ios: "Georgia", android: "serif", default: "serif" });

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
  const [busyChatIds, setBusyChatIds] = useState<Set<string>>(() => new Set());
  const [thinkingByChat, setThinkingByChat] = useState<Record<string, string>>({});
  const [listening, setListening] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Msg | null>(null);
  const [pendingImages, setPendingImages] = useState<{ data: string; mediaType: string; uri: string }[]>([]);
  const [pendingFiles, setPendingFiles] = useState<{ name: string; content: string }[]>([]);
  const [pendingDocuments, setPendingDocuments] = useState<{ name: string; data: string; mimeType: string }[]>([]);
  const [speak, setSpeak] = useState(false); // Standard: Textantwort; Sprachausgabe nur auf Wunsch
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
  const dictationBaseRef = useRef("");
  const finalSegmentsRef = useRef(""); // vollständig erkannter Text (Final-Segmente werden angehängt; iOS prependet ab dem 2. Segment ein Leerzeichen)
  const inputRef = useRef("");
  useEffect(() => {
    inputRef.current = input;
  }, [input]);
  const player = useAudioPlayer();
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const abortedRef = useRef<Set<string>>(new Set());
  const tasksAbortRef = useRef<AbortController | null>(null);

  const activeChat = chats.find((c) => c.id === activeChatId) || null;
  const isThisChatBusy = activeChatId ? busyChatIds.has(activeChatId) : false;
  const thisThinking = activeChatId ? thinkingByChat[activeChatId] || "" : "";

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

  // Beim Chat-Wechsel zur letzten Nachricht scrollen
  useEffect(() => {
    if (activeChatId) {
      const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 60);
      return () => clearTimeout(t);
    }
  }, [activeChatId]);

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
        if (savedToken) {
          setApiToken(savedToken);
        } else {
          // Auto-Token aus Build-Zeit-Secret (EXPO_PUBLIC_API_TOKEN)
          const cfgToken = (process.env as any)?.EXPO_PUBLIC_API_TOKEN || "";
          if (cfgToken) {
            savedToken = cfgToken;
            setApiToken(cfgToken);
            await AsyncStorage.setItem(TOKEN_KEY, cfgToken);
          }
        }
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
        const r = await fetch(`${url}/api/set-cwd`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(tok && url.startsWith("https://") ? { "X-API-Token": tok } : {}) },
          body: JSON.stringify({ cwd: cwdVal }),
        });
        if (r.ok) setCwd(cwdVal);
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
    const userMsg: Msg = { id: uid("u"), role: "user", text: `🎨 ${prompt}` };
    const aiId = uid("a");
    const aiMsg: Msg = { id: aiId, role: "assistant", text: "", images: [] };
    patchChat(chatId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? prompt.slice(0, 40) : c.title,
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
      patchMsg(chatId, aiId, (m) => ({ ...m, text: "🖼", images: [{ uri: imgUri }] }));
      if (speak) speakReply("Hier ist das Bild.");
    } catch (e) {
      const msg = ctrl.signal.aborted ? "Zeitüberschreitung bei der Bild-Generierung" : (e instanceof Error ? e.message : String(e));
      appendMsg(chatId, { id: uid("e"), role: "assistant", text: `Bild-Generierung fehlgeschlagen: ${msg}` });
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
    const userMsg: Msg = { id: uid("u"), role: "user", text: message || (imageUris.length ? "🖼 Bild" : documents.length ? "📄 PDF" : "📎 Datei"), images: imageUris, replyTo };
    const aiId = uid("a");
    setPendingImages([]);
    setPendingFiles([]);
    setPendingDocuments([]);
    setReplyingTo(null);
    const aiMsg: Msg = { id: aiId, role: "assistant", text: "", activity: [] };
    patchChat(chatId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? message.slice(0, 40) : c.title,
      messages: [...c.messages, userMsg, aiMsg],
      updatedAt: Date.now(),
    }));
    abortedRef.current.delete(chatId);
    markBusy(chatId, true);

    try {
      await streamChat(finalMessage, chatId, aiId, images, documents);
    } catch (e) {
      if (abortedRef.current.has(chatId)) {
        abortedRef.current.delete(chatId);
        return; // Nutzer-Abbruch → kein Fallback
      }
      // Einmaliger Retry bei Netzwerk-Fehler (Verbindung verloren / fetch failed)
      const rawErr = e instanceof Error ? e.message : String(e);
      if (/network|fetch failed|connection lost|timed out|request failed/i.test(rawErr)) {
        try {
          await new Promise((r) => setTimeout(r, 1500));
          if (abortedRef.current.has(chatId)) return;
          await streamChat(finalMessage, chatId, aiId, images, documents);
          return;
        } catch {
          // Retry fehlgeschlagen → Fallback unten
        }
      }
      // Fallback: synchroner /chat (mit eigenem Abort-Timeout gegen Busy-Lockup)
      const ctrl = new AbortController();
      abortControllersRef.current.set(chatId, ctrl);
      const timer = setTimeout(() => ctrl.abort(), STREAM_TIMEOUT_MS);
      try {
        const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/chat`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ message: finalMessage, chatId, images, documents }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const ct = res.headers.get("content-type") || "";
          const body = await res.text().catch(() => "");
          throw new Error(ct.includes("json") ? body.slice(0, 200) : `Server/Proxy-Fehler (HTTP ${res.status})`);
        }
        const data = await res.json();
        const reply = (data.reply || data.error || "(keine Antwort)").trim().slice(0, MAX_REPLY_CHARS);
        const activity: Activity[] = (Array.isArray(data.activity) ? data.activity : []).map((a: Activity) => ({ ...a, result: (a.result || "").slice(0, 4000) }));
        patchMsg(chatId, aiId, (m) => ({ ...m, text: reply, activity }));
        if (speak && data.reply) speakReply(data.reply);
      } catch (e2) {
        const rawMsg = ctrl.signal.aborted ? "Zeitüberschreitung beim Server" : (e2 instanceof Error ? e2.message : String(e2));
        const msg = /network|fetch failed|connection lost|request failed/i.test(rawMsg)
          ? "Verbindung unterbrochen (Netzwerk) — bitte erneut senden"
          : rawMsg;
        appendMsg(chatId, {
          id: uid("e"),
          role: "assistant",
          text: `Fehler: ${msg}\n\nLäuft der Server? Server-URL: ${serverUrl}`,
        });
      } finally {
        clearTimeout(timer);
        if (abortControllersRef.current.get(chatId) === ctrl) abortControllersRef.current.delete(chatId);
      }
    } finally {
      markBusy(chatId, false);
      setChatThinking(chatId, "");
    }
  }

  async function streamChat(message: string, chatId: string, aiId: string, images: { data: string; mediaType: string }[] = [], documents: { name: string; data: string; mimeType: string }[] = []) {
    const controller = new AbortController();
    abortControllersRef.current.set(chatId, controller);
    const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
    try {
    const res = await streamFetch(`${serverUrl.replace(/\/+$/, "")}/api/chat/stream`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ message, chatId, images, documents }),
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
    let buffer = "";
    let finalReply = "";
    let finalActivity: Activity[] = [];

    const apply = (evt: unknown) => {
      const e = evt as { type?: string; data?: unknown };
      const t = e?.type;
      if (t === "text") {
        const delta = typeof e.data === "string" ? e.data : "";
        patchMsg(chatId, aiId, (m) => ({ ...m, text: (m.text + delta).slice(-MAX_REPLY_CHARS) }));
      } else if (t === "thinking") {
        const delta = typeof e.data === "string" ? e.data : "";
        setThinkingByChat((prev) => ({ ...prev, [chatId]: ((prev[chatId] || "") + delta).slice(-800) }));
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
        const result = (d.result || "").slice(0, 4000);
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
        finalReply = (d.reply || "").slice(0, MAX_REPLY_CHARS);
        finalActivity = (Array.isArray(d.activity) ? d.activity : []).map((a) => ({ ...a, result: (a.result || "").slice(0, 4000) }));
      } else if (t === "error") {
        const msg2 = typeof e.data === "string" ? e.data : String(e.data || "Fehler");
        appendMsg(chatId, { id: uid("e"), role: "assistant", text: `⚠️ ${msg2}` });
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value as Uint8Array);
      if (buffer.length < MAX_BUFFER_CHARS) buffer += chunk;
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
    } finally {
      clearTimeout(timer);
      if (abortControllersRef.current.get(chatId) === controller) abortControllersRef.current.delete(chatId);
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

  function copyToClipboard(text: string) {
    if (!text) return;
    Clipboard.setStringAsync(text).catch(() => {
      // ignorieren
    });
  }

  function showMessageActions(msg: Msg) {
    const preview = msg.text.replace(/\n+/g, " ").trim().slice(0, 120) || "(leer)";
    Alert.alert("Nachricht", preview, [
      { text: "📋 Kopieren", onPress: () => copyToClipboard(msg.text) },
      { text: "↩️ Antworten", onPress: () => setReplyingTo(msg) },
      { text: "Abbrechen", style: "cancel" },
    ]);
  }

  function renderMessage({ item }: { item: Msg }) {
    const isUser = item.role === "user";
    const activity = !isUser ? item.activity || [] : [];
    const messages = activeChat?.messages || [];
    const isLast = messages.length > 0 && messages[messages.length - 1].id === item.id;
    const bubbleStyle = isUser
      ? styles.userBubble
      : isLast && isThisChatBusy && !item.text
        ? styles.aiBubbleRunning
        : isLast && !isThisChatBusy && !!item.text
          ? styles.aiBubbleDone
          : styles.aiBubble;
    return (
      <Pressable
        onLongPress={() => showMessageActions(item)}
        delayLongPress={300}
        style={[styles.bubble, bubbleStyle]}
      >
        {item.replyTo ? (
          <View style={styles.replyQuote}>
            <Text style={styles.replyQuoteText} numberOfLines={2}>{item.replyTo.text}</Text>
          </View>
        ) : null}
        <Text style={isUser ? styles.userText : styles.aiText}>{item.text || (isUser ? "" : "…")}</Text>
        {item.images && item.images.length > 0 ? (
          item.images.map((img, i) => (
            <Image key={i} source={{ uri: img.uri }} style={styles.msgImage} resizeMode="contain" />
          ))
        ) : null}
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
      </Pressable>
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
            <Text style={styles.chipText}>{speak ? "🔊 Gespräch" : "💬 Text"}</Text>
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
                isThisChatBusy ? (
                  <View style={styles.thinking}>
                    <ActivityIndicator color={colors.accent} size="small" />
                    <Text style={styles.thinkingText} numberOfLines={1}>
                      {thisThinking ? `💭 ${thisThinking}` : listening ? "höre zu …" : "denkt nach …"}
                    </Text>
                  </View>
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
                    <Text style={styles.attachClear}>✕</Text>
                  </Pressable>
                </View>
              ) : null}
              {(pendingImages.length > 0 || pendingFiles.length > 0 || pendingDocuments.length > 0) && (
                <View style={styles.attachPreview}>
                  {pendingImages.map((im, i) => (
                    <Text key={`img${i}`} style={styles.attachChip}>🖼 Bild</Text>
                  ))}
                  {pendingDocuments.map((d, i) => (
                    <Text key={`doc${i}`} style={styles.attachChip} numberOfLines={1}>📄 {d.name}</Text>
                  ))}
                  {pendingFiles.map((f, i) => (
                    <Text key={`file${i}`} style={styles.attachChip} numberOfLines={1}>📎 {f.name}</Text>
                  ))}
                  <Pressable onPress={() => { setPendingImages([]); setPendingFiles([]); setPendingDocuments([]); }} hitSlop={8}>
                    <Text style={styles.attachClear}>✕</Text>
                  </Pressable>
                </View>
              )}
              <View style={styles.inputBar}>
                {isThisChatBusy ? (
                  <Pressable onPress={() => abort(activeChatId || undefined)} style={[styles.micBtn, styles.stopBtn]}>
                    <Text style={styles.micText}>⏹</Text>
                  </Pressable>
                ) : (
                  <Pressable onPress={toggleMic} style={[styles.micBtn, listening && styles.micBtnActive]}>
                    <Text style={styles.micText}>🎤</Text>
                  </Pressable>
                )}
                <Pressable onPress={pickImage} style={styles.micBtn}>
                  <Text style={styles.micText}>🖼</Text>
                </Pressable>
                <Pressable onPress={pickFile} style={styles.micBtn}>
                  <Text style={styles.micText}>📎</Text>
                </Pressable>
                <Pressable onPress={generateImageInChat} style={styles.micBtn}>
                  <Text style={styles.micText}>🎨</Text>
                </Pressable>
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
                  disabled={isThisChatBusy || !input.trim()}
                  style={[styles.sendBtn, (isThisChatBusy || !input.trim()) && styles.sendBtnDisabled]}
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
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.surface2 },
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
  aiBubbleRunning: { alignSelf: "flex-start", backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.danger, borderBottomLeftRadius: 5 },
  aiBubbleDone: { alignSelf: "flex-start", backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.success, borderBottomLeftRadius: 5 },
  msgImage: { width: "100%", height: 220, borderRadius: 12, marginTop: 8, backgroundColor: colors.surface2 },
  userText: { color: "#ffffff", fontSize: 16, lineHeight: 22, fontFamily: Platform.select({ ios: undefined, android: "sans-serif" }) },
  aiText: { color: colors.text, fontSize: 17, lineHeight: 26, fontFamily: aiFontFamily },
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
  micBtn: { width: 42, height: 42, borderRadius: 999, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" },
  micBtnActive: { backgroundColor: colors.danger },
  attachPreview: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, padding: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  attachChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border, color: colors.text, fontSize: 13, maxWidth: 200 },
  attachClear: { color: colors.danger, fontSize: 16, fontWeight: "700", paddingHorizontal: 6 },
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
    backgroundColor: "rgba(255,255,255,0.18)",
    borderLeftWidth: 3,
    borderLeftColor: "#ffffff",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 6,
  },
  replyQuoteText: { color: "#ffffff", fontSize: 13, fontStyle: "italic" },
  stopBtn: { backgroundColor: colors.danger },
  micText: { fontSize: 20 },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  sendBtn: { width: 42, height: 42, borderRadius: 999, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  sendBtnDisabled: { backgroundColor: colors.muted },
  sendText: { color: "#ffffff", fontSize: 18 },
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
