import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { LIMITS } from '../core/limits';
import type { CommitArgs, QueuePorts, RemoteImage, Transport, UploadArgs } from '../core/ports';
import { UploadQueue } from '../core/queue';
import type { ServerReport } from '../core/types';
import {
  FileReportStore,
  NodeImaging,
  NodeNetwork,
  NodeTransport,
  consoleLogger,
  nodeClock,
  writeFakePhoto,
} from './nodePorts';

/**
 * The upload path, exercised without rendering a screen.
 *
 * This is the same UploadQueue the app runs, wired to Node implementations of
 * the same ports. It talks to the real backend over the real wire, so the
 * failure modes in the control panel apply to it exactly as they do to the
 * phone — and it finishes by checking the server's own view, which is the only
 * evidence that matters for "exactly once".
 */

interface Options {
  baseUrl: string;
  reports: number;
  images: number;
  megabytes: number;
  chaos: string | null;
  gauntlet: boolean;
  keep: boolean;
  verbose: boolean;
  timeoutMs: number;
  workDir: string;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const has = (flag: string) => argv.includes(flag);

  return {
    baseUrl: get('--base', process.env.FR_BASE_URL ?? 'http://localhost:4000').replace(/\/+$/, ''),
    reports: Number(get('--reports', '3')),
    images: Number(get('--images', '2')),
    megabytes: Number(get('--mb', '18')),
    chaos: has('--chaos') ? get('--chaos', 'off') : null,
    gauntlet: has('--gauntlet'),
    keep: has('--keep'),
    verbose: has('--verbose'),
    timeoutMs: Number(get('--timeout', '180')) * 1000,
    workDir: get('--work', path.join(os.tmpdir(), 'field-reports-harness')),
  };
}

/** Counts attempts and de-duplicated replies, so the summary can prove both. */
class CountingTransport implements Transport {
  uploadAttempts = 0;
  commitAttempts = 0;
  duplicateUploads = 0;
  duplicateCommits = 0;
  readonly #inner: Transport;

  constructor(inner: Transport) {
    this.#inner = inner;
  }

  async uploadImage(args: UploadArgs): Promise<RemoteImage> {
    this.uploadAttempts += 1;
    const result = await this.#inner.uploadImage(args);
    if (result.duplicate) this.duplicateUploads += 1;
    return result;
  }

  async commitReport(args: CommitArgs): Promise<{ id: string; duplicate: boolean }> {
    this.commitAttempts += 1;
    const result = await this.#inner.commitReport(args);
    if (result.duplicate) this.duplicateCommits += 1;
    return result;
  }

  listReports(signal?: AbortSignal): Promise<ServerReport[]> {
    return this.#inner.listReports(signal);
  }

  wipeServer(): Promise<void> {
    return this.#inner.wipeServer();
  }
}

const setChaos = async (baseUrl: string, body: Record<string, unknown>): Promise<void> => {
  await fetch(`${baseUrl}/chaos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined);
};

/** Cycle failure modes underneath a running queue. */
function startGauntlet(baseUrl: string, log: (message: string) => void): () => void {
  const schedule: { at: number; body: Record<string, unknown>; label: string }[] = [
    { at: 0, body: { mode: 'drop', dropAfterMs: 150 }, label: 'connections dropped mid-flight' },
    { at: 8_000, body: { mode: 'error500' }, label: 'server returning 500' },
    { at: 16_000, body: { mode: 'hang' }, label: 'server storing then never answering (lost responses)' },
    { at: 28_000, body: { mode: 'slow', linkKbps: 1024 }, label: 'link throttled' },
    { at: 40_000, body: { mode: 'off' }, label: 'network restored' },
  ];
  const timers = schedule.map(step =>
    setTimeout(() => {
      log(`chaos: ${step.label}`);
      void setChaos(baseUrl, step.body);
    }, step.at),
  );
  return () => timers.forEach(clearTimeout);
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const logger = consoleLogger(options.verbose);

  console.log('\n  Field Reports — headless queue harness');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  backend   ${options.baseUrl}`);
  console.log(`  payload   ${options.reports} report(s) x ${options.images} photo(s) @ ~${options.megabytes} MB each`);
  console.log(`  work dir  ${options.workDir}`);
  console.log(`  chaos     ${options.gauntlet ? 'gauntlet' : (options.chaos ?? 'off')}\n`);

  const health = await fetch(`${options.baseUrl}/v1/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`  Cannot reach the backend at ${options.baseUrl}. Start it with: cd server && npm start\n`);
    return 2;
  }

  const storeDir = path.join(options.workDir, 'records');
  const filesDir = path.join(options.workDir, 'files');

  if (!options.keep) {
    await fs.rm(options.workDir, { recursive: true, force: true });
  }
  await fs.mkdir(storeDir, { recursive: true });
  await fs.mkdir(filesDir, { recursive: true });

  const store = new FileReportStore(storeDir);
  await store.init();
  const transport = new CountingTransport(new NodeTransport(options.baseUrl));
  const network = new NodeNetwork();

  if (!options.keep) {
    await transport.wipeServer();
    await setChaos(options.baseUrl, { mode: 'off' });
  }

  const ports: QueuePorts = {
    store,
    transport,
    imaging: new NodeImaging(filesDir),
    network,
    clock: nodeClock,
    logger,
  };
  const queue = new UploadQueue(ports, { backoff: { baseMs: 750, capMs: 15_000 } });

  const resumed = (await store.all()).filter(report => report.stage !== 'delivered');
  if (resumed.length) console.log(`  resuming ${resumed.length} report(s) left over from a previous run\n`);

  await queue.start();

  let stopGauntlet = () => {};
  if (options.gauntlet) stopGauntlet = startGauntlet(options.baseUrl, message => logger.info(message));
  else if (options.chaos) await setChaos(options.baseUrl, { mode: options.chaos });

  // Compose the reports. Photos are written first, exactly as the camera would
  // leave them: far too large to send as they are.
  const expected = resumed.length ? resumed.length : options.reports;
  if (!resumed.length) {
    for (let r = 0; r < options.reports; r += 1) {
      const reportId = UploadQueue.newDraftId();
      const images = [];
      for (let i = 0; i < options.images; i += 1) {
        const imageId = UploadQueue.newImageId();
        const file = await writeFakePhoto(
          path.join(filesDir, reportId, `src_${imageId}.jpg`),
          Math.round(options.megabytes * 1024 * 1024),
        );
        images.push(UploadQueue.rawImage(file, imageId));
      }
      await queue.enqueue({ id: reportId, description: `Headless report ${r + 1} of ${options.reports}`, images });
    }
    console.log(`  queued ${options.reports} report(s)\n`);
  }

  let lastLine = '';
  const unsubscribe = queue.subscribe(snapshot => {
    const counts = { queued: 0, working: 0, delivered: 0, blocked: 0 };
    for (const report of snapshot.reports) counts[report.stage] += 1;
    const active = snapshot.active;
    const detail = !active
      ? ''
      : active.phase === 'committing'
        ? ' · committing'
        : ` · ${active.phase} ${active.imageIndex + 1}/${active.imageCount}${
            active.fraction != null ? ` ${Math.round(active.fraction * 100)}%` : ''
          }`;
    const line = `  queued ${counts.queued} · working ${counts.working} · delivered ${counts.delivered} · blocked ${counts.blocked}${detail}`;
    if (line === lastLine) return;
    lastLine = line;
    process.stdout.write(`\r${line.padEnd(96)}`);
  });

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    console.log('\n\n  ^C — stopping. Run again with --keep to watch the queue resume.\n');
  };
  process.once('SIGINT', onSigint);

  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline && !interrupted) {
    const reports = queue.getSnapshot().reports;
    if (reports.length > 0 && reports.every(report => report.stage === 'delivered' || report.stage === 'blocked')) break;
    await nodeClock.sleep(200);
  }

  stopGauntlet();
  await setChaos(options.baseUrl, { mode: 'off' });
  unsubscribe();
  await queue.stop();
  process.removeListener('SIGINT', onSigint);
  if (interrupted) return 130;

  // ---------------------------------------------------------------------
  // Verify against the server, not against our own optimism.
  // ---------------------------------------------------------------------
  const local = queue.getSnapshot().reports;
  const onServer = await transport.listReports();
  const deliveredLocally = local.filter(report => report.stage === 'delivered');
  const blocked = local.filter(report => report.stage === 'blocked');

  const allImages = onServer.flatMap(report => report.images);
  const imageIds = allImages.map(image => image.imageId);
  const duplicateIds = imageIds.filter((id, index) => imageIds.indexOf(id) !== index);
  const oversize = allImages.filter(image => image.bytes > LIMITS.maxImageBytes);
  const serverIds = onServer.map(report => report.id);
  const dupeReports = serverIds.filter((id, index) => serverIds.indexOf(id) !== index);

  console.log('\n');
  console.log('  Result');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  delivered locally    ${deliveredLocally.length} / ${expected}`);
  console.log(`  blocked              ${blocked.length}`);
  console.log(`  reports on server    ${onServer.length}`);
  console.log(`  images on server     ${allImages.length}`);
  console.log(`  largest image        ${allImages.length ? mb(Math.max(...allImages.map(i => i.bytes))) : '—'}`);
  console.log(`  upload attempts      ${transport.uploadAttempts} (${transport.duplicateUploads} de-duplicated by the server)`);
  console.log(`  commit attempts      ${transport.commitAttempts} (${transport.duplicateCommits} de-duplicated by the server)`);

  const checks: { label: string; ok: boolean }[] = [
    { label: `every report reached the server (${onServer.length}/${expected})`, ok: onServer.length === expected },
    { label: 'no report stored twice', ok: dupeReports.length === 0 },
    { label: 'no image stored twice', ok: duplicateIds.length === 0 },
    { label: `every image under ${mb(LIMITS.maxImageBytes)}`, ok: oversize.length === 0 },
    { label: 'nothing left blocked', ok: blocked.length === 0 },
    {
      label: `every report carries its ${options.images} image(s)`,
      ok: onServer.every(report => report.images.length === options.images),
    },
  ];

  console.log('');
  for (const check of checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.label}`);
  for (const report of blocked) console.log(`\n  blocked: ${report.id} — ${report.lastError?.message ?? 'unknown'}`);

  const passed = checks.every(check => check.ok);
  console.log(`\n  ${passed ? 'All checks passed.' : 'FAILED.'}\n`);
  return passed ? 0 : 1;
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error('\n  harness crashed:', error);
    process.exit(1);
  });
