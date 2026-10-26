import { Text } from "react-native";

// Einfache Text-Icon-Komponente als Ersatz für @expo/vector-icons (Ionicons).
// Verhindert natives Font-Modul beim Start (verursachte sofortigen Start-Crash).
const GLYPHS: Record<string, string> = {
  "key-outline": "🔑",
  "checkmark-circle-outline": "✓",
  "close-circle-outline": "✕",
  "alert-circle-outline": "⚠",
  refresh: "↻",
  "chatbubbles-outline": "💬",
  close: "✕",
  "trash-outline": "🗑",
  add: "＋",
  "volume-high-outline": "🔊",
  "chatbubble-outline": "💬",
  "clipboard-outline": "📋",
  "document-text-outline": "📄",
  "attach-outline": "📎",
  "image-outline": "🖼",
  "color-palette-outline": "🎨",
  stop: "■",
  mic: "🎤",
  "arrow-up": "↑",
};

export function Ionicons({ name, size = 16, color }: { name: string; size?: number; color?: string }) {
  return <Text style={{ fontSize: size, color, lineHeight: Math.round(size * 1.2) }}>{GLYPHS[name] || "•"}</Text>;
}
