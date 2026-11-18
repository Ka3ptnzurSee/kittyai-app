// ChatGPT-Komponenten-Bibliothek — Nachbau der Valdi/Composer-UI-Bausteine.
// Quelle: /opt/ios-re/chatgpt/valdi/oai_ui.dec + widgets.dec (lesbarer JS-Quellcode) +
//         /opt/chatgpt-re/docs/21-ios-valdi-ui-framework.md.
//
// Jede Komponente bildet das ChatGPT-Verhalten 1:1 ab: Spring-Konfigs (Sidebar
// damping=38/stiffness=460, Toggle SPRING_DEFAULT), Haptik (performHapticFeedback
// "action_sheet" → Haptics.impactAsync), Pressed/Selected/Disabled-Zustände,
// Shimmer-Zyklus 1400 ms.
//
// RN-Animated (kein reanimated) — bewusst, da keine zusätzliche native Dep.

import React, { useRef, useEffect, useState, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable as RNPressable,
  Animated,
  FlatList as RNFlatList,
  PanResponder,
  RefreshControl,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
  type StyleProp,
  type TextInputProps,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Ionicons } from "./icons";
import type { ComponentProps } from "react";
import {
  colors,
  oaiRadius,
  oaiSpacing,
  oaiControlHeight,
  oaiTypography,
  motion,
} from "./theme";

// ───────────────────────────── Haptik (Valdi Device.performHapticFeedback) ─────────────────────────────
// Haptics.*Async() liefert ein Promise: try/catch allein faengt nur synchrone
// Fehler, auf Web/Android ohne Vibrator rejectet das Promise -> unhandled
// rejection. Deshalb zusaetzlich .catch(() => {}) an jedem Aufruf.
export type HapticKind = "action_sheet" | "selection" | "light" | "medium" | "success" | "error" | "warning";

export function haptic(kind: HapticKind = "light"): void {
  try {
    if (kind === "selection") Haptics.selectionAsync().catch(() => {});
    else if (kind === "medium") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    else if (kind === "success") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    else if (kind === "error") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    else if (kind === "warning") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    else if (kind === "action_sheet") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  } catch {
    /* Haptik ist optional – nie crashen */
  }
}

// ───────────────────────────── Surface (Valdi Surface.js) ─────────────────────────────
export function Surface({
  children,
  elevated = false,
  padding,
  radius,
  style,
}: {
  children?: React.ReactNode;
  elevated?: boolean;
  padding?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          backgroundColor: elevated ? colors.surface : colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius ?? oaiRadius.lg,
          padding: padding ?? oaiSpacing.two,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ───────────────────────────── OAIText (Semantic-Text) ─────────────────────────────
type TextToken = keyof typeof oaiTypography | "bodyStrong" | "headline";

export function OAIText({
  token = "body",
  color,
  align,
  numberOfLines,
  children,
  style,
}: {
  token?: TextToken;
  color?: string;
  align?: TextStyle["textAlign"];
  numberOfLines?: number;
  children?: React.ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  const t = oaiTypography[token] ?? oaiTypography.body;
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        { fontSize: t.size, lineHeight: t.lineHeight, fontWeight: t.weight as TextStyle["fontWeight"], color: color ?? colors.text, textAlign: align },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

// ───────────────────────────── Pressable (Valdi Pressable.js) ─────────────────────────────
export function Pressable({
  onPress,
  onPressIn,
  onPressOut,
  onLongPress,
  delayLongPress,
  disabled,
  children,
  style,
  hitSlop,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole,
  accessibilityState,
  accessibilityElementsHidden,
  selected,
  hapticOnPress = "light",
}: {
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  disabled?: boolean;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  hitSlop?: number;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** z. B. "button" | "tab" | "link" — VoiceOver-Ansage (Valdi: a11y_role). */
  accessibilityRole?: "button" | "tab" | "link" | "header" | "image" | "none" | "radio" | "checkbox" | "search";
  accessibilityState?: { selected?: boolean; disabled?: boolean; busy?: boolean; expanded?: boolean; checked?: boolean };
  /** Container, der nur Taps schluckt: komplett aus der VoiceOver-Reihenfolge nehmen. */
  accessibilityElementsHidden?: boolean;
  /** VoiceOver-Zustand (z. B. aktiver Chat, gewählter Tab). */
  selected?: boolean;
  hapticOnPress?: "light" | "medium" | "selection" | "none";
}) {
  return (
    <RNPressable
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      // Langer Druck ist eine eigene Rueckmeldung (Valdi: "action_sheet") —
      // bewusst medium, damit Halten nie wie ein normaler Tap klingt.
      onLongPress={() => {
        haptic("medium");
        onLongPress?.();
      }}
      delayLongPress={delayLongPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      // Ohne role liest VoiceOver nur den Text vor, nicht "Taste"; accessibilityState
      // sagt den deaktivierten Zustand an (sichtbar ist er nur ueber opacity).
      // Caller koennen role/state ueberschreiben (Tab, Link) — Default bleibt "button".
      accessibilityRole={accessibilityRole ?? "button"}
      accessibilityState={{ disabled: !!disabled, selected: selected, ...accessibilityState }}
      accessibilityElementsHidden={accessibilityElementsHidden}
      importantForAccessibility={accessibilityElementsHidden ? "no-hide-descendants" : "auto"}
      onPress={() => {
        if (disabled) return;
        if (hapticOnPress !== "none") haptic(hapticOnPress === "selection" ? "selection" : hapticOnPress);
        onPress?.();
      }}
      disabled={disabled}
      hitSlop={hitSlop}
      // Eigene opacity zuerst, Aufrufer-Style danach: so gewinnt ein bewusst
      // gesetzter Disabled-Zustand des Callers (z. B. permissionBtnDisabled 0.5)
      // gegen den 0.38-Default, waehrend das Press-Feedback erhalten bleibt.
      style={({ pressed }) => [
        { opacity: disabled ? 0.38 : pressed ? 0.7 : 1 },
        style,
      ]}
    >
      {children}
    </RNPressable>
  );
}

// ───────────────────────────── Button (Valdi Button.js) ─────────────────────────────
export function Button({
  label,
  onPress,
  variant = "primary",
  size = "md",
  disabled,
  loading,
  pill = true,
  icon,
  block,
}: {
  label: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "tertiary" | "ghost";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  loading?: boolean;
  pill?: boolean;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  block?: boolean;
}) {
  const h = size === "sm" ? oaiControlHeight.sm : size === "lg" ? oaiControlHeight.lg : oaiControlHeight.md;
  const bg =
    variant === "primary"
      ? colors.accent
      : variant === "secondary"
        ? "transparent"
        : variant === "tertiary"
          ? colors.surface2
          : "transparent";
  const fg =
    variant === "primary" ? "#FFFFFF" : variant === "secondary" ? colors.text : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      hapticOnPress="light"
      style={[
        {
          minHeight: h,
          paddingHorizontal: size === "sm" ? oaiSpacing.oneAndHalf : oaiSpacing.two,
          borderRadius: pill ? oaiRadius.pill : oaiRadius.lg,
          backgroundColor: bg,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 6,
          alignSelf: block ? "stretch" : "flex-start",
          borderWidth: variant === "secondary" ? 1 : 0,
          borderColor: colors.border,
          opacity: disabled || loading ? 0.5 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : icon ? (
        <Ionicons name={icon} size={size === "sm" ? 14 : 16} color={fg} />
      ) : null}
      <Text style={{ color: fg, fontSize: size === "sm" ? 14 : 15, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

// ───────────────────────────── IconButton (Valdi IconButton.js) ─────────────────────────────
export function IconButton({
  name,
  onPress,
  color: c = colors.text,
  size = 20,
  bg,
  disabled,
  accessibilityLabel,
}: {
  name: React.ComponentProps<typeof Ionicons>["name"];
  onPress?: () => void;
  color?: string;
  size?: number;
  bg?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: bg ?? "transparent" }}
    >
      <Ionicons name={name} size={size} color={c} />
    </Pressable>
  );
}

// ───────────────────────────── ActivityIndicator (Valdi ActivityIndicator.js) ─────────────────────────────
export function ActivityIndicator({ color = colors.accent, size = "small" }: { color?: string; size?: "small" | "large" }) {
  const { ActivityIndicator: RNActivityIndicator } = require("react-native");
  return <RNActivityIndicator color={color} size={size} />;
}

// ───────────────────────────── SegmentedControl (mit SlidingSelectionIndicator) ─────────────────────────────
// Valdi oai_ui.dec: SlidingSelectionIndicator animiert frame (x/y/width/height) via setStateAnimated.
export function SegmentedControl({
  options,
  value,
  onChange,
  disabled,
  pill = false,
  block,
}: {
  options: string[];
  value: string;
  onChange?: (v: string) => void;
  disabled?: boolean;
  pill?: boolean;
  block?: boolean;
}) {
  const [widths, setWidths] = useState<number[]>([]);
  const [layout, setLayout] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const indicator = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const indicatorSize = useRef(new Animated.Value(0)).current;

  const idx = Math.max(0, options.indexOf(value));
  const measured = widths.length === options.length;

  useEffect(() => {
    if (!measured) return;
    const x = widths.slice(0, idx).reduce((a, b) => a + b, 0);
    const w = widths[idx] ?? 0;
    const targetX = pill ? 4 + x : x;
    const targetW = pill ? Math.max(0, w - 8) : w;
    Animated.parallel([
      Animated.spring(indicator, { toValue: { x: targetX, y: 0 }, ...motion.springDefault, useNativeDriver: true }),
      Animated.spring(indicatorSize, { toValue: targetW, ...motion.springDefault, useNativeDriver: false }),
    ]).start();
  }, [idx, measured, widths, pill, indicator, indicatorSize]);

  return (
    <View
      onLayout={(e) => {
        const l = e.nativeEvent.layout;
        setLayout({ x: l.x, y: l.y, w: l.width, h: l.height });
      }}
      style={[
        {
          flexDirection: "row",
          backgroundColor: colors.surface2,
          borderRadius: pill ? oaiRadius.pill : oaiRadius.lg,
          padding: pill ? 4 : 0,
          alignSelf: block ? "stretch" : "flex-start",
          opacity: disabled ? 0.5 : 1,
          position: "relative",
        },
      ]}
    >
      {measured && idx >= 0 && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: indicator.x,
            top: pill ? 4 : 0,
            width: indicatorSize,
            height: pill ? layout.h - 8 : layout.h,
            backgroundColor: pill ? colors.surface : colors.accent,
            borderRadius: pill ? oaiRadius.pill : oaiRadius.lg,
          }}
        />
      )}
      {options.map((o, i) => {
        const active = o === value;
        return (
          <RNPressable
            key={o}
            disabled={disabled}
            onPress={() => {
              haptic("selection");
              onChange?.(o);
            }}
            onLayout={(e) =>
              setWidths((prev) => {
                const next = [...prev];
                next[i] = e.nativeEvent.layout.width;
                return next;
              })
            }
            style={{ paddingHorizontal: pill ? oaiSpacing.two : oaiSpacing.oneAndHalf, paddingVertical: 10, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ fontSize: 15, fontWeight: active ? "600" : "400", color: active ? (pill ? colors.text : "#FFFFFF") : colors.muted }}>
              {o}
            </Text>
          </RNPressable>
        );
      })}
    </View>
  );
}

// ───────────────────────────── Toggle (Valdi CoreToggle.js) ─────────────────────────────
// iOS-Switch: 24×38, Track-Farbe oai-interactive-bg-switch-selected #34C759, Haptik action_sheet.
export function Toggle({
  on,
  onToggle,
  disabled,
  onColor = "#34C759",
  offColor = "#CDCDCD",
}: {
  on: boolean;
  onToggle?: (v: boolean) => void;
  disabled?: boolean;
  onColor?: string;
  offColor?: string;
}) {
  const progress = useRef(new Animated.Value(on ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(progress, {
      toValue: on ? 1 : 0,
      ...motion.springDefault,
      useNativeDriver: true,
    }).start();
  }, [on, progress]);

  const trackColor = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [offColor, onColor],
  });
  const thumbX = progress.interpolate({ inputRange: [0, 1], outputRange: [2, 16] });

  return (
    <RNPressable
      disabled={disabled}
      onPress={() => {
        haptic(motion.toggleHaptic);
        onToggle?.(!on);
      }}
      style={{ width: 38, height: 24, borderRadius: 12, justifyContent: "center", opacity: disabled ? 0.38 : 1 }}
    >
      <Animated.View style={{ width: 38, height: 24, borderRadius: 12, backgroundColor: trackColor }} />
      <Animated.View
        style={{
          position: "absolute",
          left: thumbX,
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: "#FFFFFF",
        }}
      />
    </RNPressable>
  );
}

// ───────────────────────────── Shimmer (Valdi ShimmerText/ShimmerLines.js) ─────────────────────────────
// Zyklus 1400 ms, Glyph-/Block-Opazität animiert.
export function ShimmerLines({ lines = 3, width = "100%" }: { lines?: number; width?: ViewStyle["width"] }) {
  const op = useRef(new Animated.Value(motion.shimmerOpacityMin)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: motion.shimmerOpacityMax, duration: motion.shimmerDurationMs, useNativeDriver: true }),
        Animated.timing(op, { toValue: motion.shimmerOpacityMin, duration: motion.shimmerDurationMs, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [op]);

  return (
    <View style={{ gap: 8, paddingVertical: 4 }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Animated.View
          key={i}
          style={{
            height: 12,
            width: i === lines - 1 ? "60%" : width,
            borderRadius: 6,
            backgroundColor: colors.surface2,
            opacity: op,
          }}
        />
      ))}
    </View>
  );
}

// ───────────────────────────── Divider (Valdi Divider.js) ─────────────────────────────
export function Divider({ flush, spacing }: { flush?: boolean; spacing?: number }) {
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: colors.border,
        marginVertical: spacing ?? oaiSpacing.two,
        marginHorizontal: flush ? 0 : undefined,
      }}
    />
  );
}

// ───────────────────────────── Badge (Valdi Badge.js) ─────────────────────────────
export function Badge({
  label,
  color,
  bg,
  pill = true,
}: {
  label: string;
  color?: string;
  bg?: string;
  pill?: boolean;
}) {
  return (
    <View
      style={{
        alignSelf: "flex-start",
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: pill ? oaiRadius.pill : oaiRadius.sm,
        backgroundColor: bg ?? colors.surface2,
      }}
    >
      <Text style={{ fontSize: 11, fontWeight: "600", color: color ?? colors.muted }}>{label}</Text>
    </View>
  );
}

// ───────────────────────────── FeedbackControls (ChatGPT-Aktionsleiste unter Antworten) ─────────────────────────────
export function FeedbackControls({
  onCopy,
  onRegenerate,
  onLike,
  onDislike,
  liked,
  disliked,
  copied,
}: {
  onCopy?: () => void;
  onRegenerate?: () => void;
  onLike?: () => void;
  onDislike?: () => void;
  liked?: boolean;
  disliked?: boolean;
  copied?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 8 }}>
      <IconButton name={copied ? "checkmark" : "copy-outline"} size={16} color={colors.muted} onPress={onCopy} />
      <IconButton name="refresh-outline" size={18} color={colors.muted} onPress={onRegenerate} />
      <IconButton name={liked ? "thumbs-up" : "thumbs-up-outline"} size={16} color={liked ? colors.accent : colors.muted} onPress={onLike} />
      <IconButton name={disliked ? "thumbs-down" : "thumbs-down-outline"} size={16} color={disliked ? colors.accent : colors.muted} onPress={onDislike} />
    </View>
  );
}

// ───────────────────────────── OAIInput (TextInput nach ChatGPT-Metriken) ─────────────────────────────
export function OAIInput({
  pill = true,
  controlHeight = "md",
  ...rest
}: TextInputProps & { pill?: boolean; controlHeight?: "sm" | "md" | "lg" }) {
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      {...rest}
      style={[
        {
          minHeight: oaiControlHeight[controlHeight],
          borderRadius: pill ? oaiRadius.pill : oaiRadius.lg,
          paddingHorizontal: oaiSpacing.two,
          paddingVertical: 10,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          color: colors.text,
          fontSize: 16,
        },
        rest.style as TextStyle,
      ]}
    />
  );
}

// ───────────────────────────── ShimmerText (Valdi ShimmerText.js) ─────────────────────────────
// ChatGPT animiert beim Warten den TEXT selbst (Glyph-Opazität 1 → 0.5, Zyklus 1400 ms,
// Keyframes [0.5→0.35, 1→0.6]), nicht nur Platzhalter-Balken. Wird für die
// „denkt nach …"-Zeile benutzt, damit Streaming/Warten lebendig wirkt statt statisch.
export function ShimmerText({
  children,
  style,
  durationMs = motion.shimmerCycleMs,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  durationMs?: number;
}) {
  const op = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const half = Math.max(120, Math.round(durationMs / 2));
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: motion.shimmerOpacityMin, duration: half, useNativeDriver: true }),
        Animated.timing(op, { toValue: 1, duration: half, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [op, durationMs]);
  return <Animated.Text style={[{ opacity: op }, style]}>{children}</Animated.Text>;
}

// ───────────────────────────── TabsHeader (Valdi widgets/tabs/TabsHeader.js) ─────────────────────────────
// Animierter Underline (lerp + clamp auf die Breite des aktiven Tabs), Haptik „selection".
export function TabsHeader<T extends string>({
  items,
  value,
  onChange,
}: {
  items: { key: T; label: string; icon?: ComponentProps<typeof Ionicons>["name"] }[];
  value: T;
  onChange?: (key: T) => void;
}) {
  const [widths, setWidths] = useState<number[]>([]);
  const [offsets, setOffsets] = useState<number[]>([]);
  const x = useRef(new Animated.Value(0)).current;
  const w = useRef(new Animated.Value(0)).current;
  const idx = Math.max(0, items.findIndex((i) => i.key === value));
  const measured = widths.length === items.length && offsets.length === items.length;

  useEffect(() => {
    if (!measured) return;
    const goX = Math.max(0, offsets[idx] ?? 0);
    const goW = Math.max(0, widths[idx] ?? 0);
    Animated.parallel([
      Animated.spring(x, { toValue: goX, ...motion.springDefault, useNativeDriver: false }),
      Animated.spring(w, { toValue: goW, ...motion.springDefault, useNativeDriver: false }),
    ]).start();
  }, [idx, measured, widths, offsets, x, w]);

  return (
    <View style={{ flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface, position: "relative" }}>
      {items.map((it, i) => {
        const active = it.key === value;
        const tint = active ? colors.accent : colors.muted;
        return (
          <RNPressable
            key={it.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={it.label}
            onPress={() => {
              haptic("selection");
              onChange?.(it.key);
            }}
            onLayout={(e) => {
              const { width } = e.nativeEvent.layout;
              // offset = linke Kante des Tabs im Eltern-Container (Tabs sind gleich breit → index*width)
              setWidths((prev) => { const n = [...prev]; n[i] = width; return n; });
              setOffsets((prev) => { const n = [...prev]; n[i] = i * width; return n; });
            }}
            style={{ flex: 1, alignItems: "center", paddingVertical: 11 }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {it.icon ? <Ionicons name={it.icon} size={16} color={tint} /> : null}
              <Text style={{ fontSize: 15, color: tint, fontWeight: active ? "700" : "400" }}>{it.label}</Text>
            </View>
          </RNPressable>
        );
      })}
      {measured ? (
        <Animated.View
          pointerEvents="none"
          style={{ position: "absolute", bottom: 0, height: 2, backgroundColor: colors.accent, left: x, width: w }}
        />
      ) : null}
    </View>
  );
}

// ───────────────────────────── PullToRefresh (Valdi widgets/PullToRefresh.js) ─────────────────────────────
// RN-RefreshControl als Komponente verpackt, damit `refreshControl={<PullToRefresh …/>}`
// überall gleich aussieht (Akzentfarbe, Haptik beim Auslösen).
export function PullToRefresh({ refreshing, onRefresh }: { refreshing: boolean; onRefresh?: () => void }) {
  return (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={() => {
        haptic("light");
        onRefresh?.();
      }}
      tintColor={colors.accent}
      colors={[colors.accent]}
    />
  );
}

// ───────────────────────────── CharacterCounter (Valdi oai_ui FormField) ─────────────────────────────
// Zeigt die Zeichenzahl erst, wenn sie relevant wird (ab 60 % des Limits) — sonst Rauschen.
// Ohne `max` wird nur die Zeichenzahl gezeigt — kein erfundenes Limit anzeigen,
// das nirgends erzwungen wird (ChatGPT zeigt das Limit nur, wenn es eins gibt).
export function CharacterCounter({ value, max }: { value: string; max?: number }) {
  const len = value.length;
  if (max === undefined ? len < 1200 : len < max * 0.6) return null;
  const near = max !== undefined && len > max * 0.9;
  return (
    <Text style={{ fontSize: 11, color: near ? colors.danger : colors.muted, fontVariant: ["tabular-nums"], paddingHorizontal: 8 }}>
      {max !== undefined ? `${len} / ${max}` : `${len} Zeichen`}
    </Text>
  );
}

// ───────────────────────────── SlidingSelectionIndicator (Valdi tabs.dec) ─────────────────────────────
// ChatGPT schiebt die Auswahl-Pille zwischen Segmenten, statt sie umzuschalten.
export function SlidingSelectionIndicator({
  index,
  count,
  width,
  color = colors.surface,
}: {
  index: number;
  count: number;
  width: number;
  color?: string;
}) {
  const segment = count > 0 ? width / count : width;
  const x = useRef(new Animated.Value(index * segment)).current;
  useEffect(() => {
    Animated.spring(x, { toValue: index * segment, ...motion.springSidebar, useNativeDriver: true }).start();
  }, [index, segment, x]);
  if (width <= 0) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 2,
        bottom: 2,
        left: 2,
        width: Math.max(0, segment - 4),
        borderRadius: oaiRadius.md,
        backgroundColor: color,
        transform: [{ translateX: x }],
      }}
    />
  );
}

// ───────────────────────────── RadioToggle (Valdi radio_toggle.dec) ─────────────────────────────
export function RadioToggle({
  checked,
  onSelect,
  label,
  disabled,
}: {
  checked: boolean;
  onSelect?: () => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={() => onSelect?.()}
      disabled={disabled}
      style={{ flexDirection: "row", alignItems: "center", gap: oaiSpacing.oneAndHalf, paddingVertical: oaiSpacing.one }}
      accessibilityRole="radio"
      accessibilityState={{ selected: checked, disabled: !!disabled }}
      accessibilityLabel={label}
      hapticOnPress="selection"
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: 2,
          borderColor: checked ? colors.accent : colors.border,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.accent }} /> : null}
      </View>
      {label ? <Text style={{ fontSize: oaiTypography.body.size, lineHeight: oaiTypography.body.lineHeight, color: colors.text }}>{label}</Text> : null}
    </Pressable>
  );
}

// ───────────────────────────── CoreToggle / CoreJumboToggle (Valdi core_toggle.dec) ─────────────────────────────
export function CoreToggle(props: React.ComponentProps<typeof Toggle>) {
  return <Toggle {...props} />;
}
// Jumbo = dieselbe Mechanik, 1.45x skaliert (Valdi: grosser Schalter in Einstellungen).
export function CoreJumboToggle(props: React.ComponentProps<typeof Toggle>) {
  return (
    <View style={{ transform: [{ scale: 1.45 }], width: 38 * 1.45, height: 24 * 1.45, alignItems: "center", justifyContent: "center" }}>
      <Toggle {...props} />
    </View>
  );
}

// ───────────────────────────── TabsCoordinator / TabsContent (Valdi tabs.dec) ─────────────────────────────
// Keep-Mounted: ein einmal besuchter Tab bleibt im Baum (Zustand + Scrollposition bleiben).
export function useTabsCoordinator<T extends string>(initial: T) {
  const [active, setActive] = useState<T>(initial);
  const seen = useRef<Set<T>>(new Set<T>([initial]));
  seen.current.add(active);
  const isMounted = useMemo(() => (key: T) => seen.current.has(key), [active]);
  return { active, setActive, isMounted };
}
// Alias mit dem Valdi-Namen (die Audit-/Portier-Liste fuehrt "TabsCoordinator").
export const TabsCoordinator = useTabsCoordinator;

export function TabsContent({
  active,
  keepMounted = true,
  children,
}: {
  active: boolean;
  keepMounted?: boolean;
  children?: React.ReactNode;
}) {
  if (!active && !keepMounted) return null;
  return <View style={active ? { flex: 1 } : { display: "none" }}>{children}</View>;
}

// ───────────────────────────── FormField (Valdi form_field.dec) ─────────────────────────────
export function FormField({
  label,
  hint,
  error,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <View style={{ gap: oaiSpacing.half, paddingVertical: oaiSpacing.half }}>
      {label ? (
        <Text style={{ fontSize: oaiTypography.footnoteSemibold.size, color: colors.muted }} accessibilityRole="text">
          {label}
        </Text>
      ) : null}
      {children}
      {error ? <Text style={{ fontSize: oaiTypography.caption.size, color: colors.danger }}>{error}</Text> : null}
      {!error && hint ? <Text style={{ fontSize: oaiTypography.caption.size, color: colors.muted }}>{hint}</Text> : null}
    </View>
  );
}

// ───────────────────────────── SearchField (Valdi search_field.dec) ─────────────────────────────
export function SearchField({
  value,
  onChangeText,
  placeholder = "Suchen",
  onDebouncedChange,
  debounceMs = 120,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  onDebouncedChange?: (v: string) => void;
  debounceMs?: number;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: oaiSpacing.one,
        backgroundColor: colors.surface2,
        borderRadius: oaiRadius.pill,
        paddingHorizontal: oaiSpacing.oneAndHalf,
        minHeight: oaiControlHeight.sm + 8,
      }}
    >
      <Ionicons name="search" size={16} color={colors.muted} />
      <TextInput
        value={value}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        returnKeyType="search"
        autoCorrect={false}
        accessibilityLabel={placeholder}
        onChangeText={(v) => {
          onChangeText(v);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => onDebouncedChange?.(v), debounceMs);
        }}
        style={{ flex: 1, paddingVertical: 8, fontSize: 16, color: colors.text }}
      />
      {value.length > 0 ? (
        <Pressable onPress={() => { onChangeText(""); onDebouncedChange?.(""); }} accessibilityLabel="Suche leeren" hapticOnPress="selection">
          <Ionicons name="close-circle" size={16} color={colors.muted} />
        </Pressable>
      ) : null}
    </View>
  );
}

// ───────────────────────────── SelectionMenu (Valdi selection_menu.dec) ─────────────────────────────
export function SelectionMenu({
  items,
  onSelect,
  onCancel,
  title,
}: {
  items: { key: string; label: string; selected?: boolean; destructive?: boolean }[];
  onSelect: (key: string) => void;
  onCancel?: () => void;
  title?: string;
}) {
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: oaiRadius.xl, paddingVertical: oaiSpacing.one }}>
      {title ? (
        <Text style={{ fontSize: oaiTypography.caption.size, color: colors.muted, paddingHorizontal: oaiSpacing.two, paddingBottom: oaiSpacing.one }}>
          {title}
        </Text>
      ) : null}
      {items.map((it) => (
        <Pressable
          key={it.key}
          onPress={() => onSelect(it.key)}
          accessibilityRole="button"
          accessibilityState={{ selected: !!it.selected }}
          accessibilityLabel={it.label}
          hapticOnPress="selection"
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: oaiSpacing.one,
            paddingHorizontal: oaiSpacing.two,
            minHeight: oaiControlHeight.md,
          }}
        >
          <Text style={{ fontSize: 17, color: it.destructive ? colors.danger : colors.text }}>{it.label}</Text>
          {it.selected ? <Ionicons name="checkmark" size={18} color={colors.accent} /> : null}
        </Pressable>
      ))}
      {onCancel ? (
        <Pressable
          onPress={onCancel}
          accessibilityLabel="Abbrechen"
          style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, marginTop: oaiSpacing.one, paddingHorizontal: oaiSpacing.two, minHeight: oaiControlHeight.md, justifyContent: "center" }}
        >
          <Text style={{ fontSize: 17, color: colors.muted }}>Abbrechen</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// ───────────────────────────── Dialog (Valdi dialog.dec) ─────────────────────────────
// Zentrierte Karte statt Alert: ChatGPT zeigt Rueckfragen im App-Layout.
export function Dialog({
  open,
  title,
  message,
  confirmLabel = "OK",
  cancelLabel = "Abbrechen",
  destructive,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  if (!open) return null;
  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <RNPressable style={[StyleSheet.absoluteFill, { backgroundColor: "#00000066" }]} onPress={onCancel} accessibilityLabel="Dialog schliessen" />
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: oaiSpacing.four }}>
        <View style={{ width: "100%", maxWidth: 320, backgroundColor: colors.surface, borderRadius: oaiRadius.xl, padding: oaiSpacing.two, gap: oaiSpacing.one }}>
          <Text style={{ fontSize: oaiTypography.headline.size, fontWeight: "600", color: colors.text, textAlign: "center" }}>{title}</Text>
          {message ? <Text style={{ fontSize: oaiTypography.subheadline.size, color: colors.muted, textAlign: "center" }}>{message}</Text> : null}
          <Button
            label={confirmLabel}
            onPress={() => onConfirm?.()}
            variant="primary"
          />
          <Pressable onPress={onCancel} accessibilityLabel={cancelLabel} style={{ minHeight: oaiControlHeight.md, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 17, color: colors.muted }}>{cancelLabel}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

// ───────────────────────────── InlineEdit (Valdi inline_edit.dec) ─────────────────────────────
export function InlineEdit({
  value,
  onCommit,
  placeholder = "Name",
  maxLength = 80,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  if (!editing) {
    return (
      <Pressable
        onPress={() => setEditing(true)}
        accessibilityRole="button"
        accessibilityLabel={(value || placeholder) + " bearbeiten"}
        style={{ minHeight: 28, justifyContent: "center" }}
      >
        <Text style={{ fontSize: 17, color: value ? colors.text : colors.muted }} numberOfLines={1}>
          {value || placeholder}
        </Text>
      </Pressable>
    );
  }
  return (
    <TextInput
      autoFocus
      value={draft}
      maxLength={maxLength}
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      accessibilityLabel={placeholder}
      onChangeText={setDraft}
      onBlur={() => { setEditing(false); haptic("selection"); onCommit(draft.trim()); }}
      onSubmitEditing={() => { setEditing(false); haptic("success"); onCommit(draft.trim()); }}
      returnKeyType="done"
      style={{ fontSize: 17, color: colors.text, borderBottomWidth: 1, borderBottomColor: colors.accent, paddingVertical: 4 }}
    />
  );
}


// ───────────────────────────── RotatingShimmerText (Valdi rotating_shimmer.dec) ─────────────────────────────
// Wechselt alle 2 s den Text und laesst ihn dabei schimmern ("analysiere …" -> "schreibe …").
export function RotatingShimmerText({
  messages,
  intervalMs = 2000,
  style,
}: {
  messages: string[];
  intervalMs?: number;
  style?: StyleProp<TextStyle>;
}) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (messages.length <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % messages.length), Math.max(600, intervalMs));
    return () => clearInterval(t);
  }, [messages.length, intervalMs]);
  const label = messages.length ? messages[idx % messages.length] : "";
  return <ShimmerText style={style}>{label}</ShimmerText>;
}

// ───────────────────────────── TextWithTags (Valdi text_with_tags.dec) ─────────────────────────────
// Fliesstext, in dem Marker (#ordner, @skill) als antippbare Chips erscheinen.
export function TextWithTags({
  text,
  onPressTag,
  tagColor = colors.accent,
}: {
  text: string;
  onPressTag?: (tag: string) => void;
  tagColor?: string;
}) {
  const parts = useMemo(() => {
    const out: { kind: "text" | "tag"; value: string }[] = [];
    const re = /([#@][A-Za-z0-9_\-]+)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ kind: "text", value: text.slice(last, m.index) });
      out.push({ kind: "tag", value: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
    return out;
  }, [text]);
  return (
    <Text style={{ fontSize: oaiTypography.body.size, lineHeight: oaiTypography.body.lineHeight, color: colors.text }}>
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <Text key={i}>{p.value}</Text>
        ) : (
          <Text
            key={i}
            onPress={() => { haptic("selection"); onPressTag?.(p.value); }}
            accessibilityRole="link"
            accessibilityLabel={p.value + " oeffnen"}
            style={{ color: tagColor }}
          >
            {p.value}
          </Text>
        ),
      )}
    </Text>
  );
}

// ───────────────────────────── EmojiLabel (Valdi emoji_label.dec) ─────────────────────────────
export function EmojiLabel({
  emoji,
  label,
  size = "body",
}: {
  emoji: string;
  label: string;
  size?: "caption" | "body" | "headline";
}) {
  const s = size === "caption" ? oaiTypography.caption : size === "headline" ? oaiTypography.headline : oaiTypography.body;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: oaiSpacing.one }}>
      <Text accessibilityElementsHidden style={{ fontSize: s.size }}>{emoji}</Text>
      <Text accessibilityLabel={label} style={{ fontSize: s.size, lineHeight: s.lineHeight, color: colors.text }}>{label}</Text>
    </View>
  );
}

// ───────────────────────────── IndexPicker / DatePicker / TimePicker (Valdi pickers.dec) ─────────────────────────────
// Eigenbau statt @react-native-picker: keine native Dep, gleiches Snap-Verhalten (44 pt Zeilen).
export function IndexPicker({
  items,
  index,
  onChange,
  width = 88,
  label,
}: {
  items: string[];
  index: number;
  onChange: (i: number) => void;
  width?: number;
  label?: string;
}) {
  const rowH = oaiControlHeight.md;
  const listRef = useRef<RNFlatList<string> | null>(null);
  useEffect(() => {
    const t = setTimeout(() => listRef.current?.scrollToOffset({ offset: Math.max(0, index - 1) * rowH, animated: false }), 0);
    return () => clearTimeout(t);
  }, [index, rowH]);
  return (
    <View style={{ width, height: rowH * 3, overflow: "hidden" }} accessibilityLabel={label}>
      <RNFlatList
        ref={listRef}
        data={items}
        keyExtractor={(v) => v}
        showsVerticalScrollIndicator={false}
        snapToInterval={rowH}
        decelerationRate="fast"
        getItemLayout={(_, i) => ({ length: rowH, offset: rowH * i, index: i })}
        contentContainerStyle={{ paddingVertical: rowH }}
        onMomentumScrollEnd={(e) => {
          const i = Math.round(e.nativeEvent.contentOffset.y / rowH);
          const clamped = Math.max(0, Math.min(items.length - 1, i));
          if (clamped !== index) { haptic("selection"); onChange(clamped); }
        }}
        renderItem={({ item, index: i }) => (
          <View style={{ height: rowH, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: i === index ? 18 : 16, color: i === index ? colors.text : colors.muted }}>{item}</Text>
          </View>
        )}
      />
    </View>
  );
}
export function DatePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (iso: string) => void;
}) {
  const [y, m, d] = useMemo(() => {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) || ["", "2026", "01", "01"];
    return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  }, [value]);
  const years = useMemo(() => Array.from({ length: 11 }, (_, i) => String(2026 + i)), []);
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")), []);
  const days = useMemo(() => {
    const last = new Date(y, m, 0).getDate();
    return Array.from({ length: last }, (_, i) => String(i + 1).padStart(2, "0"));
  }, [y, m]);
  const emit = (ny: number, nm: number, nd: number) => {
    const last = new Date(ny, nm, 0).getDate();
    const safeDay = Math.min(Math.max(1, nd), last);
    onChange(String(ny) + "-" + String(nm).padStart(2, "0") + "-" + String(safeDay).padStart(2, "0"));
  };
  return (
    <View style={{ flexDirection: "row", gap: oaiSpacing.half, justifyContent: "center" }}>
      <IndexPicker items={days} index={Math.max(0, d - 1)} onChange={(i) => emit(y, m, i + 1)} label="Tag" />
      <IndexPicker items={months} index={Math.max(0, m - 1)} onChange={(i) => emit(y, i + 1, d)} label="Monat" />
      <IndexPicker items={years} index={Math.max(0, years.indexOf(String(y)))} onChange={(i) => emit(Number(years[i]), m, d)} label="Jahr" width={100} />
    </View>
  );
}
export function TimePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (hhmm: string) => void;
}) {
  const [hh, mm] = useMemo(() => {
    const p = /^(\d{2}):(\d{2})$/.exec(value) || ["", "09", "00"];
    return [Number(p[1]), Number(p[2])];
  }, [value]);
  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")), []);
  const minutes = useMemo(() => Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0")), []);
  return (
    <View style={{ flexDirection: "row", gap: oaiSpacing.half, justifyContent: "center" }}>
      <IndexPicker items={hours} index={hh} onChange={(i) => onChange(hours[i] + ":" + minutes[Math.round(mm / 5)] )} label="Stunde" />
      <IndexPicker items={minutes} index={Math.max(0, Math.round(mm / 5))} onChange={(i) => onChange(String(hh).padStart(2, "0") + ":" + minutes[i])} label="Minute" />
    </View>
  );
}

// ───────────────────────────── SectionList + IndexView (Valdi list.dec) ─────────────────────────────
export function SectionList<T>({
  sections,
  renderItem,
  keyExtractor,
  sticky = true,
  style,
}: {
  sections: { title: string; data: T[] }[];
  renderItem: (item: T) => React.ReactElement | null;
  keyExtractor: (item: T) => string;
  sticky?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const flat = useMemo(() => {
    const rows: ({ type: "header"; title: string } | { type: "row"; item: T })[] = [];
    for (const s of sections) {
      rows.push({ type: "header", title: s.title });
      for (const it of s.data) rows.push({ type: "row", item: it });
    }
    return rows;
  }, [sections]);
  return (
    <RNFlatList
      style={style}
      data={flat}
      keyExtractor={(r, i) => (r.type === "header" ? "h:" + r.title + ":" + i : keyExtractor(r.item))}
      stickyHeaderIndices={sticky ? flat.map((r, i) => (r.type === "header" ? i : -1)).filter((i) => i >= 0) : undefined}
      renderItem={({ item }) =>
        item.type === "header" ? (
          <View style={{ backgroundColor: colors.bg, paddingHorizontal: oaiSpacing.oneAndHalf, paddingVertical: oaiSpacing.half }}>
            <Text accessibilityRole="header" style={{ fontSize: oaiTypography.footnoteSemibold.size, color: colors.muted }}>{item.title}</Text>
          </View>
        ) : (
          renderItem(item.item)
        )
      }
    />
  );
}
export function IndexView({
  letters,
  onSelect,
  active,
}: {
  letters: string[];
  onSelect: (letter: string) => void;
  active?: string;
}) {
  return (
    <View style={{ position: "absolute", right: 2, top: 0, bottom: 0, justifyContent: "center", gap: 1 }}>
      {letters.map((l) => (
        <Pressable
          key={l}
          onPress={() => onSelect(l)}
          hapticOnPress="selection"
          accessibilityRole="button"
          accessibilityLabel={"Springe zu " + l}
          style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: oaiRadius.sm }}
        >
          <Text style={{ fontSize: 10, fontWeight: active === l ? "700" : "400", color: active === l ? colors.accent : colors.muted }}>{l}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ───────────────────────────── SwipeNavigationSurface + SidebarLayout (Valdi navigation.dec) ─────────────────────────────
export function SwipeNavigationSurface({
  children,
  onBack,
  enabled = true,
  edgeWidth = 32,
}: {
  children?: React.ReactNode;
  onBack?: () => void;
  enabled?: boolean;
  edgeWidth?: number;
}) {
  const x = useRef(new Animated.Value(0)).current;
  const pan = useMemo(
    () =>
      PanResponder.create({
        // Nur am linken Rand starten (pageX - dx = Startpunkt), sonst klaut die Geste Tabellen-Scrolls.
        onMoveShouldSetPanResponder: (e, g) =>
          enabled && !!onBack && g.dx > 12 && Math.abs(g.dy) < 24 && e.nativeEvent.pageX - g.dx <= edgeWidth,
        onPanResponderMove: (_, g) => { if (g.dx > 0) x.setValue(Math.min(g.dx, 320)); },
        onPanResponderRelease: (_, g) => {
          const goBack = g.dx > 90 || g.vx > 0.6;
          Animated.spring(x, { toValue: goBack ? 320 : 0, ...motion.springSidebar, useNativeDriver: true }).start(() => {
            if (goBack) { haptic("light"); onBack?.(); }
            x.setValue(0);
          });
        },
        onPanResponderTerminate: () => { Animated.spring(x, { toValue: 0, ...motion.springSidebar, useNativeDriver: true }).start(); },
      }),
    [enabled, onBack, x, edgeWidth],
  );
  return (
    <View style={{ flex: 1 }} {...pan.panHandlers}>
      <Animated.View style={{ flex: 1, transform: [{ translateX: x }] }}>{children}</Animated.View>
    </View>
  );
}
export function SidebarLayout({
  sidebar,
  children,
  open,
  onOpenChange,
  width = 300,
}: {
  sidebar?: React.ReactNode;
  children?: React.ReactNode;
  open: boolean;
  onOpenChange?: (v: boolean) => void;
  width?: number;
}) {
  const x = useRef(new Animated.Value(open ? 0 : -width)).current;
  useEffect(() => {
    Animated.spring(x, { toValue: open ? 0 : -width, ...motion.springSidebar, useNativeDriver: true }).start();
  }, [open, width, x]);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>{children}</View>
      {open ? (
        <RNPressable
          style={[StyleSheet.absoluteFill, { backgroundColor: "#00000033" }]}
          onPress={() => onOpenChange?.(false)}
          accessibilityLabel="Seitenleiste schliessen"
        />
      ) : null}
      <Animated.View
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width,
          backgroundColor: colors.surface,
          transform: [{ translateX: x }],
          borderRightWidth: StyleSheet.hairlineWidth,
          borderRightColor: colors.border,
        }}
      >
        {sidebar}
      </Animated.View>
    </View>
  );
}

