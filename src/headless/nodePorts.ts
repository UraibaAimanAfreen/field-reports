import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AbortedError, HttpError, ImagingError, NetworkError } from '../core/errors';
import { LIMITS } from '../core/limits';
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
} from '../core/ports';
import type { ImageFile, ReportRecord, ServerReport } from '../core/types';

const toPath = (uri: string) => uri.replace(/^file:\/\//, '');
const toUri = (p: string) => `file://${p}`;

export const nodeClock: Clock = {
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

export function consoleLogger(verbose: boolean): Logger {
  const at = () => new Date().toISOString().slice(11, 19);
  return {
    debug: message => verbose && console.log(`  ${at()} ${message}`),
    info: message => console.log(`  ${at()} ${message}`),
    warn: message => console.log(`  ${at()} ! ${message}`),
    error: message => console.error(`  ${at()} x ${message}`),
  };
}

/**
 * Records on disk, one JSON file each, written tmp-then-rename.
 *
 * Deliberately durable rather than in-memory: it lets you kill the harness
 * with ^C mid-upload and run it again to watch the queue resume — the same
 * property the app relies on after a force-quit, demonstrated without a phone.
 */
export class FileReportStore implements ReportStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true });
  }

  async all(): Promise<ReportRecord[]> {
    const names = await fs.readdir(this.#dir).catch(() => [] as string[]);
    const records: ReportRecord[] = [];
    for (const name of names.filter(n => n.endsWith('.json'))) {
      try {
        records.push(JSON.parse(await fs.readFile(path.join(this.#dir, name), 'utf8')) as ReportRecord);
      } catch {
        // Ignore an unreadable row rather than refusing to start.
      }
    }
    return records;
  }

  async get(id: string): Promise<ReportRecord | null> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.#dir, `${id}.json`), 'utf8')) as ReportRecord;
    } catch {
      return null;
    }
  }

  async put(record: ReportRecord): Promise<void> {
    const target = path.join(this.#dir, `${record.id}.json`);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(record, null, 2));
    await fs.rename(tmp, target);
  }

  async remove(id: string): Promise<void> {
    await fs.rm(path.join(this.#dir, `${id}.json`), { force: true });
  }
}

/** A 1x1 JPEG. Padding is appended after EOI, which decoders ignore. */
const JPEG_SEED = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

/** Write a real, decodable JPEG of approximately `bytes`. */
export async function writeFakePhoto(target: string, bytes: number): Promise<ImageFile> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const padding = Math.max(0, bytes - JPEG_SEED.length);
  await fs.writeFile(target, Buffer.concat([JPEG_SEED, randomBytes(padding)]));
  const stat = await fs.stat(target);
  return { uri: toUri(target), bytes: stat.size, width: 4032, height: 3024 };
}

/**
 * Stands in for the native resizer.
 *
 * It cannot actually re-encode a JPEG in plain Node, so it models the one
 * property the queue depends on: preparation produces a smaller file that is
 * under the ceiling, at a path we control. The real compression ladder is in
 * src/platform/imageProcessor.ts and is exercised on the device.
 */
export class NodeImaging implements Imaging {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async prepare(reportId: string, imageId: string, source: ImageFile): Promise<PreparedImage> {
    const dir = path.join(this.#root, reportId);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `out_${imageId}.jpg`);

    if (!(await exists(toPath(source.uri)))) {
      throw new ImagingError('The source photo is gone.');
    }

    const passthrough = source.bytes <= LIMITS.maxImageBytes;
    const targetBytes = passthrough ? source.bytes : Math.round(LIMITS.maxImageBytes * 0.28);
    await writeFakePhoto(target, targetBytes);
    const stat = await fs.stat(target);

    return {
      uri: toUri(target),
      bytes: stat.size,
      width: passthrough ? source.width : 2560,
      height: passthrough ? source.height : 1920,
      passthrough,
      quality: passthrough ? null : 76,
    };
  }

  async thumbnail(reportId: string, imageId: string): Promise<string | null> {
    const target = path.join(this.#root, reportId, `thumb_${imageId}.jpg`);
    await writeFakePhoto(target, 8_000);
    return toUri(target);
  }

  async discard(uri: string | undefined): Promise<void> {
    if (uri) await fs.rm(toPath(uri), { force: true });
  }

  async discardReport(reportId: string): Promise<void> {
    await fs.rm(path.join(this.#root, reportId), { recursive: true, force: true });
  }

  async sweepOrphans(liveReportIds: string[]): Promise<number> {
    const live = new Set(liveReportIds);
    const names = await fs.readdir(this.#root).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      if (live.has(name)) continue;
      await fs.rm(path.join(this.#root, name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}

export class NodeNetwork implements NetworkMonitor {
  #online = true;
  readonly #listeners = new Set<(online: boolean) => void>();

  isOnline(): boolean {
    return this.#online;
  }

  subscribe(listener: (online: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setOnline(online: boolean): void {
    if (online === this.#online) return;
    this.#online = online;
    for (const listener of this.#listeners) listener(online);
  }
}

/**
 * The same wire contract as the app's transport, over Node's fetch.
 *
 * It is a second implementation rather than the app's: src/platform's
 * transport is built on XMLHttpRequest for upload progress, which does not
 * exist here. The queue — the part under test — is the real one.
 */
export class NodeTransport implements Transport {
  readonly #baseUrl: string;
  readonly #responseTimeoutMs: number;

  constructor(baseUrl: string, responseTimeoutMs = 30_000) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#responseTimeoutMs = responseTimeoutMs;
  }

  async uploadImage(args: UploadArgs): Promise<RemoteImage> {
    const bytes = await fs.readFile(toPath(args.file.uri));
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), `${args.idempotencyKey}.jpg`);

    args.onProgress(0, bytes.length);
    const response = await this.#send('/v1/uploads', {
      method: 'POST',
      headers: {
        'Idempotency-Key': args.idempotencyKey,
        'X-Expected-Bytes': String(args.file.bytes),
        'X-Report-Id': args.reportId,
      },
      body: form,
      signal: args.signal,
    });
    args.onProgress(bytes.length, bytes.length);

    const body = (await this.#body(response)) as RemoteImage;
    return { imageId: body.imageId, bytes: body.bytes, sha256: body.sha256, duplicate: Boolean(body.duplicate) };
  }

  async commitReport(args: CommitArgs): Promise<{ id: string; duplicate: boolean }> {
    const response = await this.#send('/v1/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': args.idempotencyKey },
      body: JSON.stringify({
        id: args.idempotencyKey,
        description: args.description,
        imageIds: args.imageIds,
        createdAt: args.createdAt,
      }),
      signal: args.signal,
    });
    const body = (await this.#body(response)) as { report: { id: string }; duplicate?: boolean };
    return { id: body.report.id, duplicate: Boolean(body.duplicate) };
  }

  async listReports(signal?: AbortSignal): Promise<ServerReport[]> {
    const response = await this.#send('/v1/reports', { method: 'GET', signal });
    const body = (await this.#body(response)) as { reports: ServerReport[] };
    return body.reports;
  }

  async wipeServer(): Promise<void> {
    await this.#send('/v1/reports', { method: 'DELETE' });
  }

  /**
   * A total response timeout.
   *
   * The server's `hang` mode accepts a body and then never answers; without a
   * deadline, fetch waits forever and the queue is wedged on a request that
   * will never complete. The app does better than this -- it watches upload
   * *progress* and only gives up when the bytes stop moving, so a genuinely
   * slow link is never cut off (see UPLOAD_IDLE_TIMEOUT_MS in the app's
   * transport). Node's fetch exposes no upload progress, so the harness
   * settles for a total deadline.
   *
   * Either way the timeout is safe: the retry carries the same
   * Idempotency-Key, so if the server did store the upload before going
   * quiet, the second attempt returns the original instead of a duplicate.
   */
  async #send(route: string, init: RequestInit): Promise<Response> {
    const caller = init.signal as AbortSignal | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#responseTimeoutMs);
    const forward = () => controller.abort();
    caller?.addEventListener('abort', forward);

    try {
      return await fetch(`${this.#baseUrl}${route}`, { ...init, signal: controller.signal });
    } catch (error) {
      if (caller?.aborted) throw new AbortedError();
      if (controller.signal.aborted) {
        throw new NetworkError(`The server did not answer within ${this.#responseTimeoutMs / 1000}s.`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkError(`Could not reach the server (${message}).`);
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', forward);
    }
  }

  async #body(response: Response): Promise<unknown> {
    const text = await response.text();
    if (response.ok) return text ? JSON.parse(text) : {};

    let code: string | undefined;
    let message = `The server responded with ${response.status}.`;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      code = parsed.error?.code;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // keep the status-only message
    }
    throw new HttpError(response.status, code, message);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
