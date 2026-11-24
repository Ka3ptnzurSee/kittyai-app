import * as Font from "expo-font";

// Echte Claude-Fonts aus der reverse-engineerten iOS-App (ClaudeFonts_ClaudeFonts.bundle).
// Extrahiert 2026-10-27 aus /opt/ios-re/claude/ → /opt/kitty/app/assets/fonts/.
// PostScript-Name == fontFamily-Key (siehe theme.ts).
const FONTS = {
  AnthropicSerifMobileVariable_TextRegular: require("./assets/fonts/AnthropicSerifMobileVariable-TextRegular.ttf"),
  AnthropicSerifMobileVariable_TextRegularItalic: require("./assets/fonts/AnthropicSerifMobileVariable-TextRegularItalic.ttf"),
  AnthropicSansMobileVariable_TextRegular: require("./assets/fonts/AnthropicSansMobileVariable-TextRegular.ttf"),
  AnthropicSansMobileVariable_TextRegularItalic: require("./assets/fonts/AnthropicSansMobileVariable-TextRegularItalic.ttf"),
  JetBrainsMono_Regular: require("./assets/fonts/JetBrainsMono-Regular.ttf"),
};

// Maps auf die exakten PostScript-Namen (fontFamily-Keys in theme.ts).
const KEYMAP: Record<keyof typeof FONTS, string> = {
  AnthropicSerifMobileVariable_TextRegular: "AnthropicSerifMobileVariable-TextRegular",
  AnthropicSerifMobileVariable_TextRegularItalic: "AnthropicSerifMobileVariable-TextRegularItalic",
  AnthropicSansMobileVariable_TextRegular: "AnthropicSansMobileVariable-TextRegular",
  AnthropicSansMobileVariable_TextRegularItalic: "AnthropicSansMobileVariable-TextRegularItalic",
  JetBrainsMono_Regular: "JetBrainsMono-Regular",
};

let loaded = false;
export async function preloadFonts(): Promise<void> {
  if (loaded) return;
  try {
    await Font.loadAsync(
      Object.fromEntries(
        (Object.keys(FONTS) as (keyof typeof FONTS)[]).map((k) => [KEYMAP[k], FONTS[k]]),
      ),
    );
    loaded = true;
  } catch (e) {
    // Fehlschlag nicht fatal: theme.ts fällt auf System-Schrift zurück (Platform.select).
    console.warn("Claude-Fonts konnten nicht geladen werden:", e);
  }
}
