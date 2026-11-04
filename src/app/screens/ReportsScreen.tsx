import React, { useCallback, useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { summarise } from '../../core/selectors';
import type { ReportRecord } from '../../core/types';
import { useQueue } from '../QueueProvider';
import { ConnectionBar } from '../components/ConnectionBar';
import { ReportRow } from '../components/ReportRow';
import { Button, EmptyState } from '../components/ui';
import { radius, spacing, usePalette } from '../theme';
import { useNow } from '../useNow';

export function ReportsScreen({ navigation }: { navigation: { navigate: (screen: string, params?: object) => void } }) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { snapshot, ready } = useQueue();
  const { reports, online, active } = snapshot;

  // Tick only while a countdown is on screen.
  const counting = useMemo(
    () => reports.some(report => report.stage === 'queued' && report.nextAttemptAt > Date.now()),
    [reports],
  );
  const now = useNow(counting);

  const summary = useMemo(() => summarise(reports, online), [reports, online]);

  const openReport = useCallback(
    (reportId: string) => navigation.navigate('ReportDetail', { reportId }),
    [navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: ReportRecord }) => (
      <ReportRow report={item} active={active} online={online} now={now} onPress={openReport} />
    ),
    [active, online, now, openReport],
  );

  return (
    <View style={[styles.screen, { backgroundColor: palette.bg }]}>
      <FlatList
        data={reports}
        keyExtractor={report => report.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 96 }]}
        ListHeaderComponent={
          <View>
            {/* With no reports the empty state already says so, and printing
                the same sentence twice reads like a bug. The connection bar
                stays either way -- knowing you are offline is useful before
                you start writing, not only after. */}
            {reports.length > 0 ? (
              <Text style={[styles.headline, { color: palette.text }]}>{summary.headline}</Text>
            ) : null}
            {summary.blocked > 0 && summary.outstanding > 0 ? (
              <Text style={[styles.subhead, { color: palette.bad }]}>
                {summary.blocked} also need{summary.blocked === 1 ? 's' : ''} your attention
              </Text>
            ) : null}
            <View style={styles.bar}>
              <ConnectionBar online={online} outstanding={summary.outstanding} />
            </View>
          </View>
        }
        ListEmptyComponent={
          !ready ? undefined : (
            <EmptyState
              title="No reports yet"
              body="Write a short description, attach up to five photos, and submit. Everything you submit is saved on this device first, then sent on its own — you do not have to wait for a signal."
              action={<Button label="New report" variant="primary" onPress={() => navigation.navigate('Compose')} />}
            />
          )
        }
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New report"
        onPress={() => navigation.navigate('Compose')}
        style={({ pressed }) => [
          styles.fab,
          {
            backgroundColor: palette.accent,
            bottom: insets.bottom + spacing.lg,
            opacity: pressed ? 0.85 : 1,
          },
        ]}>
        <Text style={[styles.fabPlus, { color: palette.accentText }]}>+</Text>
        <Text style={[styles.fabLabel, { color: palette.accentText }]}>New report</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { padding: spacing.lg, paddingTop: spacing.md },
  headline: { fontSize: 25, fontWeight: '700', letterSpacing: -0.4, marginBottom: spacing.xs },
  subhead: { fontSize: 14, fontWeight: '600', marginBottom: spacing.sm },
  bar: { marginTop: spacing.md },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    height: 54,
    borderRadius: radius.pill,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  fabPlus: { fontSize: 22, fontWeight: '500', marginTop: -2 },
  fabLabel: { fontSize: 16, fontWeight: '700' },
});
