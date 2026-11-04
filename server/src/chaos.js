/**
 * Fail-on-demand controls.
 *
 * The brief requires the backend to be breakable on command: latency, dropped
 * connections, refused uploads, and requests that never answer. Each mode
 * targets a specific client behaviour we want to be able to prove:
 *
 *   slow     -> does the app keep making progress on a bad link, or give up?
 *   error500 -> is a transient server fault retried with backoff?
 *   refuse   -> is a permanent 4xx NOT retried forever?
 *   hang     -> the lost-response case. The server stores the upload and then
 *               never answers. The client must retry, and that retry must NOT
 *               create a second copy. This is the exactly-once test.
 *   drop     -> connection destroyed before anything is committed.
 *   flaky    -> a random mix, for long unattended runs.
 */
export const MODES = ['off', 'slow', 'error500', 'refuse', 'hang', 'drop', 'flaky'];

const DEFAULTS = {
  mode: 'off',
  latencyMs: 0,
  linkKbps: 512,
  dropAfterMs: 250,
  affect: 'writes',
};

/** Duty cycle used when stalling a socket. Not user-tunable: see stallSocket. */
const STALL_PERCENT = 85;

export class Chaos {
  #state = { ...DEFAULTS };
  #log = [];

  get state() {
    return { ...this.#state };
  }

  update(patch) {
    const next = { ...this.#state };
    if (patch.mode !== undefined) {
      if (!MODES.includes(patch.mode)) throw new Error(`unknown mode: ${patch.mode}`);
      next.mode = patch.mode;
    }
    if (patch.latencyMs !== undefined) next.latencyMs = clamp(Number(patch.latencyMs) || 0, 0, 60000);
    if (patch.linkKbps !== undefined) next.linkKbps = clamp(Number(patch.linkKbps) || 0, 8, 8192);
    if (patch.dropAfterMs !== undefined) next.dropAfterMs = clamp(Number(patch.dropAfterMs) || 0, 0, 60000);
    if (patch.affect !== undefined) {
      if (!['writes', 'all'].includes(patch.affect)) throw new Error(`unknown affect: ${patch.affect}`);
      next.affect = patch.affect;
    }
    this.#state = next;
    this.note({
      kind: 'chaos',
      message: `mode=${next.mode} latency=${next.latencyMs}ms link=${next.linkKbps}kbps affect=${next.affect}`,
    });
    return this.state;
  }

  /** Resolve the mode for one request (expands `flaky` into a concrete choice). */
  resolveMode(req) {
    const { mode, affect } = this.#state;
    if (mode === 'off') return 'off';
    if (affect === 'writes' && req.method === 'GET') return 'off';
    if (mode !== 'flaky') return mode;
    const roll = Math.random();
    if (roll < 0.35) return 'drop';
    if (roll < 0.6) return 'error500';
    if (roll < 0.9) return 'slow';
    return 'off';
  }

  note(entry) {
    this.#log.unshift({ at: new Date().toISOString(), ...entry });
    if (this.#log.length > 200) this.#log.length = 200;
  }

  get log() {
    return this.#log;
  }

  clearLog() {
    this.#log = [];
  }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** How long `bytes` would take on a `kbps` link, in milliseconds. */
export const transferMs = (bytes, kbps) => (kbps > 0 ? Math.round((bytes * 8) / kbps) : 0);

/**
 * Slow the link by pausing the TCP socket on a duty cycle.
 *
 * Pausing the socket (rather than the parsed request stream) is the only place
 * backpressure can be applied without fighting multer's pipe. It genuinely
 * throttles a real link.
 *
 * It does NOT throttle loopback: macOS auto-tunes the loopback receive buffer
 * to net.inet.tcp.autorcvbufmax (4 MB on this machine), so the kernel accepts
 * an entire 5 MB upload whether or not Node is reading. That is why `slow`
 * mode ALSO holds the response for the time the body would have taken at the
 * configured link rate -- see transferMs. The stall does the real work on a
 * real link; the hold makes the mode deterministic everywhere.
 *
 * For a faithful 2G test, throttle the emulator instead:
 *     adb emu network speed gsm      (or launch with -netspeed gsm)
 */
export function stallSocket(req) {
  const socket = req.socket;
  if (!socket) return () => {};

  const period = 200;
  const offMs = Math.round((period * STALL_PERCENT) / 100);
  const onMs = Math.max(10, period - offMs);
  let stopped = false;

  (async () => {
    while (!stopped && !socket.destroyed) {
      socket.pause();
      await sleep(offMs);
      if (stopped || socket.destroyed) break;
      socket.resume();
      await sleep(onMs);
    }
    if (!socket.destroyed) socket.resume();
  })();

  return () => {
    stopped = true;
    if (!socket.destroyed) socket.resume();
  };
}
