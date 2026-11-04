import type { Logger } from '../core/ports';

export interface LogEntry {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

/**
 * Keeps the last N lines in memory so the Diagnostics screen can show what the
 * queue has been doing. On a device there is no terminal to tail, and "why is
 * this report stuck" is the first question anyone asks.
 */
export class RingLogger implements Logger {
  readonly #entries: LogEntry[] = [];
  readonly #listeners = new Set<(entries: LogEntry[]) => void>();

  readonly #capacity: number;
  readonly #echo: boolean;

  constructor(capacity = 300, echo = __DEV__) {
    this.#capacity = capacity;
    this.#echo = echo;
  }

  get entries(): LogEntry[] {
    return this.#entries;
  }

  subscribe(listener: (entries: LogEntry[]) => void): () => void {
    this.#listeners.add(listener);
    listener([...this.#entries]);
    return () => this.#listeners.delete(listener);
  }

  clear(): void {
    this.#entries.length = 0;
    this.#notify();
  }

  debug(message: string, data?: unknown) { this.#push('debug', message, data); }
  info(message: string, data?: unknown) { this.#push('info', message, data); }
  warn(message: string, data?: unknown) { this.#push('warn', message, data); }
  error(message: string, data?: unknown) { this.#push('error', message, data); }

  #push(level: LogEntry['level'], message: string, data?: unknown): void {
    this.#entries.unshift({ at: Date.now(), level, message });
    if (this.#entries.length > this.#capacity) this.#entries.length = this.#capacity;
    if (this.#echo) {
      const line = `[queue] ${message}`;
      if (level === 'error') console.error(line, data ?? '');
      else if (level === 'warn') console.warn(line, data ?? '');
      else console.log(line, data ?? '');
    }
    this.#notify();
  }

  #notify(): void {
    const snapshot = [...this.#entries];
    for (const listener of this.#listeners) listener(snapshot);
  }
}

export const logger = new RingLogger();
