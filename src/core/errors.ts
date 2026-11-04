import type { FailureInfo, FailureKind } from './types';

/** Thrown when the network disappeared. Never counts as a failed attempt. */
export class OfflineError extends Error {
  constructor() {
    super('offline');
    this.name = 'OfflineError';
  }
}

/** Thrown when an upload made no progress for too long. */
export class StalledError extends Error {
  readonly idleMs: number;

  constructor(idleMs: number) {
    super(`no progress for ${idleMs}ms`);
    this.name = 'StalledError';
    this.idleMs = idleMs;
  }
}

/** Thrown when the queue is shutting down; not a failure. */
export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class ImagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImagingError';
  }
}

const info = (
  kind: FailureKind,
  retryable: boolean,
  message: string,
  extra: Partial<FailureInfo> = {},
): FailureInfo => ({ kind, retryable, message, at: Date.now(), ...extra });

/**
 * Decide whether a failure is worth retrying.
 *
 * The brief tests this directly: "make the backend return errors, refuse
 * uploads, and hang without answering -- and check that only the right ones
 * are retried."
 *
 * The rule: retry anything that a later attempt could plausibly fix (the link,
 * the server, a race). Never retry a verdict about the payload itself -- the
 * same bytes will be refused forever, and a queue that keeps trying is a queue
 * that never drains and a battery that never recovers.
 */
export function classifyHttpStatus(status: number, code?: string, serverMessage?: string): FailureInfo {
  if (status === 413) {
    return info('tooLarge', false, 'The server rejected this image as too large. The app should have compressed it below the limit — this is a bug worth reporting.', { status, code });
  }
  if (status === 408 || status === 425 || status === 429) {
    return info('server', true, 'The server asked us to slow down. Will retry.', { status, code });
  }
  if (status === 409) {
    // Our own two-phase flow: the commit arrived before an upload was visible.
    return info('server', true, 'The server has not registered every image yet. Will retry.', { status, code });
  }
  if (status >= 500) {
    return info('server', true, `The server failed (${status}). Will retry.`, { status, code });
  }
  if (status >= 400) {
    return info(
      'rejected',
      false,
      serverMessage?.trim()
        ? `The server refused this report: ${serverMessage.trim()}`
        : `The server refused this report (${status}). Retrying will not change that.`,
      { status, code },
    );
  }
  return info('unknown', true, `Unexpected response status ${status}.`, { status, code });
}

/** Map any thrown value onto the decision the queue needs. */
export function classifyError(error: unknown): FailureInfo {
  if (error instanceof OfflineError) {
    return info('offline', true, 'Waiting for a connection.');
  }
  if (error instanceof StalledError) {
    return info('timeout', true, 'The connection stopped responding. Will retry.');
  }
  if (error instanceof HttpError) {
    return classifyHttpStatus(error.status, error.code, error.message);
  }
  if (error instanceof NetworkError) {
    return info('network', true, 'Could not reach the server. Will retry.');
  }
  if (error instanceof ImagingError) {
    return info('imaging', false, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return info('unknown', true, `Unexpected problem: ${message}`);
}

/** The draft does not satisfy the rules in LIMITS. Never reaches the queue. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
