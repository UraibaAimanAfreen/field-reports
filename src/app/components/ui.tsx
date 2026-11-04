import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import type { Tone } from '../../core/selectors';
import { HIT_TARGET, radius, spacing, toneColors, usePalette } from '../theme';

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const palette = usePalette();
  return (
    <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.line }, style]}>{children}</View>
  );
}

export function Pill({ label, tone }: { label: string; tone: Tone }) {
  const palette = usePalette();
  const { fg, bg } = toneColors(palette, tone);
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text numberOfLines={1} style={[styles.pillText, { color: fg }]}>
        {label}
      </Text>
    </View>
  );
}

export function ProgressBar({ value, tone = 'progress' }: { value: number | null; tone?: Tone }) {
  const palette = usePalette();
  const { fg, bg } = toneColors(palette, tone);
  return (
    <View style={[styles.track, { backgroundColor: bg }]}>
      <View style={[styles.fill, { backgroundColor: fg, width: `${Math.round((value ?? 0) * 100)}%` }]} />
    </View>
  );
}

/** Movement without a number, for work whose duration we cannot honestly predict. */
export function IndeterminateBar({ tone = 'progress' }: { tone?: Tone }) {
  const palette = usePalette();
  const { fg, bg } = toneColors(palette, tone);
  return (
    <View style={[styles.track, { backgroundColor: bg }]}>
      <View style={[styles.fill, styles.indeterminate, { backgroundColor: fg }]} />
    </View>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  label,
  onPress,
  variant = 'secondary',
  disabled,
  busy,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = usePalette();
  const look: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: palette.accent, fg: palette.accentText, border: palette.accent },
    secondary: { bg: palette.surface, fg: palette.text, border: palette.line },
    danger: { bg: palette.surface, fg: palette.bad, border: palette.bad },
    ghost: { bg: 'transparent', fg: palette.accent, border: 'transparent' },
  };
  const { bg, fg, border } = look[variant];
  const inactive = disabled || busy;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(busy) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: border, opacity: inactive ? 0.45 : pressed ? 0.75 : 1 },
        style,
      ]}>
      {busy ? <ActivityIndicator size="small" color={fg} /> : <Text style={[styles.buttonLabel, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  const palette = usePalette();
  return <Text style={[styles.sectionLabel, { color: palette.textFaint }]}>{children}</Text>;
}

export function Body({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const palette = usePalette();
  return <Text style={[styles.body, { color: palette.textSoft }, style]}>{children}</Text>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  const palette = usePalette();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: palette.text }]}>{title}</Text>
      <Text style={[styles.emptyBody, { color: palette.textFaint }]}>{body}</Text>
      {action ? <View style={{ marginTop: spacing.lg }}>{action}</View> : null}
    </View>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  pill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  pillText: { fontSize: 12.5, fontWeight: '600', letterSpacing: 0.1 },
  track: { height: 6, borderRadius: radius.pill, overflow: 'hidden', width: '100%' },
  fill: { height: '100%', borderRadius: radius.pill },
  indeterminate: { width: '35%', opacity: 0.75 },
  button: {
    minHeight: HIT_TARGET,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  buttonLabel: { fontSize: 15.5, fontWeight: '600' },
  sectionLabel: {
    fontSize: 11.5,
    fontWeight: '700',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  body: { fontSize: 14.5, lineHeight: 21 },
  empty: { alignItems: 'center', paddingVertical: spacing.xxl * 1.5, paddingHorizontal: spacing.xl },
  emptyTitle: { fontSize: 17, fontWeight: '700', marginBottom: spacing.sm, textAlign: 'center' },
  emptyBody: { fontSize: 14.5, lineHeight: 21, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
