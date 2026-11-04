import React, { useCallback, useMemo } from 'react';
import { Alert, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { describeImage, describeReport, formatBytes } from '../../core/selectors';
import { useQueue } from '../QueueProvider';
import { Body, Button, Card, Pill, ProgressBar, Row, SectionLabel } from '../components/ui';
import { radius, spacing, usePalette } from '../theme';
import { useNow } from '../useNow';

interface Props {
  route: { params: { reportId: string } };
  navigation: { goBack: () => void };
}

export function ReportDetailScreen({ route, navigation }: Props) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { queue, snapshot } = useQueue();
  const { reportId } = route.params;

  const report = useMemo(() => snapshot.reports.find(item => item.id === reportId), [snapshot.reports, reportId]);
  const counting = Boolean(report && report.stage === 'queued' && report.nextAttemptAt > Date.now());
  const now = useNow(counting);

  const remove = useCallback(() => {
    const unsent = report && report.stage !== 'delivered';
    Alert.alert(
      unsent ? 'Delete an unsent report?' : 'Delete this report?',
      unsent
        ? 'This report has not reached the server. Deleting it here means it is gone for good.'
        : 'The server keeps its copy. This only removes it from this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await queue.remove(reportId);
            navigation.goBack();
          },
        },
      ],
    );
  }, [navigation, queue, report, reportId]);

  if (!report) {
    return (
      <View style={[styles.screen, styles.center, { backgroundColor: palette.bg }]}>
        <Body>This report is no longer on the device.</Body>
      </View>
    );
  }

  const status = describeReport(report, snapshot.active, snapshot.online, now);
  const uploaded = report.images.filter(image => image.stage === 'uploaded').length;

  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: palette.bg }]}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}>
      <Card style={styles.header}>
        <Pill label={status.label} tone={status.tone} />
        <Text style={[styles.description, { color: palette.text }]}>{report.description}</Text>
        <Body>{status.detail}</Body>
        {status.progress != null ? <ProgressBar value={status.progress} tone={status.tone} /> : null}
      </Card>

      <SectionLabel>Photos · {uploaded} of {report.images.length} on the server</SectionLabel>
      {report.images.map((image, index) => {
        const imageStatus = describeImage(image, snapshot.active);
        const sent = image.prepared?.bytes;
        return (
          <Card key={image.id} style={styles.imageCard}>
            <Row style={styles.imageRow}>
              {image.thumbUri ? (
                <Image source={{ uri: image.thumbUri }} style={[styles.thumb, { borderColor: palette.line }]} />
              ) : (
                <View style={[styles.thumb, { borderColor: palette.line, backgroundColor: palette.surfaceAlt }]} />
              )}
              <View style={styles.imageMeta}>
                <Text style={[styles.imageTitle, { color: palette.text }]}>Photo {index + 1}</Text>
                <Pill label={imageStatus.label} tone={imageStatus.tone} />
                <Text style={[styles.sizes, { color: palette.textFaint }]}>
                  {sent
                    ? `${formatBytes(image.source.bytes)} original → ${formatBytes(sent)} sent`
                    : `${formatBytes(image.source.bytes)} original`}
                  {image.attempts > 0 ? ` · ${image.attempts} attempt${image.attempts === 1 ? '' : 's'}` : ''}
                </Text>
              </View>
            </Row>
          </Card>
        );
      })}

      <SectionLabel>Delivery</SectionLabel>
      <Card style={styles.factsCard}>
        <Fact label="Report id" value={report.id} mono palette={palette} />
        <Fact label="Created" value={new Date(report.createdAt).toLocaleString()} palette={palette} />
        <Fact
          label="Attempts"
          value={report.attempts === 0 ? 'None needed' : String(report.attempts)}
          palette={palette}
        />
        {report.deliveredAt ? (
          <Fact label="Confirmed" value={new Date(report.deliveredAt).toLocaleString()} palette={palette} />
        ) : null}
        {report.lastError ? (
          <Fact
            label="Last problem"
            value={`${report.lastError.message}${report.lastError.status ? ` (HTTP ${report.lastError.status})` : ''}`}
            palette={palette}
          />
        ) : null}
      </Card>

      <View style={styles.actions}>
        {report.stage !== 'delivered' ? (
          <Button label="Try again now" variant="primary" onPress={() => void queue.retryNow(report.id)} />
        ) : null}
        <Button label="Delete from this device" variant="danger" onPress={remove} />
      </View>
    </ScrollView>
  );
}

function Fact({
  label,
  value,
  mono,
  palette,
}: {
  label: string;
  value: string;
  mono?: boolean;
  palette: ReturnType<typeof usePalette>;
}) {
  return (
    <View style={styles.fact}>
      <Text style={[styles.factLabel, { color: palette.textFaint }]}>{label}</Text>
      <Text selectable style={[styles.factValue, { color: palette.textSoft }, mono ? styles.mono : null]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  content: { padding: spacing.lg, gap: spacing.md },
  header: { gap: spacing.md },
  description: { fontSize: 19, fontWeight: '700', lineHeight: 26 },
  imageCard: { paddingVertical: spacing.md },
  imageRow: { gap: spacing.lg, alignItems: 'flex-start' },
  thumb: { width: 64, height: 64, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  imageMeta: { flex: 1, gap: spacing.sm },
  imageTitle: { fontSize: 15, fontWeight: '600' },
  sizes: { fontSize: 12.5 },
  factsCard: { gap: spacing.md },
  fact: { gap: 2 },
  factLabel: { fontSize: 11.5, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  factValue: { fontSize: 14, lineHeight: 20 },
  mono: { fontFamily: 'monospace', fontSize: 12.5 },
  actions: { gap: spacing.md, marginTop: spacing.sm },
});
