import type { ActiveWork, ImageRecord, ReportRecord } from './types';

export type Tone = 'neutral' | 'progress' | 'good' | 'warn' | 'bad';

export interface StatusView {
  /** Short, for a pill. */
  label: string;
  /** One line, written for the user, explaining what that means for them. */
  detail: string;
  tone: Tone;
  /**
   * True only when the server has confirmed the report. Nothing else in this
   * file may set it, and nothing in the UI may imply delivery without it.
   */
  onServer: boolean;
  /** 0..1 while bytes are moving, otherwise null. */
  progress: number | null;
}

/**
 * The single source of every status word the user sees.
 *
 * The brief's rule is that "saved" and "uploaded" are different facts and must
 * never share a sentence. That is easy to agree with and easy to violate by
 * accident, one well-meaning string at a time, scattered across five screens.
 * Keeping the vocabulary in one pure function makes the rule enforceable --
 * selectors.test.ts asserts that nothing but a confirmed report can use the
 * language of delivery.
 */
export function describeReport(
  report: ReportRecord,
  active: ActiveWork | null,
  online: boolean,
  now: number,
): StatusView {
  if (report.stage === 'delivered') {
    return {
      label: 'On the server',
      detail: 'Confirmed received. Safe to clear.',
      tone: 'good',
      onServer: true,
      progress: 1,
    };
  }

  if (report.stage === 'blocked') {
    return {
      label: 'Needs you',
      detail: report.lastError?.message ?? 'This report could not be sent.',
      tone: 'bad',
      onServer: false,
      progress: null,
    };
  }

  const mine = active && active.reportId === report.id ? active : null;

  if (report.stage === 'working' && mine) {
    if (mine.phase === 'preparing') {
      return {
        label: 'Preparing',
        detail: `Compressing photo ${mine.imageIndex + 1} of ${mine.imageCount}. Saved on this device.`,
        tone: 'progress',
        onServer: false,
        progress: null,
      };
    }
    if (mine.phase === 'uploading') {
      const percent = mine.fraction != null ? ` · ${Math.round(mine.fraction * 100)}%` : '';
      return {
        label: `Sending ${mine.imageIndex + 1} of ${mine.imageCount}`,
        detail: `Uploading${percent}. Not on the server yet.`,
        tone: 'progress',
        onServer: false,
        progress: mine.fraction,
      };
    }
    return {
      label: 'Finishing',
      detail: 'All photos uploaded, filing the report.',
      tone: 'progress',
      onServer: false,
      progress: null,
    };
  }

  const uploaded = report.images.filter(image => image.stage === 'uploaded').length;
  const partial = uploaded > 0 ? ` ${uploaded} of ${report.images.length} photos are already up.` : '';

  if (!online) {
    return {
      label: 'Saved on device',
      detail: `No connection. This will send itself when there is one — nothing is lost.${partial}`,
      tone: 'neutral',
      onServer: false,
      progress: null,
    };
  }

  if (report.nextAttemptAt > now) {
    const seconds = Math.ceil((report.nextAttemptAt - now) / 1000);
    const reason = report.lastError?.message ?? 'The last attempt did not get through.';
    return {
      label: 'Retrying',
      detail: `${reason} Next try in ${formatCountdown(seconds)}.${partial}`,
      tone: 'warn',
      onServer: false,
      progress: null,
    };
  }

  return {
    label: 'Waiting to send',
    detail: `In the queue.${partial}`,
    tone: 'neutral',
    onServer: false,
    progress: null,
  };
}

export interface ImageStatusView {
  label: string;
  tone: Tone;
  onServer: boolean;
}

export function describeImage(image: ImageRecord, active: ActiveWork | null): ImageStatusView {
  if (image.stage === 'uploaded') return { label: 'On the server', tone: 'good', onServer: true };
  if (image.lastError && !image.lastError.retryable) return { label: image.lastError.message, tone: 'bad', onServer: false };
  if (active?.imageId === image.id && active.phase === 'uploading') {
    const percent = active.fraction != null ? `${Math.round(active.fraction * 100)}%` : '';
    return { label: `Sending ${percent}`.trim(), tone: 'progress', onServer: false };
  }
  if (active?.imageId === image.id && active.phase === 'preparing') {
    return { label: 'Compressing', tone: 'progress', onServer: false };
  }
  if (image.stage === 'prepared') return { label: 'Ready to send', tone: 'neutral', onServer: false };
  return { label: 'Saved on device', tone: 'neutral', onServer: false };
}

export interface QueueSummary {
  total: number;
  outstanding: number;
  delivered: number;
  blocked: number;
  /** One line for the top of the screen: the "one glance, one answer". */
  headline: string;
}

export function summarise(reports: ReportRecord[], online: boolean): QueueSummary {
  const delivered = reports.filter(report => report.stage === 'delivered').length;
  const blocked = reports.filter(report => report.stage === 'blocked').length;
  const outstanding = reports.filter(report => report.stage === 'queued' || report.stage === 'working').length;

  let headline: string;
  if (reports.length === 0) headline = 'No reports yet';
  else if (blocked > 0 && outstanding === 0) headline = `${blocked} report${plural(blocked)} need${blocked === 1 ? 's' : ''} you`;
  else if (outstanding === 0) headline = `All ${delivered} report${plural(delivered)} on the server`;
  else if (!online) headline = `${outstanding} saved on this device · offline`;
  else headline = `${outstanding} report${plural(outstanding)} on the way`;

  return { total: reports.length, outstanding, delivered, blocked, headline };
}

const plural = (n: number) => (n === 1 ? '' : 's');

export function formatCountdown(totalSeconds: number): string {
  if (totalSeconds <= 1) return 'a moment';
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
