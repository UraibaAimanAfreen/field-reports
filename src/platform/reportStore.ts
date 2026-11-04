import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ReportStore } from '../core/ports';
import type { ReportRecord } from '../core/types';
import { logger } from './logger';

const PREFIX = 'fr:report:';
const keyFor = (id: string) => `${PREFIX}${id}`;

/**
 * One AsyncStorage row per report, enumerated by key prefix.
 *
 * Deliberately not a single blob holding the whole queue, and deliberately no
 * separate index. A blob means every write rewrites every report, and an index
 * is a second thing that can disagree with the first after a kill. Here the
 * keys *are* the index: a row either exists and parses, or it does not count.
 *
 * AsyncStorage on Android is SQLite-backed, so a single row write is atomic --
 * which is the only atomicity the queue actually relies on.
 */
export class AsyncStorageReportStore implements ReportStore {
  async all(): Promise<ReportRecord[]> {
    const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(PREFIX));
    if (keys.length === 0) return [];
    const rows = await AsyncStorage.getMany(keys);

    const records: ReportRecord[] = [];
    const corrupt: string[] = [];
    for (const [key, value] of Object.entries(rows)) {
      if (!value) continue;
      try {
        records.push(JSON.parse(value) as ReportRecord);
      } catch {
        // One unreadable row must not take the whole queue down with it.
        corrupt.push(key);
      }
    }
    if (corrupt.length) {
      logger.error(`discarding ${corrupt.length} unreadable record(s)`, corrupt);
      await AsyncStorage.removeMany(corrupt);
    }
    return records;
  }

  async get(id: string): Promise<ReportRecord | null> {
    const value = await AsyncStorage.getItem(keyFor(id));
    if (!value) return null;
    try {
      return JSON.parse(value) as ReportRecord;
    } catch {
      return null;
    }
  }

  async put(record: ReportRecord): Promise<void> {
    await AsyncStorage.setItem(keyFor(record.id), JSON.stringify(record));
  }

  async remove(id: string): Promise<void> {
    await AsyncStorage.removeItem(keyFor(id));
  }
}
