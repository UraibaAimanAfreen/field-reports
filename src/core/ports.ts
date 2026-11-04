import type { ImageFile, ReportRecord, ServerReport } from './types';

/**
 * Everything the queue needs from the outside world, as interfaces.
 *
 * This is the file that makes "the upload logic must be exercisable without
 * rendering a screen" true. Nothing under src/core imports react-native; the
 * queue talks to these ports, the app supplies React Native implementations,
 * and the tests and the headless harness supply their own. A test for the
 * lost-response case is then a five-line fake, not an emulator.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface NetworkMonitor {
  isOnline(): boolean;
  /** Returns an unsubscribe function. */
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** Durable storage for report records. One record per key: see the adapter. */
export interface ReportStore {
  all(): Promise<ReportRecord[]>;
  get(id: string): Promise<ReportRecord | null>;
  put(record: ReportRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface PreparedImage extends ImageFile {
  /** True when the original already fit and was copied rather than re-encoded. */
  passthrough: boolean;
  quality: number | null;
}

export interface Imaging {
  /** Compress and resize until the file is under the ceiling. */
  prepare(reportId: string, imageId: string, source: ImageFile): Promise<PreparedImage>;
  /** Small local copy for list rows. Failure here must never block delivery. */
  thumbnail(reportId: string, imageId: string, source: ImageFile): Promise<string | null>;
  /** Best-effort delete; never throws. */
  discard(uri: string | undefined): Promise<void>;
  /** Remove everything belonging to a report. */
  discardReport(reportId: string): Promise<void>;
  /** Delete image directories with no corresponding record. */
  sweepOrphans(liveReportIds: string[]): Promise<number>;
}

export interface UploadArgs {
  idempotencyKey: string;
  reportId: string;
  file: ImageFile;
  onProgress: (sentBytes: number, totalBytes: number) => void;
  signal: AbortSignal;
}

export interface RemoteImage {
  imageId: string;
  bytes: number;
  sha256: string;
  duplicate: boolean;
}

export interface CommitArgs {
  idempotencyKey: string;
  description: string;
  imageIds: string[];
  createdAt: number;
  signal: AbortSignal;
}

export interface Transport {
  uploadImage(args: UploadArgs): Promise<RemoteImage>;
  commitReport(args: CommitArgs): Promise<{ id: string; duplicate: boolean }>;
  listReports(signal?: AbortSignal): Promise<ServerReport[]>;
  wipeServer(): Promise<void>;
}

export interface QueuePorts {
  store: ReportStore;
  imaging: Imaging;
  transport: Transport;
  clock: Clock;
  network: NetworkMonitor;
  logger: Logger;
}
