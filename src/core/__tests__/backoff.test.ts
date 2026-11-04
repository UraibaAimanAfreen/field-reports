import { backoffMs } from '../backoff';

describe('backoff', () => {
  const fixed = (value: number) => ({ random: () => value });

  it('grows exponentially', () => {
    const delays = [1, 2, 3, 4].map(attempt => backoffMs(attempt, { baseMs: 1000, capMs: 600_000, ...fixed(0) }));
    expect(delays).toEqual([500, 1000, 2000, 4000]);
  });

  it('never returns zero, so a flapping connection cannot spin the worker', () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect(backoffMs(attempt, { baseMs: 1000, capMs: 60_000, ...fixed(0) })).toBeGreaterThan(0);
    }
  });

  it('respects the cap however many attempts have failed', () => {
    expect(backoffMs(50, { baseMs: 2000, capMs: 60_000, ...fixed(1) })).toBe(60_000);
    expect(backoffMs(50, { baseMs: 2000, capMs: 60_000, ...fixed(0) })).toBe(30_000);
  });

  it('jitters within the top half of the nominal delay', () => {
    const nominal = 8000;
    for (const roll of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = backoffMs(4, { baseMs: 1000, capMs: 600_000, random: () => roll });
      expect(delay).toBeGreaterThanOrEqual(nominal / 2);
      expect(delay).toBeLessThanOrEqual(nominal);
    }
  });
});
