import { describeImage, describeReport, formatBytes, formatCountdown, summarise } from '../selectors';
import type { ActiveWork, ImageRecord, ReportRecord, ReportStage } from '../types';

const image = (over: Partial<ImageRecord> = {}): ImageRecord => ({
  id: 'img_1',
  stage: 'prepared',
  source: { uri: 'file:///src.jpg', bytes: 18_000_000, width: 4032, height: 3024 },
  prepared: { uri: 'file:///out.jpg', bytes: 1_400_000, width: 2560, height: 1920 },
  attempts: 0,
  ...over,
});

const report = (stage: ReportStage, over: Partial<ReportRecord> = {}): ReportRecord => ({
  id: 'rep_1',
  description: 'Cracked handrail',
  images: [image()],
  stage,
  createdAt: 1000,
  updatedAt: 1000,
  attempts: 0,
  nextAttemptAt: 0,
  ...over,
});

const NOW = 1_000_000;

/**
 * "'Saved' and 'uploaded' are different facts and must never share a sentence."
 *
 * Asserted rather than trusted: this is the kind of rule that degrades one
 * well-meaning string at a time.
 */
describe('status vocabulary never overstates delivery', () => {
  const DELIVERY_WORDS = /\b(sent|uploaded|delivered|submitted|on the server|complete)\b/i;

  const everyNonDeliveredState: [string, ReportRecord, ActiveWork | null, boolean][] = [
    ['queued offline', report('queued'), null, false],
    ['queued online', report('queued'), null, true],
    ['backing off', report('queued', { nextAttemptAt: NOW + 30_000, attempts: 2 }), null, true],
    [
      'blocked',
      report('blocked', {
        lastError: { kind: 'rejected', retryable: false, message: 'The server refused this report.', at: 0 },
      }),
      null,
      true,
    ],
    [
      'preparing',
      report('working'),
      { reportId: 'rep_1', imageId: 'img_1', phase: 'preparing', fraction: null, imageIndex: 0, imageCount: 3 },
      true,
    ],
    [
      'uploading',
      report('working'),
      { reportId: 'rep_1', imageId: 'img_1', phase: 'uploading', fraction: 0.5, imageIndex: 1, imageCount: 3 },
      true,
    ],
    [
      'committing',
      report('working'),
      { reportId: 'rep_1', imageId: null, phase: 'committing', fraction: null, imageIndex: 3, imageCount: 3 },
      true,
    ],
  ];

  it.each(everyNonDeliveredState)('%s never claims the server has it', (_name, record, active, online) => {
    const view = describeReport(record, active, online, NOW);
    expect(view.onServer).toBe(false);
    expect(view.label).not.toMatch(DELIVERY_WORDS);
  });

  it('only a delivered report says so', () => {
    const view = describeReport(report('delivered', { deliveredAt: NOW }), null, true, NOW);
    expect(view.onServer).toBe(true);
    expect(view.label).toBe('On the server');
    expect(view.tone).toBe('good');
  });

  it('an in-flight upload says plainly that it is not there yet', () => {
    const view = describeReport(
      report('working'),
      { reportId: 'rep_1', imageId: 'img_1', phase: 'uploading', fraction: 0.5, imageIndex: 0, imageCount: 2 },
      true,
      NOW,
    );
    expect(view.detail).toContain('Not on the server yet');
    expect(view.progress).toBe(0.5);
  });
});

describe('every failure state says what happens next', () => {
  it('offline reassures rather than alarms', () => {
    const view = describeReport(report('queued'), null, false, NOW);
    expect(view.label).toBe('Saved on device');
    expect(view.detail).toContain('nothing is lost');
    expect(view.tone).toBe('neutral');
  });

  it('a backoff shows the reason and the countdown, not a bare spinner', () => {
    const view = describeReport(
      report('queued', {
        nextAttemptAt: NOW + 95_000,
        attempts: 3,
        lastError: { kind: 'server', retryable: true, message: 'The server failed (500). Will retry.', at: 0 },
      }),
      null,
      true,
      NOW,
    );
    expect(view.detail).toContain('The server failed (500)');
    expect(view.detail).toContain('1m 35s');
    expect(view.tone).toBe('warn');
  });

  it('a blocked report surfaces the real reason', () => {
    const view = describeReport(
      report('blocked', {
        lastError: { kind: 'tooLarge', retryable: false, message: 'The server rejected this image as too large.', at: 0 },
      }),
      null,
      true,
      NOW,
    );
    expect(view.detail).toContain('too large');
    expect(view.tone).toBe('bad');
  });

  it('credits partial progress so a bad link does not look like no progress', () => {
    const record = report('queued', {
      images: [image({ id: 'a', stage: 'uploaded' }), image({ id: 'b' }), image({ id: 'c' })],
      nextAttemptAt: NOW + 5_000,
    });
    expect(describeReport(record, null, true, NOW).detail).toContain('1 of 3 photos are already up');
  });
});

describe('summary line', () => {
  it('leads with the outstanding count when work is pending', () => {
    expect(summarise([report('queued'), report('delivered')], true).headline).toBe('1 report on the way');
  });

  it('says so plainly when offline', () => {
    expect(summarise([report('queued'), report('queued')], false).headline).toContain('offline');
  });

  it('confirms when everything has landed', () => {
    expect(summarise([report('delivered'), report('delivered')], true).headline).toBe('All 2 reports on the server');
  });

  it('surfaces blocked work above silence', () => {
    expect(summarise([report('blocked')], true).headline).toBe('1 report needs you');
  });
});

describe('per-image status', () => {
  it('distinguishes ready-to-send from actually sent', () => {
    expect(describeImage(image({ stage: 'prepared' }), null).onServer).toBe(false);
    expect(describeImage(image({ stage: 'prepared' }), null).label).toBe('Ready to send');
    expect(describeImage(image({ stage: 'uploaded' }), null).onServer).toBe(true);
  });
});

describe('formatting', () => {
  it('formats byte sizes the way a person reads them', () => {
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('formats countdowns', () => {
    expect(formatCountdown(1)).toBe('a moment');
    expect(formatCountdown(45)).toBe('45s');
    expect(formatCountdown(95)).toBe('1m 35s');
  });
});
