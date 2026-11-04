import { AbortedError, HttpError, ImagingError, NetworkError } from '../errors';
import type {
  Clock,
  CommitArgs,
  Imaging,
  Logger,
  NetworkMonitor,
  PreparedImage,
  RemoteImage,
  ReportStore,
  Transport,
  UploadArgs,
} from '../ports';
import type { ImageFile, ReportRecord, ServerReport } from '../types';

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Survives being handed to a second UploadQueue — that is how we model a restart. */
export class MemoryStore implements ReportStore {
  readonly rows = new Map<string, string>();
  writes = 0;

  async all(): Promise<ReportRecord[]> {
    return [...this.rows.values()].map(row => JSON.parse(row) as ReportRecord);
  }

  async get(id: string): Promise<ReportRecord | null> {
    const row = this.rows.get(id);
    return row ? (JSON.parse(row) as ReportRecord) : null;
  }

  async put(record: ReportRecord): Promise<void> {
    this.writes += 1;
    this.rows.set(record.id, JSON.stringify(record));
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

export class FakeImaging implements Imaging {
  prepared: string[] = [];
  discarded: string[] = [];
  sweeps: string[][] = [];
  /** Set to make preparation blow up for one image id. */
  failFor: string | null = null;

  async prepare(reportId: string, imageId: string, source: ImageFile): Promise<PreparedImage> {
    if (this.failFor === imageId) throw new ImagingError('This photo could not be read.');
    this.prepared.push(imageId);
    const shrunk = Math.min(source.bytes, 1_400_000);
    return {
      uri: `file:///prepared/${reportId}/${imageId}.jpg`,
      bytes: shrunk,
      width: source.width,
      height: source.height,
      passthrough: shrunk === source.bytes,
      quality: shrunk === source.bytes ? null : 76,
    };
  }

  async thumbnail(reportId: string, imageId: string): Promise<string | null> {
    return `file:///thumb/${reportId}/${imageId}.jpg`;
  }

  async discard(uri: string | undefined): Promise<void> {
    if (uri) this.discarded.push(uri);
  }

  async discardReport(reportId: string): Promise<void> {
    this.discarded.push(`dir:${reportId}`);
  }

  async sweepOrphans(liveReportIds: string[]): Promise<number> {
    this.sweeps.push(liveReportIds);
    return 0;
  }
}

export class FakeNetwork implements NetworkMonitor {
  #online: boolean;
  readonly #listeners = new Set<(online: boolean) => void>();

  constructor(online = true) {
    this.#online = online;
  }

  isOnline(): boolean {
    return this.#online;
  }

  subscribe(listener: (online: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setOnline(online: boolean): void {
    this.#online = online;
    for (const listener of this.#listeners) listener(online);
  }
}

export type Outcome =
  | { type: 'ok' }
  /** Fails before the server sees anything. */
  | { type: 'throw'; error: Error }
  /** The server stores it, then the response is lost. The hard case. */
  | { type: 'storeThenThrow'; error: Error };

/**
 * Models the real server's contract, including de-duplication by
 * Idempotency-Key — so a test can assert "exactly once" against it.
 */
/**
 * Server-side state, kept separate from the transport so a test can restart
 * the "app" (a new queue, a new transport) against the same server.
 */
export class FakeServer {
  readonly images = new Map<string, RemoteImage>();
  readonly reports = new Map<string, { description: string; imageIds: string[] }>();
}

export class FakeTransport implements Transport {
  readonly server: FakeServer;
  /** When set, uploads block on this until it resolves or the queue aborts. */
  hold: Promise<void> | null = null;
  readonly uploadCalls: string[] = [];
  readonly commitCalls: string[] = [];
  uploadScript: Outcome[] = [];
  commitScript: Outcome[] = [];
  wiped = 0;

  constructor(server: FakeServer = new FakeServer()) {
    this.server = server;
  }

  get storedImages(): Map<string, RemoteImage> {
    return this.server.images;
  }

  get storedReports(): Map<string, { description: string; imageIds: string[] }> {
    return this.server.reports;
  }

  async uploadImage(args: UploadArgs): Promise<RemoteImage> {
    this.uploadCalls.push(args.idempotencyKey);

    if (this.hold) {
      await new Promise<void>((resolve, reject) => {
        if (args.signal.aborted) return reject(new AbortedError());
        args.signal.addEventListener('abort', () => reject(new AbortedError()));
        void this.hold?.then(() => resolve());
      });
    }

    args.onProgress(args.file.bytes / 2, args.file.bytes);

    const already = this.storedImages.get(args.idempotencyKey);
    if (already) return { ...already, duplicate: true };

    const record: RemoteImage = {
      imageId: args.idempotencyKey,
      bytes: args.file.bytes,
      sha256: `sha-${args.idempotencyKey}`,
      duplicate: false,
    };

    const outcome = this.uploadScript.shift() ?? { type: 'ok' };
    if (outcome.type === 'throw') throw outcome.error;
    if (outcome.type === 'storeThenThrow') {
      this.storedImages.set(args.idempotencyKey, record);
      throw outcome.error;
    }

    args.onProgress(args.file.bytes, args.file.bytes);
    this.storedImages.set(args.idempotencyKey, record);
    return record;
  }

  async commitReport(args: CommitArgs): Promise<{ id: string; duplicate: boolean }> {
    this.commitCalls.push(args.idempotencyKey);

    if (this.storedReports.has(args.idempotencyKey)) {
      return { id: args.idempotencyKey, duplicate: true };
    }

    const outcome = this.commitScript.shift() ?? { type: 'ok' };
    if (outcome.type === 'throw') throw outcome.error;
    if (outcome.type === 'storeThenThrow') {
      this.storedReports.set(args.idempotencyKey, { description: args.description, imageIds: args.imageIds });
      throw outcome.error;
    }

    this.storedReports.set(args.idempotencyKey, { description: args.description, imageIds: args.imageIds });
    return { id: args.idempotencyKey, duplicate: false };
  }

  async listReports(): Promise<ServerReport[]> {
    return [...this.storedReports.entries()].map(([id, value]) => ({
      id,
      description: value.description,
      receivedAt: new Date().toISOString(),
      clientCreatedAt: null,
      images: value.imageIds.map(imageId => ({
        imageId,
        bytes: this.storedImages.get(imageId)?.bytes ?? 0,
        sha256: this.storedImages.get(imageId)?.sha256 ?? '',
        url: `/v1/images/${imageId}`,
      })),
    }));
  }

  async wipeServer(): Promise<void> {
    this.wiped += 1;
    this.storedImages.clear();
    this.storedReports.clear();
  }
}

export const transientFailure = () => new NetworkError('connection reset');
export const serverFailure = () => new HttpError(500, 'CHAOS_500', 'transient server fault');
export const refusal = () => new HttpError(400, 'REJECTED_BY_SERVER', 'the server will not accept this payload');
export const tooLarge = () => new HttpError(413, 'IMAGE_TOO_LARGE', 'image exceeds the ceiling');

/** Poll a condition; far less brittle than guessing at timer counts. */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 4000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(() => resolve(), 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}
