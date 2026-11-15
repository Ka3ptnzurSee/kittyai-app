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
  StyleSheet,
  type ViewStyle,
  type TextStyle,
  type StyleProp,
  type TextInputProps,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Ionicons } from "./icons";
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
export function haptic(kind: "action_sheet" | "selection" | "light" | "medium" = "light"): void {
  try {
    if (kind === "selection") Haptics.selectionAsync().catch(() => {});
    else if (kind === "medium") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
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
      // Ohne role liest VoiceOver nur den Text vor, nicht "Taste"; accessibilityState
      // sagt den deaktivierten Zustand an (sichtbar ist er nur ueber opacity).
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
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
