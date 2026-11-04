/**
 * The persisted shape of work in progress.
 *
 * Everything here is written to durable storage before it is acted on, so the
 * app can be killed between any two lines of the worker and resume correctly.
 */

/** Why something failed, and -- the important part -- whether retrying can fix it. */
export type FailureKind =
  | 'offline' //    no network. Not a failure: we simply wait.
  | 'network' //    connection refused, reset, DNS. Transient.
  | 'timeout' //    no progress for too long. Transient.
  | 'server' //     5xx, 429, 408, 409. Transient.
  | 'rejected' //   4xx. The server will never accept this payload.
  | 'tooLarge' //   413. A bug on our side: we promised to stay under the cap.
  | 'imaging' //    the photo could not be read or compressed.
  | 'unknown';

export interface FailureInfo {
  kind: FailureKind;
  /** Drives the queue. A false here stops the report rather than looping forever. */
  retryable: boolean;
  /** Shown to the user, so it is written for the user. */
  message: string;
  code?: string;
  status?: number;
  at: number;
}

export type ImageStage =
  | 'raw' //       copied into our storage, not yet compressed
  | 'prepared' //  compressed and under the ceiling, not yet sent
  | 'uploaded'; // the server has acknowledged these exact bytes

export interface ImageFile {
  uri: string;
  bytes: number;
  width: number;
  height: number;
}

export interface ImageRecord {
  id: string;
  stage: ImageStage;
  /** The user's original, copied somewhere the OS will not reclaim it. */
  source: ImageFile;
  /** What we actually upload. Absent until preparation succeeds. */
  prepared?: ImageFile;
  /** Small local copy kept for the on-device list after the big files are gone. */
  thumbUri?: string;
  remote?: { imageId: string; bytes: number; sha256: string };
  attempts: number;
  lastError?: FailureInfo;
}

export type ReportStage =
  | 'queued' //    accepted and safe on disk, waiting for its turn or the network
  | 'working' //   being prepared or uploaded right now
  | 'delivered' // the server has confirmed it
  | 'blocked'; //  permanently failed; needs a decision from the user

export interface ReportRecord {
  id: string;
  description: string;
  images: ImageRecord[];
  stage: ReportStage;
  createdAt: number;
  updatedAt: number;
  /** Counts real failures only. Being offline does not burn an attempt. */
  attempts: number;
  nextAttemptAt: number;
  lastError?: FailureInfo;
  deliveredAt?: number;
}

/** Live, non-persisted progress for the report currently being worked on. */
export interface ActiveWork {
  reportId: string;
  imageId: string | null;
  phase: 'preparing' | 'uploading' | 'committing';
  /** 0..1 for the current image, null while preparing (no meaningful fraction). */
  fraction: number | null;
  imageIndex: number;
  imageCount: number;
}

export interface QueueSnapshot {
  reports: ReportRecord[];
  online: boolean;
  running: boolean;
  active: ActiveWork | null;
}

/** What the Server tab displays. Fetched from the server, never from local state. */
export interface ServerReport {
  id: string;
  description: string;
  receivedAt: string;
  clientCreatedAt: number | null;
  images: { imageId: string; bytes: number; sha256: string; url: string }[];
}

export interface DraftImage {
  uri: string;
  bytes: number;
  width: number;
  height: number;
}

export interface Draft {
  description: string;
  images: DraftImage[];
}
