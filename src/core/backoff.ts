export interface BackoffOptions {
  baseMs: number;
  capMs: number;
  /** Injected so tests are deterministic. */
  random: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 2_000,
  capMs: 5 * 60_000,
  random: Math.random,
};

/**
 * Equal-jitter exponential backoff: half the nominal delay, plus a random
 * share of the other half.
 *
 * Jitter matters even for a single device: without it, every queued report
 * wakes at the same instant after an outage and they all collide on the first
 * scrap of returning signal. Equal jitter (rather than full jitter) keeps a
 * floor under the delay, so a flapping connection cannot spin the worker.
 *
 * @param attempt 1 for the first retry.
 */
export function backoffMs(attempt: number, options: Partial<BackoffOptions> = {}): number {
  const { baseMs, capMs, random } = { ...DEFAULT_BACKOFF, ...options };
  const safeAttempt = Math.max(1, Math.min(attempt, 30));
  const nominal = Math.min(capMs, baseMs * 2 ** (safeAttempt - 1));
  const half = nominal / 2;
  return Math.round(half + random() * half);
}
