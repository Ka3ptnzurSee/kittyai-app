// Bild mit In-App-Vollbild (Lightbox).
//
// Befund 23.11.2026: Ein Tap auf ein Bild öffnete per Linking.openURL den Browser
// ("leitet mich auf die Website"). Bilder bleiben jetzt in der App: Tap → Modal,
// Tap erneut → zu. Wird von Markdown (![](…)) und vom DIL-Image-Widget genutzt.
import { useState } from "react";
import { Image, Modal, Pressable, StyleSheet, Text, View, type DimensionValue, type ImageResizeMode } from "react-native";
import { colors } from "./theme";

export function BildMitVollbild({
  uri,
  width,
  height,
  radius = 12,
  resizeMode = "cover",
  alt = "Bild",
  style,
  onLoad,
  onError,
}: {
  uri: string;
  width?: DimensionValue;
  height?: number;
  radius?: number;
  resizeMode?: ImageResizeMode;
  alt?: string;
  style?: object;
  onLoad?: (e: unknown) => void;
  onError?: () => void;
}) {
  const [offen, setOffen] = useState(false);
  if (!uri) return null;
  return (
    <>
      <Pressable
        onPress={() => setOffen(true)}
        accessibilityRole="imagebutton"
        accessibilityLabel={`${alt} – antippen für Vollbild`}
      >
        <Image
          source={{ uri }}
          resizeMode={resizeMode}
          accessibilityLabel={alt}
          onLoad={onLoad}
          onError={onError}
          style={[{ width: width ?? "100%", maxWidth: "100%", height: height ?? 220, borderRadius: radius }, style]}
        />
      </Pressable>
      <Modal visible={offen} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setOffen(false)}>
        <Pressable style={st.backdrop} onPress={() => setOffen(false)} accessibilityRole="button" accessibilityLabel="Vollbild schließen">
          <View style={st.rahmen} pointerEvents="none">
            <Image source={{ uri }} resizeMode="contain" style={st.gross} accessibilityLabel={alt} />
          </View>
          <Text style={st.hinweis}>Tippen zum Schließen</Text>
        </Pressable>
      </Modal>
    </>
  );
}

const st = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
    padding: 12,
  },
  rahmen: { width: "100%", height: "82%" },
  gross: { width: "100%", height: "100%" },
  hinweis: { color: colors.muted, fontSize: 13, marginTop: 10 },
});
