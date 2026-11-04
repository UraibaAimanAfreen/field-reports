import React, { memo } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { describeReport, formatBytes } from '../../core/selectors';
import type { ActiveWork, ReportRecord } from '../../core/types';
import { radius, spacing, toneColors, usePalette } from '../theme';
import { Pill, ProgressBar } from './ui';

interface Props {
  report: ReportRecord;
  active: ActiveWork | null;
  online: boolean;
  now: number;
  onPress: (reportId: string) => void;
}

/**
 * One line of the queue, built so the answer to "is my work safe?" is
 * available at a glance: a status pill, a sentence saying what happens next,
 * and a progress bar only when bytes are actually moving.
 */
function ReportRowComponent({ report, active, online, now, onPress }: Props) {
  const palette = usePalette();
  const status = describeReport(report, active, online, now);
  const { fg } = toneColors(palette, status.tone);

  const totalBytes = report.images.reduce(
    (sum, image) => sum + (image.prepared?.bytes ?? image.source.bytes),
    0,
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${report.description}. ${status.label}. ${status.detail}`}
      onPress={() => onPress(report.id)}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: palette.surface, borderColor: palette.line, opacity: pressed ? 0.75 : 1 },
      ]}>
      <View style={[styles.stripe, { backgroundColor: fg }]} />

      <View style={styles.body}>
        <View style={styles.header}>
          <Pill label={status.label} tone={status.tone} />
          <Text style={[styles.count, { color: palette.textFaint }]}>
            {report.images.length} photo{report.images.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
          </Text>
        </View>

        <Text numberOfLines={2} style={[styles.description, { color: palette.text }]}>
          {report.description}
        </Text>

        <Text numberOfLines={2} style={[styles.detail, { color: palette.textSoft }]}>
          {status.detail}
        </Text>

        {status.progress != null ? (
          <View style={styles.progress}>
            <ProgressBar value={status.progress} tone={status.tone} />
          </View>
        ) : null}

        <View style={styles.thumbs}>
          {report.images.slice(0, 4).map(image =>
            image.thumbUri ? (
              <Image key={image.id} source={{ uri: image.thumbUri }} style={[styles.thumb, { borderColor: palette.line }]} />
            ) : (
              <View
                key={image.id}
                style={[styles.thumb, styles.thumbEmpty, { borderColor: palette.line, backgroundColor: palette.surfaceAlt }]}
              />
            ),
          )}
          {report.images.length > 4 ? (
            <View style={[styles.thumb, styles.thumbEmpty, { borderColor: palette.line, backgroundColor: palette.surfaceAlt }]}>
              <Text style={[styles.more, { color: palette.textFaint }]}>+{report.images.length - 4}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Re-render only when something visible changed. The queue emits a snapshot on
 * every progress tick; without this, a five-photo upload would re-render every
 * row in the list several times a second.
 */
export const ReportRow = memo(ReportRowComponent, (prev, next) => {
  const activeHere = (props: Props) => (props.active?.reportId === props.report.id ? props.active : null);
  const prevActive = activeHere(prev);
  const nextActive = activeHere(next);
  return (
    prev.report === next.report &&
    prev.online === next.online &&
    prevActive?.phase === nextActive?.phase &&
    prevActive?.imageId === nextActive?.imageId &&
    prevActive?.fraction === nextActive?.fraction &&
    // The clock only matters to a row that is counting down to a retry.
    (prev.now === next.now || next.report.nextAttemptAt <= next.now)
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  stripe: { width: 4 },
  body: { flex: 1, padding: spacing.lg, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  count: { fontSize: 12, fontVariant: ['tabular-nums'] },
  description: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  detail: { fontSize: 13.5, lineHeight: 19 },
  progress: { marginTop: spacing.xs },
  thumbs: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  thumb: { width: 44, height: 44, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  more: { fontSize: 12, fontWeight: '600' },
});
