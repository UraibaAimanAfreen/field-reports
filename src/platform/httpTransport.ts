import { AbortedError, HttpError, NetworkError, StalledError } from '../core/errors';
import { MIME_JPEG } from '../core/limits';
import type { CommitArgs, RemoteImage, Transport, UploadArgs } from '../core/ports';
import type { ServerReport } from '../core/types';

/**
 * Abort an upload that has made no *progress* for this long.
 *
 * Deliberately not a total timeout. "2G is normal. Slow is fine, stopped is
 * not" — a 1.4 MB image on a 20 kbps link legitimately takes ten minutes, and
 * any total timeout short enough to catch a dead connection would also kill
 * that upload every single time. An idle timer distinguishes the two: bytes
 * still moving means keep going, however slowly.
 */
const UPLOAD_IDLE_TIMEOUT_MS = 45_000;

/** Small JSON calls, where a total timeout is the right instrument. */
const JSON_TIMEOUT_MS = 30_000;

export class HttpTransport implements Transport {
  readonly #baseUrl: () => string;

  constructor(baseUrl: () => string) {
    this.#baseUrl = baseUrl;
  }

  private baseUrl(): string {
    return this.#baseUrl();
  }

  /**
   * One image, one request, keyed by the image's own id.
   *
   * Uses XMLHttpRequest rather than fetch because React Native only exposes
   * upload progress there, and without progress there is no way to tell a
   * slow link from a dead one — see UPLOAD_IDLE_TIMEOUT_MS. FormData streams
   * the file from disk natively, so a 5 MB upload never passes through JS
   * memory.
   */
  uploadImage(args: UploadArgs): Promise<RemoteImage> {
    return new Promise<RemoteImage>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let lastProgressAt = Date.now();
      let settled = false;
      let abortReason: 'caller' | 'stalled' | null = null;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        args.signal.removeEventListener('abort', onCallerAbort);
        fn();
      };

      const watchdog = setInterval(() => {
        if (Date.now() - lastProgressAt < UPLOAD_IDLE_TIMEOUT_MS) return;
        abortReason = 'stalled';
        xhr.abort();
      }, 5_000);

      const onCallerAbort = () => {
        abortReason = 'caller';
        xhr.abort();
      };
      args.signal.addEventListener('abort', onCallerAbort);

      const form = new FormData();
      form.append('file', {
        uri: args.file.uri,
        type: MIME_JPEG,
        name: `${args.idempotencyKey}.jpg`,
      } as unknown as Blob);

      xhr.open('POST', `${this.baseUrl()}/v1/uploads`);
      // The id was minted and persisted before the first attempt, so every
      // replay of this upload carries the same key and the server can tell
      // it is the same work.
      xhr.setRequestHeader('Idempotency-Key', args.idempotencyKey);
      // Lets the server detect a truncated body instead of storing one.
      xhr.setRequestHeader('X-Expected-Bytes', String(args.file.bytes));
      xhr.setRequestHeader('X-Report-Id', args.reportId);
      xhr.setRequestHeader('Accept', 'application/json');

      xhr.upload.onprogress = event => {
        lastProgressAt = Date.now();
        args.onProgress(event.loaded, event.total || args.file.bytes);
      };

      xhr.onload = () =>
        finish(() => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const body = JSON.parse(xhr.responseText) as RemoteImage;
              args.onProgress(args.file.bytes, args.file.bytes);
              resolve({
                imageId: body.imageId,
                bytes: body.bytes,
                sha256: body.sha256,
                duplicate: Boolean(body.duplicate),
              });
            } catch {
              reject(new NetworkError('The server sent a response we could not read.'));
            }
            return;
          }
          reject(httpErrorFrom(xhr.status, xhr.responseText));
        });

      xhr.onerror = () => finish(() => reject(new NetworkError('Could not reach the server.')));

      xhr.onabort = () =>
        finish(() => {
          if (abortReason === 'stalled') return reject(new StalledError(UPLOAD_IDLE_TIMEOUT_MS));
          reject(new AbortedError());
        });

      // No xhr.timeout on purpose: see UPLOAD_IDLE_TIMEOUT_MS.
      xhr.send(form);
    });
  }

  async commitReport(args: CommitArgs): Promise<{ id: string; duplicate: boolean }> {
    const body = await this.#json<{ report: { id: string }; duplicate?: boolean }>(
      '/v1/reports',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'Idempotency-Key': args.idempotencyKey,
        },
        body: JSON.stringify({
          id: args.idempotencyKey,
          description: args.description,
          imageIds: args.imageIds,
          createdAt: args.createdAt,
        }),
      },
      args.signal,
    );
    return { id: body.report.id, duplicate: Boolean(body.duplicate) };
  }

  async listReports(signal?: AbortSignal): Promise<ServerReport[]> {
    const body = await this.#json<{ reports: ServerReport[] }>('/v1/reports', { method: 'GET' }, signal);
    return body.reports;
  }

  async wipeServer(): Promise<void> {
    await this.#json('/v1/reports', { method: 'DELETE' });
  }

  /** Absolute URL for an image the server holds, for <Image> on the Server tab. */
  imageUrl(path: string): string {
    return `${this.baseUrl()}${path}`;
  }

  async #json<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JSON_TIMEOUT_MS);
    const forward = () => controller.abort();
    signal?.addEventListener('abort', forward);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      if (signal?.aborted) throw new AbortedError();
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkError(`Could not reach the server (${message}).`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    }

    const text = await response.text();
    if (!response.ok) throw httpErrorFrom(response.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

function httpErrorFrom(status: number, text: string): HttpError {
  let code: string | undefined;
  let message = `The server responded with ${status}.`;
  try {
    const body = JSON.parse(text) as { error?: { code?: string; message?: string } };
    code = body.error?.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // Non-JSON error body; the status is all we have.
  }
  return new HttpError(status, code, message);
}
