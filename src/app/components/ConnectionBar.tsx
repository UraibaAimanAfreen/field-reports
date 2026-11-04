import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { radius, spacing, usePalette } from '../theme';

/**
 * Always visible, never a surprise.
 *
 * Going offline is the normal state of this job, not an error, so it is
 * reported as a fact with its consequence attached rather than as an alert
 * the user has to dismiss.
 */
export function ConnectionBar({ online, outstanding }: { online: boolean; outstanding: number }) {
  const palette = usePalette();
  if (online && outstanding === 0) return null;

  const offline = !online;
  const background = offline ? palette.warnBg : palette.progressBg;
  const foreground = offline ? palette.warn : palette.progress;

  const message = offline
    ? outstanding > 0
      ? `Offline · ${outstanding} report${outstanding === 1 ? '' : 's'} saved here, sending resumes automatically`
      : 'Offline · you can still write reports and take photos'
    : `Connected · sending ${outstanding} report${outstanding === 1 ? '' : 's'}`;

  return (
    <View style={[styles.bar, { backgroundColor: background }]} accessibilityLiveRegion="polite">
      <View style={[styles.dot, { backgroundColor: foreground }]} />
      <Text numberOfLines={2} style={[styles.text, { color: foreground }]}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { fontSize: 13.5, fontWeight: '600', flex: 1 },
});
