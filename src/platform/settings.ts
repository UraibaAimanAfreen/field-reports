import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const KEY = 'fr:settings';

/**
 * 10.0.2.2 is the host machine as seen from the Android emulator. A reviewer
 * on a physical device changes this in Settings; the server prints the LAN
 * URL to paste in when it starts.
 */
export const DEFAULT_BASE_URL = Platform.OS === 'android' ? 'http://10.0.2.2:4000' : 'http://localhost:4000';

export interface Settings {
  baseUrl: string;
}

const DEFAULTS: Settings = { baseUrl: DEFAULT_BASE_URL };

class SettingsStore {
  #value: Settings = DEFAULTS;
  readonly #listeners = new Set<(settings: Settings) => void>();

  get current(): Settings {
    return this.#value;
  }

  async load(): Promise<Settings> {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) this.#value = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
    } catch {
      this.#value = DEFAULTS;
    }
    this.#notify();
    return this.#value;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.#value = { ...this.#value, ...patch };
    if (this.#value.baseUrl) this.#value.baseUrl = this.#value.baseUrl.trim().replace(/\/+$/, '');
    await AsyncStorage.setItem(KEY, JSON.stringify(this.#value));
    this.#notify();
    return this.#value;
  }

  subscribe(listener: (settings: Settings) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#value);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#value);
  }
}

export const settings = new SettingsStore();
