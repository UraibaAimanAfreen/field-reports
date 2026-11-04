import { useEffect, useState } from 'react';

/**
 * A clock that ticks only when something on screen depends on it.
 *
 * Retry countdowns need to update every second; nothing else does. Passing
 * `active: false` stops the interval entirely, so an idle queue costs no
 * re-renders.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  return now;
}
