import React, { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatBytes } from '../../core/selectors';
import { bytesUsed } from '../../platform/files';
import { draftStore } from '../../platform/draftStore';
import { logger, type LogEntry } from '../../platform/logger';
import { DEFAULT_BASE_URL } from '../../platform/settings';
import { useQueue } from '../QueueProvider';
import { Body, Button, Card, SectionLabel } from '../components/ui';
import { radius, spacing, usePalette } from '../theme';

export function SettingsScreen() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { queue, transport, settings, updateSettings, snapshot } = useQueue();

  const [url, setUrl] = useState(settings.baseUrl);
  const [storage, setStorage] = useState<number | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [health, setHealth] = useState<string | null>(null);

  useEffect(() => setUrl(settings.baseUrl), [settings.baseUrl]);
  useEffect(() => logger.subscribe(setLog), []);

  const refreshStorage = useCallback(() => {
    void bytesUsed().then(setStorage);
  }, []);
  useEffect(refreshStorage, [refreshStorage, snapshot.reports.length]);

  const pending = queue.pendingCount();

  const testConnection = useCallback(async () => {
    setHealth('Checking…');
    try {
      await transport.listReports();
      setHealth(`Reachable at ${settings.baseUrl}`);
    } catch (error) {
      setHealth(error instanceof Error ? error.message : 'Could not reach the server.');
    }
  }, [settings.baseUrl, transport]);

  /**
   * Reset, with the blast radius stated in the button and again in the
   * confirmation. Three separate actions rather than one "Reset" that the
   * user has to guess the meaning of -- clearing finished work and destroying
   * unsent work are not the same decision.
   */
  const clearFinished = useCallback(() => {
    Alert.alert(
      'Clear finished reports?',
      'Removes reports the server has already confirmed, and the photos kept for them on this device. Anything still waiting to send is left alone. The server keeps its copies.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          onPress: async () => {
            const count = await queue.clearDelivered();
            refreshStorage();
            Alert.alert('Cleared', `${count} finished report${count === 1 ? '' : 's'} removed from this device.`);
          },
        },
      ],
    );
  }, [queue, refreshStorage]);

  const wipeDevice = useCallback(() => {
    Alert.alert(
      pending > 0 ? `Delete ${pending} unsent report${pending === 1 ? '' : 's'}?` : 'Delete everything on this device?',
      pending > 0
        ? `${pending} report${pending === 1 ? ' has' : 's have'} not reached the server. Deleting now means ${
            pending === 1 ? 'it is' : 'they are'
          } gone for good. The server keeps anything it already confirmed.`
        : 'Removes every report, photo and draft from this device. The server is not touched.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete everything',
          style: 'destructive',
          onPress: async () => {
            const count = await queue.discardAll();
            await draftStore.clear();
            refreshStorage();
            Alert.alert('Device cleared', `${count} report${count === 1 ? '' : 's'} removed. The server was not touched.`);
          },
        },
      ],
    );
  }, [pending, queue, refreshStorage]);

  const wipeServer = useCallback(() => {
    Alert.alert(
      'Wipe the server?',
      'Deletes every report and photo the server holds, for everyone. This is a development convenience and has no undo. Reports on this device are not touched.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Wipe server',
          style: 'destructive',
          onPress: async () => {
            try {
              await transport.wipeServer();
              Alert.alert('Server wiped', 'The server is now empty. This device was not touched.');
            } catch (error) {
              Alert.alert('Could not wipe', error instanceof Error ? error.message : 'The server could not be reached.');
            }
          },
        },
      ],
    );
  }, [transport]);

  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: palette.bg }]}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
      keyboardShouldPersistTaps="handled">
      <SectionLabel>Backend</SectionLabel>
      <Card style={styles.card}>
        <TextInput
          value={url}
          onChangeText={setUrl}
          onBlur={() => void updateSettings({ baseUrl: url })}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={DEFAULT_BASE_URL}
          placeholderTextColor={palette.textFaint}
          style={[styles.input, { color: palette.text, borderColor: palette.line, backgroundColor: palette.surfaceAlt }]}
          accessibilityLabel="Backend base URL"
        />
        <Body style={styles.hint}>
          {DEFAULT_BASE_URL} reaches your machine from the Android emulator. On a physical device, use the LAN address
          the server prints when it starts.
        </Body>
        <View style={styles.buttonRow}>
          <Button label="Save and test" variant="secondary" onPress={async () => { await updateSettings({ baseUrl: url }); await testConnection(); }} />
        </View>
        {health ? <Body style={styles.health}>{health}</Body> : null}
      </Card>

      <SectionLabel>This device</SectionLabel>
      <Card style={styles.card}>
        <Stat label="Reports held" value={String(snapshot.reports.length)} palette={palette} />
        <Stat label="Not yet on the server" value={String(pending)} palette={palette} />
        <Stat label="Photo storage used" value={storage == null ? '—' : formatBytes(storage)} palette={palette} />
      </Card>

      <SectionLabel>Start over</SectionLabel>
      <Card style={styles.card}>
        <Body style={styles.hint}>
          Three different blast radiuses. Each says exactly what it destroys, and each leaves the others alone.
        </Body>
        <Button label="Clear finished reports" variant="secondary" onPress={clearFinished} />
        <Button label="Delete everything on this device" variant="danger" onPress={wipeDevice} />
        <Button label="Wipe the server" variant="danger" onPress={wipeServer} />
      </Card>

      <SectionLabel>Activity log</SectionLabel>
      <Card style={styles.logCard}>
        {log.length === 0 ? (
          <Body>Nothing yet. The queue writes here as it works.</Body>
        ) : (
          log.slice(0, 40).map((entry, index) => (
            <Text
              key={`${entry.at}-${index}`}
              style={[
                styles.logLine,
                { color: entry.level === 'error' ? palette.bad : entry.level === 'warn' ? palette.warn : palette.textSoft },
              ]}>
              {new Date(entry.at).toLocaleTimeString()}  {entry.message}
            </Text>
          ))
        )}
        {log.length > 0 ? <Button label="Clear log" variant="ghost" onPress={() => logger.clear()} /> : null}
      </Card>
    </ScrollView>
  );
}

function Stat({ label, value, palette }: { label: string; value: string; palette: ReturnType<typeof usePalette> }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: palette.textSoft }]}>{label}</Text>
      <Text style={[styles.statValue, { color: palette.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },
  card: { gap: spacing.md },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 46,
    fontSize: 15,
  },
  hint: { fontSize: 13 },
  buttonRow: { flexDirection: 'row' },
  health: { fontSize: 13 },
  stat: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statLabel: { fontSize: 14.5 },
  statValue: { fontSize: 15.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  logCard: { gap: spacing.xs },
  logLine: { fontSize: 11.5, fontFamily: 'monospace', lineHeight: 17 },
});
