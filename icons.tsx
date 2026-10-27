import type { ComponentProps } from "react";
import { Ionicons as VectorIonicons } from "@expo/vector-icons";

// Echte Vektor-Icons (Ionicons → SF-Symbol-ähnlich, statt Unicode-/Emoji-Glyphen).
//
// WICHTIG (Start-Crash-Fix vom 26.10.2026): Der frühere Start-Crash lag NICHT
// an @expo/vector-icons selbst, sondern an einer Versions-Kollision — es war
// expo-font@58 (hoisted) installiert, während expo@57 die ABI-kompatible
// expo-font@57.0.4 braucht. Fix: package.json pinnt jetzt
//   "@expo/vector-icons": "^15.0.2"  +  "expo-font": "~57.0.4"
// (via `npx expo install`). Damit lädt die Icon-Komponente die Schrift korrekt
// über expo-font und rendert echte Glyphen statt Text-Ersatz.

// Lädt die Ionicons-Schrift einmal beim App-Start (verhindert leeren Frame/FOUC
// beim allerersten Icon-Render). Fällt der Preload aus, lädt die Komponente die
// Schrift selbst in componentDidMount nach — kein Crash.
let preloaded = false;
export async function preloadIcons(): Promise<void> {
  if (preloaded) return;
  try {
    await (VectorIonicons as any).loadFont();
    preloaded = true;
  } catch {
    // ignorieren – Lazy-Load übernimmt
  }
}

export function Ionicons(props: {
  name: ComponentProps<typeof VectorIonicons>["name"];
  size?: number;
  color?: string;
}) {
  return <VectorIonicons {...props} />;
}
