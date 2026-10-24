import { Platform } from "react-native";

// Claude-Design (Anthropic Design-Tokens, warmes Hell-Theme)
// Quelle: https://claude.com (offizielle CSS-Design-Tokens, extrahiert 2026-10-24)
export const colors = {
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
  link: "#2c84db", // --color-switch-on (blauer Link-Ton)
};

// Claude rendert KI-Antworten in einer Serifenschrift (Markenzeichen).
// Auf iOS: Georgia, auf Android: systemeigene Serif.
export const aiFontFamily = Platform.select({ ios: "Georgia", android: "serif", default: "serif" });

// Monospace für Code — Claude: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas.
export const monoFontFamily = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
