// ChatGPT-Design (OAITokens) — exakt aus der reverse-engineerten iOS-App extrahiert.
// Quelle: /opt/ios-re/chatgpt/valdi/oai_core.dec (OAITokens.js + OAITypography.js) +
//         valdi_ui_theme.dec (DEFAULT_VALDI_UI_THEME). Siehe /opt/chatgpt-re/docs/22-oaidesign-tokens.md.
//
// ChatGPT-iOS nutzt Snap's „Composer"/Valdi-Framework (JS-UI-Runtime). Die Design-Tokens
// (Farben, Typo, Radius, Spacing, Control-Höhen) sind UNVERSCHLÜSSELT und vollständig
// extrahiert — dies ist die 1:1-Abbildung. Das Theme ist bewusst NUR hell (ChatGPT-iOS
// liefert beide Modi, aber die KittyAI-App ist aktuell hell fixiert; `oaicolorsDark`
// liegt für den späteren Dark-Mode bereit).

// ───────────────────────────── Kompatible Farben (bestehende Keys) ─────────────────────────────
// Die App/Dil.tsx greifen über `colors.<key>` zu. Wir mappen dieselben Keys auf die
// ChatGPT-Semantic-Tokens — damit ist der Wechsel von Claude→ChatGPT ohne Caller-Änderung.
export const colors = {
  bg: "#F2F2F7", // oai-bg-grouped-elevated (Listen-/App-Hintergrund)
  surface: "#FFFFFF", // oai-bg-primary (Karten, Bubbles, Sheets)
  surface2: "#F3F3F3", // oai-bg-tertiary (subtile Flächen)
  text: "#0D0D0D", // oai-text-primary
  muted: "#5D5D5D", // oai-text-secondary
  accent: "#0285FF", // oai-theme-blue-default / oai-text-accent
  accentHover: "#0169CC", // oai-theme-blue-text
  accentSoft: "#E5F3FF", // oai-theme-blue-background
  border: "#0D0D0D1A", // oai-border-default (8-stellig: Alpha ~10 %)
  danger: "#FF002A", // oai-text-status-error
  success: "#00A240", // oai-theme-green-text
  warning: "#E25507", // oai-text-status-warning
  link: "#0285FF", // oai-text-ios-link
};

// ───────────────────────────── ChatGPT OAITokens — Light (vollständig) ─────────────────────────────
export const oaicolors = {
  canvas: "#FFFFFF",
  canvasSubtle: "#FCFCFC",
  bgPrimary: "#FFFFFF",
  bgPrimaryInverse: "#F9F9F9",
  bgSecondary: "#E8E8E8",
  bgTertiary: "#F3F3F3",
  bgLayer3: "#E8E8E8",
  bgUserMessage: "#0000000D",
  bgCodeBlock: "#F8F8F8",
  bgScrim: "#E3E3E380",
  bgElevatedPrimary: "#FFFFFF",
  bgElevatedSecondary: "#F3F3F3",
  bgGrouped: "#F2F2F7",
  bgGroupedElevated: "#F2F2F7",
  bgGroupedSurface: "#FFFFFF",
  bgSystemElevated: "#FFFFFF",
  bgStatusError: "#FFF0F0",
  bgStatusSuccess: "#D9F4E4",
  bgStatusWarning: "#FFF5F0",
  borderDefault: "#0D0D0D1A",
  borderHeavy: "#0D0D0D26",
  borderLight: "#0D0D0D0D",
  borderSystemSeparator: "#E8E8E8",
  iconPrimary: "#0D0D0D",
  iconSecondary: "#5D5D5D",
  iconTertiary: "#8F8F8F",
  iconSystemDisclosure: "#8A8A8E",
  iconInverted: "#FFFFFF",
  iconAccent: "#0285FF",
  iconStatusError: "#FF002A",
  iconStatusSuccess: "#004F1F",
  iconStatusWarning: "#E25507",
  textPrimary: "#0D0D0D",
  textSecondary: "#5D5D5D",
  textTertiary: "#8F8F8F",
  textSystemSecondary: "#3C3C4399",
  textSystemLink: "#0088FF",
  textIosLink: "#0285FF",
  textAndroidLink: "#1D53BF",
  textInverse: "#FFFFFF",
  textAccent: "#0285FF",
  textStatusError: "#FF002A",
  textStatusSuccess: "#004F1F",
  textStatusWarning: "#E25507",
  interactiveBgPrimaryDefault: "#0D0D0D",
  interactiveBgPrimaryHover: "#0D0D0D",
  interactiveBgPrimaryPress: "#0D0D0D",
  interactiveBgSecondaryDefault: "#0D0D0D",
  interactiveBgTertiaryDefault: "#FFFFFF",
  interactiveBgTertiaryHover: "#F9F9F9",
  interactiveBgTertiaryPress: "#F3F3F3",
  interactiveBgRowHover: "#F3F3F3",
  interactiveBgRowPress: "#F9F9F9",
  interactiveBgDangerPrimaryDefault: "#FF002A",
  interactiveBgSystemDestructive: "#FF383C",
  interactiveBgControlDefault: "#CDCDCD",
  interactiveBgSwitchSelected: "#34C759",
  interactiveBgSwitchThumb: "#FFFFFF",
  interactiveBorderFocus: "#0D0D0D",
  interactiveLabelPrimaryDefault: "#FFFFFF",
  interactiveLabelSecondaryDefault: "#0D0D0D",
  interactiveLabelTertiaryDefault: "#5D5D5D",
  interactiveLabelAccentDefault: "#0285FF",
  interactiveLabelDangerPrimaryDefault: "#FFFFFF",
  interactiveLabelDangerSecondaryDefault: "#FF002A",
  themeDefault: "#8F8F8F",
  themeBackground: "#F3F3F3",
  themeText: "#000000",
  themeCodexDefault: "#0169CC",
  themeCodexBackground: "#FFFFFF",
  themeCodexText: "#339CFF",
  themeBlueDefault: "#0285FF",
  themeBlueBackground: "#E5F3FF",
  themeBlueText: "#0169CC",
  themeGreenDefault: "#04B84C",
  themeGreenBackground: "#D9F4E4",
  themeGreenText: "#00A240",
  themeOrangeDefault: "#FB6A22",
  themeOrangeBackground: "#FFE7D9",
  themeOrangeText: "#E25507",
  themePurpleDefault: "#AD7BF9",
  themePurpleBackground: "#EFE5FE",
  themePurpleText: "#8046D9",
  themeYellowDefault: "#FFC300",
  themeYellowBackground: "#FFF6D9",
  themeYellowText: "#BA8E00",
  shadowColor: "#00000024",
};

// ───────────────────────────── ChatGPT OAITokens — Dark (für späteren Dark-Mode) ─────────────────────────────
export const oaicolorsDark = {
  canvas: "#000000",
  canvasSubtle: "#000000",
  bgPrimary: "#212121",
  bgPrimaryInverse: "#131313",
  bgSecondary: "#303030",
  bgTertiary: "#414141",
  bgLayer3: "#414141",
  bgUserMessage: "#FFFFFF21",
  bgCodeBlock: "#212121",
  bgScrim: "#0D0D0D80",
  bgElevatedPrimary: "#303030",
  bgElevatedSecondary: "#212121",
  bgGrouped: "#000000",
  bgGroupedElevated: "#1C1C1E",
  bgGroupedSurface: "#2C2C2E",
  bgSystemElevated: "#1C1C1E",
  bgStatusError: "#4D100E",
  bgStatusSuccess: "#004F1F",
  bgStatusWarning: "#4A2206",
  borderDefault: "#FFFFFF26",
  borderHeavy: "#FFFFFF33",
  borderLight: "#FFFFFF0D",
  borderSystemSeparator: "#38383B",
  iconPrimary: "#FFFFFF",
  iconSecondary: "#CDCDCD",
  iconTertiary: "#9F9FA5",
  iconAccent: "#48AAFF",
  textPrimary: "#FFFFFF",
  textSecondary: "#CDCDCD",
  textTertiary: "#9F9FA5",
  textSystemSecondary: "#EBEBF599",
  textSystemLink: "#0091FF",
  textIosLink: "#48AAFF",
  textAndroidLink: "#7AB7FF",
  textAccent: "#48AAFF",
  interactiveBgPrimaryDefault: "#FFFFFF",
  interactiveBgTertiaryDefault: "#414141",
  interactiveBgTertiaryHover: "#38383B",
  interactiveBgTertiaryPress: "#2C2C2E",
  interactiveLabelPrimaryDefault: "#212121",
  interactiveBgControlDefault: "#414141",
  interactiveBgSwitchSelected: "#30D158",
  interactiveBgSwitchThumb: "#FFFFFF",
};

// ───────────────────────────── Typografie (OAITypography, SF/San Francisco) ─────────────────────────────
// ChatGPT-iOS nutzt systemFont (SF Pro) — KEINE Serif (anders als Claude).
// RN/iOS: fontFamily "System" = SF Pro, "System-Serif" wäre New York (hier NICHT verwendet).
export const uiFontFamily = "System";
export const aiFontFamily = "System"; // ChatGPT antwortet in SF Pro, nicht in Serif
export const monoFontFamily = "Menlo"; // iOS Mono (SF Mono-Fallback)

// Vollständige Typo-Skala (Größe / Zeilenhöhe / Gewicht).
export const oaiTypography = {
  largeTitle: { size: 34, lineHeight: 41, weight: "400" as const },
  title1: { size: 28, lineHeight: 34, weight: "400" as const },
  title2: { size: 22, lineHeight: 28, weight: "400" as const },
  title3: { size: 20, lineHeight: 24, weight: "400" as const },
  title3Semibold: { size: 20, lineHeight: 24, weight: "600" as const },
  headline: { size: 17, lineHeight: 22, weight: "600" as const },
  headlineRegular: { size: 17, lineHeight: 20, weight: "400" as const },
  body: { size: 17, lineHeight: 24, weight: "400" as const },
  bodyMedium: { size: 17, lineHeight: 22, weight: "500" as const },
  bodyStrong: { size: 17, lineHeight: 22, weight: "600" as const },
  callout: { size: 16, lineHeight: 21, weight: "400" as const },
  subheadline: { size: 15, lineHeight: 20, weight: "400" as const },
  subheadlineMedium: { size: 15, lineHeight: 20, weight: "500" as const },
  footnote: { size: 13, lineHeight: 18, weight: "400" as const },
  footnoteSemibold: { size: 13, lineHeight: 18, weight: "600" as const },
  caption: { size: 12, lineHeight: 16, weight: "400" as const },
  caption2: { size: 11, lineHeight: 13, weight: "400" as const },
};

// ───────────────────────────── Radius / Spacing / Control (OAIRadius/OAISpacing/OAIControlSize) ─────────────────────────────
export const oaiRadius = { none: 0, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24, pill: 999 };
export const oaiSpacing = { none: 0, px: 1, quarter: 2, half: 4, threeQuarters: 6, one: 8, oneAndHalf: 12, two: 16, three: 24, four: 32 };
export const oaiControlHeight = { sm: 28, md: 44, lg: 52 };
export const oaiMetric = { badgeSize: 18, navigationItemHeight: 52 };
