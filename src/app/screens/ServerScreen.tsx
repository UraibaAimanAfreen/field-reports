import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Image, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatBytes } from '../../core/selectors';
import type { ServerReport } from '../../core/types';
import { useQueue } from '../QueueProvider';
import { Body, Card, EmptyState, SectionLabel } from '../components/ui';
import { radius, spacing, usePalette } from '../theme';

type LoadState = { status: 'loading' } | { status: 'ready'; reports: ServerReport[] } | { status: 'error'; message: string };

/**
 * What the server holds — fetched from it, never read back out of local state.
 *
 * This screen exists to be the independent check. If the queue were lying to
 * itself about what had landed, this is where it would show, so it must not
 * share a cache with the queue or fall back to local records when the request
 * fails. An error here says "we could not ask", never "there is nothing".
 */
export function ServerScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { transport, settings, snapshot } = useQueue();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const reports = await transport.listReports();
      setState({ status: 'ready', reports });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'The server could not be reached.',
      });
    }
  }, [transport]);

  useEffect(() => {
    void load();
  }, [load, settings.baseUrl]);

  // Refresh when a delivery completes, so the two views agree without a tap.
  const deliveredCount = snapshot.reports.filter(report => report.stage === 'delivered').length;
  useEffect(() => {
    void load();
  }, [deliveredCount, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const reports = state.status === 'ready' ? state.reports : [];

  return (
    <View style={[styles.screen, { backgroundColor: palette.bg }]}>
      <FlatList
        data={reports}
        keyExtractor={report => report.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.textFaint} />}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing.xl }]}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={[styles.headline, { color: palette.text }]}>
              {state.status === 'ready'
                ? `${reports.length} report${reports.length === 1 ? '' : 's'} on the server`
                : 'On the server'}
            </Text>
            <Text style={[styles.source, { color: palette.textFaint }]}>
              Fetched from {settings.baseUrl} · pull to refresh
            </Text>
            {state.status === 'error' ? (
              <Card style={[styles.error, { borderColor: palette.bad, backgroundColor: palette.badBg }]}>
                <Text style={[styles.errorTitle, { color: palette.bad }]}>Could not reach the server</Text>
                <Body style={{ color: palette.bad }}>
                  {state.message} This says nothing about whether your reports arrived — it only means we could not ask.
                </Body>
              </Card>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          state.status === 'ready' ? (
            <EmptyState
              title="The server has nothing yet"
              body="Reports appear here once the server has confirmed them, not when they are submitted."
            />
          ) : undefined
        }
        renderItem={({ item }) => (
          <Card style={styles.card}>
            <Text style={[styles.description, { color: palette.text }]}>{item.description}</Text>
            <Text style={[styles.meta, { color: palette.textFaint }]}>
              {new Date(item.receivedAt).toLocaleString()} · {item.images.length} photo
              {item.images.length === 1 ? '' : 's'}
            </Text>
            <View style={styles.thumbs}>
              {item.images.map(image => (
                <View key={image.imageId}>
                  <Image
                    source={{ uri: transport.imageUrl(image.url) }}
                    style={[styles.thumb, { borderColor: palette.line, backgroundColor: palette.surfaceAlt }]}
                  />
                  <Text style={[styles.size, { color: palette.textFaint }]}>{formatBytes(image.bytes)}</Text>
                </View>
              ))}
            </View>
            <SectionLabel>{item.id}</SectionLabel>
          </Card>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { padding: spacing.lg, paddingTop: spacing.md },
  header: { marginBottom: spacing.md },
  headline: { fontSize: 25, fontWeight: '700', letterSpacing: -0.4 },
  source: { fontSize: 12.5, marginTop: spacing.xs },
  error: { marginTop: spacing.md, gap: spacing.sm },
  errorTitle: { fontSize: 15, fontWeight: '700' },
  card: { marginBottom: spacing.md, gap: spacing.sm },
  description: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  meta: { fontSize: 12.5 },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  thumb: { width: 72, height: 72, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth },
  size: { fontSize: 10.5, textAlign: 'center', marginTop: 2 },
});
