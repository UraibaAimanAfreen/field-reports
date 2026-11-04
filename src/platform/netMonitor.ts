import NetInfo from '@react-native-community/netinfo';
import type { NetworkMonitor } from '../core/ports';

/**
 * Connectivity, read conservatively.
 *
 * We key on `isConnected` and deliberately ignore `isInternetReachable`.
 * Reachability is a probe: it is null before the first check, and it reports
 * false behind captive portals and on links that are simply very slow -- which
 * is the normal case here, not an outage. Treating that as "offline" would
 * park a queue that could have made progress.
 *
 * So: if there is any interface at all, we try. The attempt is the real probe,
 * and a failed attempt is already handled with backoff.
 */
export class NetInfoMonitor implements NetworkMonitor {
  #online = true;
  readonly #listeners = new Set<(online: boolean) => void>();
  #unsubscribe: (() => void) | null = null;

  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = NetInfo.addEventListener(state => {
      const online = state.isConnected !== false;
      if (online === this.#online) return;
      this.#online = online;
      for (const listener of this.#listeners) listener(online);
    });
    void NetInfo.fetch().then(state => {
      const online = state.isConnected !== false;
      if (online === this.#online) return;
      this.#online = online;
      for (const listener of this.#listeners) listener(online);
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  isOnline(): boolean {
    return this.#online;
  }

  subscribe(listener: (online: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
