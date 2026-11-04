import { backoffMs, type BackoffOptions } from './backoff';
import { AbortedError, OfflineError, ValidationError, classifyError } from './errors';
import { makeImageId, makeReportId } from './ids';
import { LIMITS } from './limits';
import type { QueuePorts } from './ports';
import type {
  ActiveWork,
  DraftImage,
  ImageRecord,
  QueueSnapshot,
  ReportRecord,
} from './types';

export interface QueueOptions {
  backoff?: Partial<BackoffOptions>;
  /**
   * Give up after this many genuinely failed attempts.
   *
   * Retrying forever is not the same as never losing anything. With the
   * default backoff, twelve attempts span several hours; past that, something
   * is wrong that another attempt will not fix, and the honest thing is to
   * tell the user rather than let a report sit in "waiting" indefinitely. The
   * report and its bytes stay on disk, and Retry is one tap away -- being
   * blocked is a state, not a deletion.
   */
  maxAttempts?: number;
  /** Upper bound on how long stop() will wait for in-flight work to unwind. */
  stopTimeoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;

export interface EnqueueInput {
  /** The composer allocates this up front so staged files have a home. */
  id?: string;
  description: string;
  images: ImageRecord[];
}

type Mutator = (report: ReportRecord) => void;

const PROGRESS_EMIT_INTERVAL_MS = 120;

/**
 * The delivery guarantee, in one class.
 *
 * Contract
 * --------
 * Once `enqueue` resolves, the report is on disk and will reach the server
 * exactly once, with no further input from the user — across force-quits,
 * dropped connections, lost responses and days of no signal.
 *
 * How it holds
 * ------------
 * - **Nothing is lost.** `enqueue` writes the record durably before it
 *   resolves, and the image bytes were copied into our own storage before
 *   that. Every state change is persisted as it happens, so a kill between
 *   any two steps resumes from the last completed one.
 *
 * - **Nothing lands twice.** Each image and each report carries an id minted
 *   on the device *before* the first attempt and reused by every retry. The
 *   server keys on it, so a replay returns the original instead of storing a
 *   second copy. This is what makes at-least-once delivery on the wire add up
 *   to exactly-once at rest — and it is the only design that survives the
 *   case where the server succeeded and the response was lost.
 *
 * - **Progress survives a bad link.** Work advances one image at a time and
 *   each completed image is committed to disk. A connection that dies on
 *   image four does not cost images one to three.
 *
 * - **Only the right things are retried.** See errors.ts: transport and
 *   server faults are retried with jittered backoff; a verdict about the
 *   payload itself is not retried at all, because it never would succeed.
 *
 * - **Being offline is not a failure.** It burns no attempt and triggers no
 *   backoff; the worker parks and the network listener wakes it.
 *
 * It has no idea React exists. See ports.ts.
 */
export class UploadQueue {
  readonly #ports: QueuePorts;
  readonly #options: QueueOptions;
  readonly #listeners = new Set<(snapshot: QueueSnapshot) => void>();

  #reports = new Map<string, ReportRecord>();
  #online = false;
  #running = false;
  #active: ActiveWork | null = null;

  #wake: (() => void) | null = null;
  #sleepTimer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: AbortController | null = null;
  #unsubscribeNetwork: (() => void) | null = null;
  #writeChain: Promise<unknown> = Promise.resolve();
  #lastProgressEmit = 0;
  #loopDone: Promise<void> = Promise.resolve();

  constructor(ports: QueuePorts, options: QueueOptions = {}) {
    this.#ports = ports;
    this.#options = options;
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;

    const stored = await this.#ports.store.all();
    this.#reports = new Map(stored.map(report => [report.id, report]));
    await this.#recover();

    this.#online = this.#ports.network.isOnline();
    this.#unsubscribeNetwork = this.#ports.network.subscribe(online => {
      const changed = online !== this.#online;
      this.#online = online;
      if (changed) {
        this.#ports.logger.info(online ? 'network back' : 'network lost');
        this.#wakeNow();
        this.#emit();
      }
    });

    this.#emit();
    this.#loopDone = this.#loop();

    // Files with no owning record: a composer abandoned mid-draft, or a
    // delivery that died between deleting the record and deleting its bytes.
    void this.#ports.imaging
      .sweepOrphans([...this.#reports.keys()])
      .then(count => count > 0 && this.#ports.logger.info(`swept ${count} orphaned image folder(s)`))
      .catch(error => this.#ports.logger.warn('orphan sweep failed', error));
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#inFlight?.abort();
    this.#unsubscribeNetwork?.();
    this.#unsubscribeNetwork = null;
    this.#wakeNow();
    // Bounded: a transport that ignores its abort signal must not be able to
    // wedge teardown. Whatever is still in flight is safe to abandon -- the
    // record on disk is the source of truth, and the next start() requeues it.
    const timeout = this.#options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    let guard: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>(resolve => {
      guard = setTimeout(() => resolve(), timeout);
    });
    try {
      await Promise.race([this.#loopDone, expired]);
    } finally {
      if (guard) clearTimeout(guard); // never leave a timer holding the loop open
    }
    this.#emit();
  }

  /**
   * A crash leaves records mid-flight. We do not trust any of them: `working`
   * means "a process that no longer exists said it was busy". Requeue, and let
   * idempotency make the repeated attempt free.
   */
  async #recover(): Promise<void> {
    const now = this.#ports.clock.now();
    for (const report of [...this.#reports.values()]) {
      const wasWorking = report.stage === 'working';
      const parked = report.stage === 'queued' && report.nextAttemptAt > now;
      if (!wasWorking && !parked) continue;
      await this.#mutate(report.id, draft => {
        if (draft.stage === 'working') draft.stage = 'queued';
        // Reopening the app is a signal from the user. Spend one attempt now
        // rather than making them watch a backoff timer they did not cause.
        draft.nextAttemptAt = now;
      });
      if (wasWorking) this.#ports.logger.info(`recovered ${report.id} from an interrupted run`);
    }
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  subscribe(listener: (snapshot: QueueSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.#listeners.delete(listener);
  }

  getSnapshot(): QueueSnapshot {
    return {
      reports: [...this.#reports.values()].sort((a, b) => b.createdAt - a.createdAt),
      online: this.#online,
      running: this.#running,
      active: this.#active,
    };
  }

  static newDraftId(): string {
    return makeReportId();
  }

  static newImageId(): string {
    return makeImageId();
  }

  /** Build the record for a freshly picked file, before any processing. */
  static rawImage(file: DraftImage, id = makeImageId()): ImageRecord {
    return {
      id,
      stage: 'raw',
      source: { uri: file.uri, bytes: file.bytes, width: file.width, height: file.height },
      attempts: 0,
    };
  }

  /**
   * Accept a report. Resolves once it is durable — after this, losing it would
   * take a disk failure, and the caller may clear the composer.
   */
  async enqueue(input: EnqueueInput): Promise<ReportRecord> {
    const description = input.description.trim();
    if (!description) {
      throw new ValidationError('Add a short description before submitting.');
    }
    if (description.length > LIMITS.maxDescriptionChars) {
      throw new ValidationError(`Descriptions are limited to ${LIMITS.maxDescriptionChars} characters.`);
    }
    if (input.images.length < LIMITS.minImages) {
      throw new ValidationError('Add at least one photo.');
    }
    if (input.images.length > LIMITS.maxImages) {
      throw new ValidationError(`A report can hold at most ${LIMITS.maxImages} photos.`);
    }

    const now = this.#ports.clock.now();
    const report: ReportRecord = {
      id: input.id ?? makeReportId(),
      description,
      images: input.images,
      stage: 'queued',
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      nextAttemptAt: now,
    };

    await this.#write(report);
    this.#ports.logger.info(`queued ${report.id} (${report.images.length} image(s))`);
    this.#wakeNow();
    return report;
  }

  /**
   * Nudge the worker to re-evaluate now.
   *
   * Used when the app returns to the foreground: Android may have frozen the
   * JS thread mid-wait, and the user reopening the app is the clearest
   * possible signal that they want their work to move.
   */
  poke(): void {
    this.#wakeNow();
  }

  /** User pressed "try again" on a blocked or parked report. */
  async retryNow(reportId: string): Promise<void> {
    await this.#mutate(reportId, report => {
      if (report.stage === 'delivered') return;
      report.stage = 'queued';
      report.attempts = 0;
      report.nextAttemptAt = this.#ports.clock.now();
      report.lastError = undefined;
      for (const image of report.images) image.lastError = undefined;
    });
    this.#wakeNow();
  }

  /** Delete one report and its bytes. Does not touch the server. */
  async remove(reportId: string): Promise<void> {
    if (this.#active?.reportId === reportId) this.#inFlight?.abort();
    this.#reports.delete(reportId);
    await this.#ports.store.remove(reportId);
    await this.#ports.imaging.discardReport(reportId);
    this.#emit();
  }

  /** Remove reports the server has confirmed. Leaves unsent work alone. */
  async clearDelivered(): Promise<number> {
    const delivered = [...this.#reports.values()].filter(report => report.stage === 'delivered');
    for (const report of delivered) await this.remove(report.id);
    return delivered.length;
  }

  /** Remove everything on the device, sent or not. Leaves the server alone. */
  async discardAll(): Promise<number> {
    const all = [...this.#reports.keys()];
    for (const id of all) await this.remove(id);
    await this.#ports.imaging.sweepOrphans([]);
    return all.length;
  }

  /** How many reports the user would lose by wiping right now. */
  pendingCount(): number {
    return [...this.#reports.values()].filter(report => report.stage !== 'delivered').length;
  }

  // ---------------------------------------------------------------------
  // Worker
  // ---------------------------------------------------------------------

  async #loop(): Promise<void> {
    while (this.#running) {
      const next = this.#pickNext();
      if (!next) {
        await this.#park(null);
        continue;
      }
      if (next.waitMs > 0 || !next.report) {
        await this.#park(next.waitMs);
        continue;
      }
      await this.#process(next.report);
    }
  }

  /**
   * Oldest queued report whose backoff has elapsed. Oldest first, so the
   * inspector's first report is the first to land.
   *
   * A report with uncompressed images is actionable even with no network:
   * preparing photos while offline means the bytes are ready the instant a
   * signal appears, instead of the user watching a spinner afterwards.
   */
  #pickNext(): { report?: ReportRecord; waitMs: number } | null {
    const now = this.#ports.clock.now();
    let soonest = Number.POSITIVE_INFINITY;

    const queued = [...this.#reports.values()]
      .filter(report => report.stage === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const report of queued) {
      const hasLocalWork = report.images.some(image => image.stage === 'raw');
      if (!hasLocalWork && !this.#online) continue;
      if (report.nextAttemptAt <= now) return { report, waitMs: 0 };
      soonest = Math.min(soonest, report.nextAttemptAt - now);
    }

    if (!Number.isFinite(soonest)) return null;
    return { waitMs: soonest };
  }

  async #process(report: ReportRecord): Promise<void> {
    const controller = new AbortController();
    this.#inFlight = controller;
    await this.#mutate(report.id, draft => {
      draft.stage = 'working';
    });

    try {
      await this.#prepareImages(report.id);
      await this.#uploadImages(report.id, controller.signal);
      await this.#commit(report.id, controller.signal);
    } catch (error) {
      await this.#recordFailure(report.id, error);
    } finally {
      this.#inFlight = null;
      this.#setActive(null);
    }
  }

  async #prepareImages(reportId: string): Promise<void> {
    const images = () => this.#reports.get(reportId)?.images ?? [];
    for (let index = 0; index < images().length; index += 1) {
      this.#assertRunning();
      const image = images()[index];
      if (image.stage !== 'raw') continue;

      this.#setActive({
        reportId,
        imageId: image.id,
        phase: 'preparing',
        fraction: null,
        imageIndex: index,
        imageCount: images().length,
      });

      const prepared = await this.#ports.imaging.prepare(reportId, image.id, image.source);
      const thumbUri = await this.#ports.imaging.thumbnail(reportId, image.id, prepared);

      await this.#mutate(reportId, draft => {
        const target = draft.images[index];
        target.prepared = prepared;
        target.thumbUri = thumbUri ?? target.thumbUri;
        target.stage = 'prepared';
        target.lastError = undefined;
      });

      // The original is only needed to produce the prepared copy. Holding five
      // 18 MB photos per report would fill the device long before the backlog
      // drained.
      await this.#ports.imaging.discard(image.source.uri);
    }
  }

  async #uploadImages(reportId: string, signal: AbortSignal): Promise<void> {
    const images = () => this.#reports.get(reportId)?.images ?? [];
    for (let index = 0; index < images().length; index += 1) {
      this.#assertRunning();
      const image = images()[index];
      if (image.stage !== 'prepared' || !image.prepared) continue;
      if (!this.#online) throw new OfflineError();

      this.#setActive({
        reportId,
        imageId: image.id,
        phase: 'uploading',
        fraction: 0,
        imageIndex: index,
        imageCount: images().length,
      });

      try {
        const remote = await this.#ports.transport.uploadImage({
          idempotencyKey: image.id,
          reportId,
          file: image.prepared,
          signal,
          onProgress: (sent, total) => this.#reportProgress(sent, total),
        });

        if (remote.duplicate) {
          this.#ports.logger.info(`${image.id} was already on the server — earlier attempt had landed`);
        }

        await this.#mutate(reportId, draft => {
          const target = draft.images[index];
          target.stage = 'uploaded';
          target.remote = { imageId: remote.imageId, bytes: remote.bytes, sha256: remote.sha256 };
          target.lastError = undefined;
        });
      } catch (error) {
        await this.#mutate(reportId, draft => {
          const target = draft.images[index];
          target.attempts += 1;
          target.lastError = classifyError(error);
        });
        throw error;
      }
    }
  }

  async #commit(reportId: string, signal: AbortSignal): Promise<void> {
    this.#assertRunning();
    const report = this.#reports.get(reportId);
    if (!report) return;
    if (!this.#online) throw new OfflineError();

    this.#setActive({
      reportId,
      imageId: null,
      phase: 'committing',
      fraction: null,
      imageIndex: report.images.length,
      imageCount: report.images.length,
    });

    const imageIds = report.images.map(image => image.remote?.imageId).filter((id): id is string => Boolean(id));

    const result = await this.#ports.transport.commitReport({
      idempotencyKey: report.id,
      description: report.description,
      imageIds,
      createdAt: report.createdAt,
      signal,
    });

    if (result.duplicate) {
      this.#ports.logger.info(`${reportId} was already committed — a previous response was lost, not the report`);
    }

    await this.#mutate(reportId, draft => {
      draft.stage = 'delivered';
      draft.deliveredAt = this.#ports.clock.now();
      draft.lastError = undefined;
      draft.nextAttemptAt = 0;
    });

    // The server holds the images now. Keep only the thumbnails so the local
    // history still renders without storing a second copy of everything.
    const delivered = this.#reports.get(reportId);
    for (const image of delivered?.images ?? []) {
      await this.#ports.imaging.discard(image.prepared?.uri);
    }
    this.#ports.logger.info(`delivered ${reportId}`);
  }

  async #recordFailure(reportId: string, error: unknown): Promise<void> {
    if (error instanceof AbortedError || !this.#running) {
      await this.#mutate(reportId, draft => {
        if (draft.stage === 'working') draft.stage = 'queued';
      });
      return;
    }

    const failure = classifyError(error);
    const now = this.#ports.clock.now();

    await this.#mutate(reportId, draft => {
      draft.lastError = failure;
      if (failure.kind === 'offline') {
        // Not a failure. No attempt spent, no backoff: the network listener
        // will wake us the moment there is something to try.
        draft.stage = 'queued';
        draft.nextAttemptAt = now;
        return;
      }
      if (failure.retryable) {
        draft.attempts += 1;
        const maxAttempts = this.#options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        if (draft.attempts >= maxAttempts) {
          draft.stage = 'blocked';
          draft.lastError = {
            ...failure,
            retryable: false,
            message: `Gave up after ${draft.attempts} attempts. Last problem: ${failure.message}`,
          };
          return;
        }
        draft.stage = 'queued';
        draft.nextAttemptAt = now + backoffMs(draft.attempts, this.#options.backoff);
        return;
      }
      draft.stage = 'blocked';
    });

    if (failure.kind !== 'offline') {
      this.#ports.logger.warn(`${reportId}: ${failure.message}`, failure);
    }
  }

  #assertRunning(): void {
    if (!this.#running) throw new AbortedError();
  }

  // ---------------------------------------------------------------------
  // Parking and waking
  // ---------------------------------------------------------------------

  #park(ms: number | null): Promise<void> {
    if (!this.#running) return Promise.resolve();
    return new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.#sleepTimer) {
          clearTimeout(this.#sleepTimer);
          this.#sleepTimer = null;
        }
        this.#wake = null;
        resolve();
      };
      this.#wake = finish;
      if (ms !== null) this.#sleepTimer = setTimeout(finish, ms);
    });
  }

  #wakeNow(): void {
    this.#wake?.();
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  /** All writes go through one chain so concurrent callers cannot clobber. */
  #mutate(reportId: string, mutator: Mutator): Promise<void> {
    this.#writeChain = this.#writeChain.then(async () => {
      const current = this.#reports.get(reportId);
      if (!current) return;
      const draft: ReportRecord = {
        ...current,
        images: current.images.map(image => ({ ...image })),
      };
      mutator(draft);
      draft.updatedAt = this.#ports.clock.now();
      await this.#write(draft);
    });
    return this.#writeChain as Promise<void>;
  }

  async #write(report: ReportRecord): Promise<void> {
    await this.#ports.store.put(report);
    this.#reports.set(report.id, report);
    this.#emit();
  }

  #setActive(active: ActiveWork | null): void {
    this.#active = active;
    this.#emit();
  }

  #reportProgress(sent: number, total: number): void {
    if (!this.#active) return;
    this.#active = { ...this.#active, fraction: total > 0 ? Math.min(1, sent / total) : null };
    const now = Date.now();
    if (now - this.#lastProgressEmit < PROGRESS_EMIT_INTERVAL_MS) return;
    this.#lastProgressEmit = now;
    this.#emit();
  }

  #emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#ports.logger.error('queue listener threw', error);
      }
    }
  }
}
