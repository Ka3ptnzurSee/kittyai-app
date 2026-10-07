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
import { useAudioRecorder, useAudioPlayer, AudioModule, RecordingPresets } from "expo-audio";
import { File, Paths } from "expo-file-system";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

type Msg = { id: string; role: "user" | "assistant"; text: string };
type Task = {
  id: string;
  message: string;
  status: "pending" | "running" | "done" | "error";
  result?: string;
  createdAt?: string;
  doneAt?: string;
};

const STORAGE_KEY = "pi-server-url";
const CHAT_KEY = "pi-chat-history";

// Dark Theme (aus der alten KittyAI-Version)
const colors = {
  bg: "#0b0d12",
  panel: "#161a23",
  panel2: "#1d222e",
  text: "#eef1f6",
  muted: "#8b93a3",
  accent: "#5b8cff",
  accent2: "#3b6ef0",
  border: "#242a36",
  danger: "#ff5c6a",
  success: "#34d399",
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
  const [tab, setTab] = useState<"chat" | "tasks">("chat");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(true);
  const [serverUrl, setServerUrl] = useState<string>(() => detectBase());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState<string>(() => detectBase());
  const [taskList, setTaskList] = useState<Task[]>([]);
  const [taskInput, setTaskInput] = useState("");
  const listRef = useRef<FlatList<Msg>>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const player = useAudioPlayer();

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
      try {
        const savedChat = await AsyncStorage.getItem(CHAT_KEY);
        if (savedChat) {
          const parsed = JSON.parse(savedChat);
          if (Array.isArray(parsed)) setMessages(parsed);
        }
      } catch {
        // ignorieren
      }
      registerPush(url);
    })();
  }, []);

  // Chat-Verlauf automatisch speichern
  useEffect(() => {
    if (messages.length === 0) return;
    AsyncStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-200))).catch(() => {
      // ignorieren
    });
  }, [messages]);

  // Aufgaben automatisch aktualisieren, solange der Tab offen ist
  useEffect(() => {
    if (tab !== "tasks") return;
    loadTasks();
    const t = setInterval(loadTasks, 4000);
    return () => clearInterval(t);
  }, [tab, serverUrl]);

  async function registerPush(url: string) {
    try {
      const { status } = await Notifications.requestPermissionsAsync();
      if (status !== "granted") return;
      const token = (await Notifications.getExpoPushTokenAsync()).data;
      await fetch(`${url.replace(/\/+$/, "")}/register-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch {
      // In Expo Go sind Push-Benachrichtigungen nicht verfügbar – ignorieren.
    }
  }

  async function clearChat() {
    setMessages([]);
    try {
      await AsyncStorage.removeItem(CHAT_KEY);
    } catch {
      // ignorieren
    }
  }

  async function saveSettings() {
    const url = urlDraft.trim().replace(/\/+$/, "");
    setServerUrl(url);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, url);
    } catch {
      // ignorieren
    }
    setSettingsOpen(false);
    registerPush(url);
  }

  async function speakReply(text: string) {
    // 1) ElevenLabs (wie im Jarvis-Repo) – beste Qualität
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      // ElevenLabs nicht erreichbar → Fallback
    }
    // 2) Fallback: native iOS-Stimme
    Speech.speak(text, { language: "de-DE" });
  }

  async function send(text?: string) {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    setInput("");
    const userMsg: Msg = { id: `u${Date.now()}`, role: "user", text: message };
    setMessages((m) => [...m, userMsg]);
    setBusy(true);

    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      const reply = (data.reply || data.error || "(keine Antwort)").trim();
      const aiMsg: Msg = { id: `a${Date.now()}`, role: "assistant", text: reply };
      setMessages((m) => [...m, aiMsg]);
      if (speak && reply && data.reply) {
        speakReply(reply);
      }
    } catch (e) {
      const msg =
        `Fehler: ${e instanceof Error ? e.message : String(e)}\n\n` +
        `Läuft der Server?\n  node server.js\n\nServer-URL: ${serverUrl}`;
      setMessages((m) => [...m, { id: `a${Date.now()}`, role: "assistant", text: msg }]);
    } finally {
      setBusy(false);
    }
  }

  async function toggleMic() {
    if (listening) {
      try {
        await recorder.stop();
        setListening(false);
        const uri = recorder.uri;
        if (uri) {
          const base64 = await new File(uri).base64();
          setBusy(true);
          const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/stt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audioBase64: base64, mimeType: "audio/m4a" }),
          });
          const data = await res.json();
          if (data.text) {
            setInput(data.text.trim());
            setBusy(false);
            send(data.text.trim());
            return;
          } else if (data.error) {
            setMessages((m) => [...m, { id: `a${Date.now()}`, role: "assistant", text: `🎤 ${data.error}` }]);
          }
        }
      } catch (e) {
        setMessages((m) => [
          ...m,
          { id: `a${Date.now()}`, role: "assistant", text: `🎤 Fehler: ${e instanceof Error ? e.message : String(e)}` },
        ]);
      } finally {
        setListening(false);
        setBusy(false);
      }
      return;
    }

    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setMessages((m) => [...m, { id: `a${Date.now()}`, role: "assistant", text: "🎤 Mikrofon-Berechtigung fehlt." }]);
        return;
      }
      await AudioModule.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setListening(true);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: `a${Date.now()}`, role: "assistant", text: `🎤 Fehler: ${e instanceof Error ? e.message : String(e)}` },
      ]);
    }
  }

  async function loadTasks() {
    try {
      const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/tasks`);
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      loadTasks();
    } catch {
      // ignorieren
    }
  }

  function renderMessage({ item }: { item: Msg }) {
    const isUser = item.role === "user";
    return (
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.aiBubble]}>
        <Text style={isUser ? styles.userText : styles.aiText}>{item.text}</Text>
      </View>
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
          <Text style={styles.taskMessage} numberOfLines={2}>
            {task.message}
          </Text>
          <View style={[styles.taskBadge, { backgroundColor: s.color }]}>
            <Text style={styles.taskBadgeText}>{s.label}</Text>
          </View>
        </View>
        {task.result ? (
          <Text style={styles.taskResult} numberOfLines={4}>
            {task.result}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <View style={styles.logo}>
          <Text style={styles.logoText}>K</Text>
        </View>
        <View style={styles.headerTitles}>
          <Text style={styles.headerTitle}>KittyAI</Text>
          <View style={styles.statusRow}>
            <View style={styles.dot} />
            <Text style={styles.headerSub}>verbunden</Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          <Pressable onPress={() => setSpeak((s) => !s)} style={[styles.chip, speak && styles.chipActive]}>
            <Text style={styles.chipText}>{speak ? "🔊 an" : "🔇 aus"}</Text>
          </Pressable>
          <Pressable onPress={clearChat} style={styles.chip}>
            <Text style={styles.chipText}>🗑️</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setUrlDraft(serverUrl);
              setSettingsOpen(true);
            }}
            style={styles.chip}
          >
            <Text style={styles.chipText}>⚙️ Server</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.tabs}>
        <Pressable
          onPress={() => setTab("chat")}
          style={[styles.tab, tab === "chat" && styles.tabActive]}
        >
          <Text style={[styles.tabText, tab === "chat" && styles.tabTextActive]}>💬 Chat</Text>
        </Pressable>
        <Pressable
          onPress={() => setTab("tasks")}
          style={[styles.tab, tab === "tasks" && styles.tabActive]}
        >
          <Text style={[styles.tabText, tab === "tasks" && styles.tabTextActive]}>📋 Aufgaben</Text>
        </Pressable>
      </View>

      {tab === "chat" ? (
        <>
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={renderMessage}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>Hallo 👋</Text>
                <Text style={styles.emptyText}>
                  Schreib mir oder tippe auf 🎤 und sprich.{"\n"}Die Antwort wird vorgelesen (🔊).
                </Text>
              </View>
            }
            ListFooterComponent={
              busy ? (
                <View style={styles.thinking}>
                  <ActivityIndicator color="#3b82f6" />
                  <Text style={styles.thinkingText}>{listening ? "höre zu …" : "KittyAI denkt nach …"}</Text>
                </View>
              ) : null
            }
          />

          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <View style={styles.inputBar}>
              <Pressable onPress={toggleMic} disabled={busy} style={[styles.micBtn, listening && styles.micBtnActive]}>
                <Text style={styles.micText}>🎤</Text>
              </Pressable>
              <TextInput
                style={styles.input}
                value={input}
                onChangeText={setInput}
                placeholder="Nachricht an KittyAI …"
                placeholderTextColor="#94a3b8"
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
          <View style={styles.taskInputBar}>
            <TextInput
              style={styles.input}
              value={taskInput}
              onChangeText={setTaskInput}
              placeholder="Langzeit-Aufgabe an KittyAI … (z. B. Recherchiere X)"
              placeholderTextColor="#94a3b8"
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
            <Text style={styles.modalHint}>
              Normalerweise wird die Adresse automatisch erkannt. Nur falls das nicht klappt, kannst du hier manuell
              die Adresse des Metro-Servers eintragen:
            </Text>
            <TextInput
              style={styles.urlInput}
              value={urlDraft}
              onChangeText={setUrlDraft}
              placeholder="http://192.168.1.100:8081"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
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
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.panel,
  },
  logo: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  logoText: { color: "#fff", fontWeight: "800", fontSize: 18 },
  headerTitles: { flex: 1, marginLeft: 10 },
  headerTitle: { fontSize: 17, fontWeight: "700", color: colors.text },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success },
  headerSub: { fontSize: 12, color: colors.muted },
  headerActions: { flexDirection: "row", gap: 8 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.panel2 },
  chipActive: { backgroundColor: colors.accent2 },
  chipText: { fontSize: 13, color: colors.text },
  tabs: { flexDirection: "row", backgroundColor: colors.panel, borderBottomWidth: 1, borderBottomColor: colors.border },
  tab: { flex: 1, alignItems: "center", paddingVertical: 10 },
  tabActive: { borderBottomWidth: 2, borderBottomColor: colors.accent },
  tabText: { fontSize: 15, color: colors.muted },
  tabTextActive: { color: colors.accent, fontWeight: "700" },
  list: { flex: 1 },
  listContent: { padding: 12, gap: 8 },
  bubble: { maxWidth: "85%", padding: 12, borderRadius: 16 },
  userBubble: { alignSelf: "flex-end", backgroundColor: colors.accent },
  aiBubble: { alignSelf: "flex-start", backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  userText: { color: "#ffffff", fontSize: 16, lineHeight: 22 },
  aiText: { color: colors.text, fontSize: 16, lineHeight: 22 },
  empty: { alignItems: "center", marginTop: 60, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 24, fontWeight: "800", color: colors.text },
  emptyText: { fontSize: 15, color: colors.muted, textAlign: "center", marginTop: 8, lineHeight: 22 },
  thinking: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  thinkingText: { color: colors.muted, fontSize: 14 },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.panel,
  },
  taskInputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.panel,
  },
  taskHint: { fontSize: 13, color: colors.muted, lineHeight: 18, marginBottom: 4 },
  taskCard: {
    backgroundColor: colors.panel,
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
  micBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.panel2, alignItems: "center", justifyContent: "center" },
  micBtnActive: { backgroundColor: colors.danger },
  micText: { fontSize: 20 },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.panel2,
  },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  sendBtnDisabled: { backgroundColor: "#3a4150" },
  sendText: { color: "#ffffff", fontSize: 18 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.5)", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: colors.panel, borderRadius: 16, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  modalHint: { fontSize: 13, color: colors.muted, marginTop: 8, lineHeight: 18 },
  urlInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.panel2,
    marginTop: 12,
  },
  modalButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 16 },
  modalCancel: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  modalCancelText: { color: colors.muted, fontSize: 15 },
  modalSave: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.accent },
  modalSaveText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
});
