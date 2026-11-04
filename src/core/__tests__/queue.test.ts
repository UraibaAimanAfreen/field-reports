import { UploadQueue } from '../queue';
import { ValidationError } from '../errors';
import type { QueuePorts } from '../ports';
import type { DraftImage, ReportRecord } from '../types';
import {
  FakeImaging,
  FakeNetwork,
  FakeServer,
  FakeTransport,
  MemoryStore,
  realClock,
  refusal,
  serverFailure,
  silentLogger,
  tooLarge,
  transientFailure,
  waitFor,
} from './fakes';

/** Tiny backoff so retries happen in milliseconds instead of minutes. */
const FAST_BACKOFF = { baseMs: 4, capMs: 20, random: () => 0.5 };

const photo = (bytes = 18_000_000): DraftImage => ({
  uri: `file:///camera/${Math.random().toString(36).slice(2)}.jpg`,
  bytes,
  width: 4032,
  height: 3024,
});

interface Harness {
  queue: UploadQueue;
  ports: QueuePorts;
  store: MemoryStore;
  transport: FakeTransport;
  imaging: FakeImaging;
  network: FakeNetwork;
  reportById: (id: string) => ReportRecord | undefined;
}

function harness(options: { online?: boolean; store?: MemoryStore; server?: FakeServer } = {}): Harness {
  const store = options.store ?? new MemoryStore();
  const transport = new FakeTransport(options.server);
  const imaging = new FakeImaging();
  const network = new FakeNetwork(options.online ?? true);
  const ports: QueuePorts = { store, transport, imaging, network, clock: realClock, logger: silentLogger };
  const queue = new UploadQueue(ports, { backoff: FAST_BACKOFF });
  return {
    queue,
    ports,
    store,
    transport,
    imaging,
    network,
    reportById: id => queue.getSnapshot().reports.find(report => report.id === id),
  };
}

const submit = (queue: UploadQueue, description: string, count = 1) =>
  queue.enqueue({
    description,
    images: Array.from({ length: count }, () => UploadQueue.rawImage(photo())),
  });

describe('UploadQueue — the delivery guarantee', () => {
  let active: UploadQueue[] = [];

  const track = <T extends UploadQueue>(queue: T): T => {
    active.push(queue);
    return queue;
  };

  afterEach(async () => {
    for (const queue of active) await queue.stop();
    active = [];
  });

  it('delivers a report and leaves exactly one copy on the server', async () => {
    const h = harness();
    track(h.queue);
    await h.queue.start();

    const report = await submit(h.queue, 'Cracked handrail, stairwell B', 3);
    await waitFor(() => h.reportById(report.id)?.stage === 'delivered', { label: 'delivery' });

    expect(h.transport.storedReports.size).toBe(1);
    expect(h.transport.storedImages.size).toBe(3);
    expect(h.transport.storedReports.get(report.id)?.description).toBe('Cracked handrail, stairwell B');
  });

  it('is durable before enqueue resolves, so a kill right after submitting loses nothing', async () => {
    const h = harness({ online: false });
    track(h.queue);
    await h.queue.start();

    const report = await submit(h.queue, 'Written to disk before we return');

    // No waiting, no draining: the moment enqueue resolved it was already persisted.
    expect(h.store.rows.has(report.id)).toBe(true);
    const persisted = await h.store.get(report.id);
    expect(persisted?.description).toBe('Written to disk before we return');
  });

  it('retries a transient server fault and still delivers once', async () => {
    const h = harness();
    track(h.queue);
    h.transport.uploadScript = [{ type: 'throw', error: serverFailure() }, { type: 'throw', error: transientFailure() }];
    await h.queue.start();

    const report = await submit(h.queue, 'Two failures then success');
    await waitFor(() => h.reportById(report.id)?.stage === 'delivered', { label: 'delivery after retries' });

    expect(h.transport.uploadCalls.length).toBe(3);
    expect(h.transport.storedImages.size).toBe(1);
    expect(h.reportById(report.id)?.attempts).toBe(2);
  });

  it('does NOT retry a refusal — it blocks and says why', async () => {
    const h = harness();
    track(h.queue);
    h.transport.uploadScript = [{ type: 'throw', error: refusal() }];
    await h.queue.start();

    const report = await submit(h.queue, 'Permanently refused');
    await waitFor(() => h.reportById(report.id)?.stage === 'blocked', { label: 'blocked' });

    // Give the worker ample opportunity to do the wrong thing.
    await new Promise<void>(resolve => setTimeout(() => resolve(), 120));

    expect(h.transport.uploadCalls.length).toBe(1);
    expect(h.reportById(report.id)?.stage).toBe('blocked');
    expect(h.reportById(report.id)?.lastError?.retryable).toBe(false);
    expect(h.reportById(report.id)?.lastError?.kind).toBe('rejected');
  });

  it('treats 413 as our own bug, not something to retry', async () => {
    const h = harness();
    track(h.queue);
    h.transport.uploadScript = [{ type: 'throw', error: tooLarge() }];
    await h.queue.start();

    const report = await submit(h.queue, 'Over the ceiling');
    await waitFor(() => h.reportById(report.id)?.stage === 'blocked', { label: 'blocked on 413' });

    expect(h.reportById(report.id)?.lastError?.kind).toBe('tooLarge');
    expect(h.transport.uploadCalls.length).toBe(1);
  });

  it('survives a lost response without storing the image twice', async () => {
    const h = harness();
    track(h.queue);
    // The server stored it. The answer never arrived. This is the case that
    // breaks naive queues: the client cannot tell success from failure.
    h.transport.uploadScript = [{ type: 'storeThenThrow', error: transientFailure() }];
    await h.queue.start();

    const report = await submit(h.queue, 'Response lost in flight');
    await waitFor(() => h.reportById(report.id)?.stage === 'delivered', { label: 'recovery from lost response' });

    expect(h.transport.uploadCalls.length).toBe(2); // it did retry
    expect(h.transport.storedImages.size).toBe(1); // but stored once
  });

  it('survives a lost response on the report commit too', async () => {
    const h = harness();
    track(h.queue);
    h.transport.commitScript = [{ type: 'storeThenThrow', error: transientFailure() }];
    await h.queue.start();

    const report = await submit(h.queue, 'Commit acknowledged but unheard');
    await waitFor(() => h.reportById(report.id)?.stage === 'delivered', { label: 'commit recovery' });

    expect(h.transport.commitCalls.length).toBe(2);
    expect(h.transport.storedReports.size).toBe(1);
  });

  it('resumes after a force-quit and still delivers exactly once', async () => {
    // The disk and the server survive; the process does not.
    const store = new MemoryStore();
    const server = new FakeServer();

    const first = harness({ store, server });
    track(first.queue);
    // Never resolves: the upload is genuinely in flight when we pull the plug.
    first.transport.hold = new Promise<void>(() => {});
    await first.queue.start();
    const report = await submit(first.queue, 'Killed mid-upload', 2);

    await waitFor(() => first.transport.uploadCalls.length >= 1, { label: 'an upload in flight' });
    await first.queue.stop(); // force-quit
    expect(server.images.size).toBe(0); // nothing landed before the kill

    // A new process against the same disk and the same server.
    const second = harness({ store, server });
    track(second.queue);
    await second.queue.start();

    await waitFor(() => second.reportById(report.id)?.stage === 'delivered', { label: 'resumed delivery' });
    expect(server.images.size).toBe(2);
    expect(server.reports.size).toBe(1);
  });

  it('requeues a record that was left mid-flight by a crash', async () => {
    const store = new MemoryStore();
    const crashed: ReportRecord = {
      id: 'rep_crashed',
      description: 'Interrupted',
      images: [
        {
          id: 'img_a',
          stage: 'prepared',
          source: { uri: 'file:///src.jpg', bytes: 9_000_000, width: 100, height: 100 },
          prepared: { uri: 'file:///out.jpg', bytes: 1_000_000, width: 100, height: 100 },
          attempts: 1,
        },
      ],
      stage: 'working', // what a kill leaves behind
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
      attempts: 1,
      nextAttemptAt: Date.now() + 10 * 60_000, // a backoff the user should not have to wait out
    };
    await store.put(crashed);

    const h = harness({ store });
    track(h.queue);
    await h.queue.start();

    await waitFor(() => h.reportById('rep_crashed')?.stage === 'delivered', { label: 'recovered delivery' });
    expect(h.transport.storedReports.size).toBe(1);
  });

  it('waits out an outage without burning attempts, then drains on reconnect', async () => {
    const h = harness({ online: false });
    track(h.queue);
    await h.queue.start();

    const report = await submit(h.queue, 'Composed in airplane mode', 2);

    // Compression is local work, so it happens offline: the bytes are ready
    // the instant a signal appears.
    await waitFor(() => h.reportById(report.id)?.images.every(image => image.stage === 'prepared') === true, {
      label: 'offline preparation',
    });
    expect(h.transport.uploadCalls.length).toBe(0);
    expect(h.reportById(report.id)?.attempts).toBe(0);

    h.network.setOnline(true);
    await waitFor(() => h.reportById(report.id)?.stage === 'delivered', { label: 'drain on reconnect' });
    expect(h.reportById(report.id)?.attempts).toBe(0); // the outage was never a failure
  });

  it('delivers the oldest report first', async () => {
    const h = harness();
    track(h.queue);
    await h.queue.start();

    const first = await submit(h.queue, 'first');
    await new Promise<void>(resolve => setTimeout(() => resolve(), 2));
    const second = await submit(h.queue, 'second');
    await new Promise<void>(resolve => setTimeout(() => resolve(), 2));
    const third = await submit(h.queue, 'third');

    await waitFor(() => h.transport.storedReports.size === 3, { label: 'all three delivered' });
    expect(h.transport.commitCalls).toEqual([first.id, second.id, third.id]);
  });

  it('keeps going after one report is permanently blocked', async () => {
    const h = harness();
    track(h.queue);
    h.transport.uploadScript = [{ type: 'throw', error: refusal() }];
    await h.queue.start();

    const doomed = await submit(h.queue, 'will be refused');
    await new Promise<void>(resolve => setTimeout(() => resolve(), 4));
    const fine = await submit(h.queue, 'should still get through');

    await waitFor(() => h.reportById(fine.id)?.stage === 'delivered', { label: 'second report delivered' });
    expect(h.reportById(doomed.id)?.stage).toBe('blocked');
  });

  it('frees the big files once the server has them, keeping thumbnails', async () => {
    const h = harness();
    track(h.queue);
    await h.queue.start();

    const report = await submit(h.queue, 'Storage should not grow forever', 2);
    await waitFor(() => h.reportById(report.id)?.stage === 'delivered', { label: 'delivery' });

    const images = h.reportById(report.id)?.images ?? [];
    for (const image of images) {
      expect(h.imaging.discarded).toContain(image.source.uri); // original released after compression
      expect(h.imaging.discarded).toContain(image.prepared?.uri); // upload copy released after delivery
      expect(image.thumbUri).toBeTruthy(); // the list still has something to draw
    }
  });

  it('retryNow clears the backoff on a blocked report', async () => {
    const h = harness();
    track(h.queue);
    h.transport.uploadScript = [{ type: 'throw', error: refusal() }];
    await h.queue.start();

    const report = await submit(h.queue, 'blocked then retried');
    await waitFor(() => h.reportById(report.id)?.stage === 'blocked', { label: 'blocked' });

    await h.queue.retryNow(report.id);
    await waitFor(() => h.reportById(report.id)?.stage === 'delivered', { label: 'delivered after manual retry' });
    expect(h.reportById(report.id)?.lastError).toBeUndefined();
  });

  it('blocks a report whose photo cannot be processed, and does not spin', async () => {
    const h = harness();
    track(h.queue);
    await h.queue.start();

    const image = UploadQueue.rawImage(photo());
    h.imaging.failFor = image.id;
    const report = await h.queue.enqueue({ description: 'corrupt photo', images: [image] });

    await waitFor(() => h.reportById(report.id)?.stage === 'blocked', { label: 'blocked on imaging' });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 80));
    expect(h.reportById(report.id)?.lastError?.kind).toBe('imaging');
    expect(h.imaging.prepared).not.toContain(image.id);
    expect(h.transport.uploadCalls.length).toBe(0); // never reached the network
  });

  it('stops retrying once the attempt budget is spent, and says so', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const ports: QueuePorts = {
      store,
      transport,
      imaging: new FakeImaging(),
      network: new FakeNetwork(true),
      clock: realClock,
      logger: silentLogger,
    };
    const queue = new UploadQueue(ports, { backoff: FAST_BACKOFF, maxAttempts: 3 });
    track(queue);
    // Always fails, and always in a way that looks retryable.
    transport.uploadScript = Array.from({ length: 20 }, () => ({ type: 'throw', error: serverFailure() }) as const);
    await queue.start();

    const report = await submit(queue, 'the server is never coming back');
    await waitFor(() => queue.getSnapshot().reports[0]?.stage === 'blocked', { label: 'budget spent' });

    const final = queue.getSnapshot().reports.find(r => r.id === report.id);
    expect(final?.attempts).toBe(3);
    expect(final?.lastError?.retryable).toBe(false);
    expect(final?.lastError?.message).toContain('Gave up after 3 attempts');
    expect(transport.uploadCalls.length).toBe(3); // not 4, not forever
  });
});

describe('UploadQueue — refusing bad input', () => {
  const build = () => harness().queue;

  it('rejects a blank description', async () => {
    await expect(build().enqueue({ description: '   ', images: [UploadQueue.rawImage(photo())] })).rejects.toThrow(
      ValidationError,
    );
  });

  it('rejects zero images', async () => {
    await expect(build().enqueue({ description: 'no photos', images: [] })).rejects.toThrow(ValidationError);
  });

  it('rejects a sixth image', async () => {
    const images = Array.from({ length: 6 }, () => UploadQueue.rawImage(photo()));
    await expect(build().enqueue({ description: 'too many', images })).rejects.toThrow(ValidationError);
  });

  it('nothing is written when validation fails', async () => {
    const h = harness();
    await expect(h.queue.enqueue({ description: '', images: [] })).rejects.toThrow(ValidationError);
    expect(h.store.rows.size).toBe(0);
  });
});
