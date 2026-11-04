import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ImageRecord } from '../core/types';

const KEY = 'fr:draft';

export interface StoredDraft {
  id: string;
  description: string;
  images: ImageRecord[];
  updatedAt: number;
}

/**
 * The half-written report.
 *
 * The queue guarantees nothing is lost once a report is *submitted*. A draft
 * is weaker than that by nature — it has not been submitted — but losing a
 * description and five photos to a force-quit would still feel like losing
 * work, and the photos are already durable on disk by this point. Only the
 * text and the ordering need saving, which is one small row.
 */
export const draftStore = {
  async load(): Promise<StoredDraft | null> {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredDraft;
      if (!parsed?.id || !Array.isArray(parsed.images)) return null;
      return parsed;
    } catch {
      return null;
    }
  },

  async save(draft: Omit<StoredDraft, 'updatedAt'>): Promise<void> {
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify({ ...draft, updatedAt: Date.now() }));
    } catch {
      // A draft we failed to save is a minor loss, never a crash.
    }
  },

  async clear(): Promise<void> {
    await AsyncStorage.removeItem(KEY).catch(() => undefined);
  },
};
