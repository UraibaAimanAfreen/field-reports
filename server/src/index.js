import express from 'express';
import multer from 'multer';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Chaos, MODES, sleep, stallSocket, transferMs } from './chaos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 4000);
// path.resolve, not path.join: join leaves the '..' segment in the string,
// and Express 5's sendFile rejects any path containing '..' as traversal --
// which showed up as every image 404ing while sitting right there on disk.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '.data'));

/**
 * The same ceiling the app enforces, restated here on purpose.
 *
 * The app is responsible for never sending an image over this size. The server
 * refusing it is the assertion that proves the app did its job: if compression
 * ever regresses, the upload fails loudly with a 413 instead of silently
 * shipping a 20 MB file.
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_REPORT = 5;
const MIN_IMAGES_PER_REPORT = 1;
const MAX_DESCRIPTION_CHARS = 2000;

const store = new Store(DATA_DIR);
await store.init();

const chaos = new Chaos();
const upload = multer({ dest: store.tmpDir, limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Request log (surfaced live in the control panel so failures and de-duplicated
// retries are visible without reading the terminal).
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const started = Date.now();
  if (req.path.startsWith('/v1')) {
    res.on('finish', () => {
      chaos.note({
        kind: 'request',
        message: `${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - started}ms)${res.locals.note ? ` · ${res.locals.note}` : ''}`,
        status: res.statusCode,
      });
    });
    // Listen on the RESPONSE, not the request. The request stream closes as
    // soon as the body is consumed, which is before the response is written,
    // so checking there reported "no response" for every successful request.
    // res.writableFinished is only true once the response is genuinely out.
    res.on('close', () => {
      if (res.writableFinished) return;
      chaos.note({
        kind: 'aborted',
        message: `${req.method} ${req.path} -> no response (${Date.now() - started}ms)${res.locals.note ? ` · ${res.locals.note}` : ''}`,
        status: 0,
      });
    });
  }
  next();
});

// ---------------------------------------------------------------------------
// Chaos: decided per request, applied before the body is read (stall / drop)
// and again after it has been read (refuse / 500 / hang).
// ---------------------------------------------------------------------------
app.use('/v1', (req, res, next) => {
  const mode = chaos.resolveMode(req);
  req.chaosMode = mode;
  req.chaosStartedAt = Date.now();
  let cleanup = () => {};

  if (mode === 'slow') {
    cleanup = stallSocket(req);
  }

  if (mode === 'drop') {
    const timer = setTimeout(() => {
      chaos.note({ kind: 'drop', message: `${req.method} ${req.path} · connection destroyed mid-request` });
      req.socket.destroy();
    }, chaos.state.dropAfterMs);
    const clear = () => clearTimeout(timer);
    res.on('finish', clear);
    req.on('close', clear);
  }

  res.on('finish', () => cleanup());
  req.on('close', () => cleanup());
  next();
});

/**
 * Chaos applied once the body has been consumed.
 * Returns true when it has taken ownership of the response.
 */
async function chaosAfterBody(req, res, { stage, bytes = 0 }) {
  const mode = req.chaosMode;

  if (mode === 'refuse') {
    res.locals.note = 'chaos:refuse';
    res.status(400).json({
      error: { code: 'REJECTED_BY_SERVER', message: 'Chaos mode "refuse": the server will not accept this payload.' },
    });
    return true;
  }

  if (mode === 'error500') {
    res.locals.note = 'chaos:500';
    res.status(500).json({
      error: { code: 'CHAOS_500', message: 'Chaos mode "error500": transient server fault.' },
    });
    return true;
  }

  if (mode === 'drop') {
    res.locals.note = 'chaos:drop';
    chaos.note({ kind: 'drop', message: `${req.method} ${req.path} · connection destroyed, nothing committed` });
    req.socket.destroy();
    return true;
  }

  if (mode === 'hang') {
    res.locals.note = `chaos:hang after ${stage}`;
    chaos.note({
      kind: 'hang',
      message: `${req.method} ${req.path} · ${stage} committed, response withheld (lost-response test)`,
    });
    req.socket.setTimeout(0);
    return true; // never respond
  }

  // `slow`: hold the response until the body would have finished transferring
  // on the configured link. See the note in chaos.js on why the socket stall
  // alone is not enough over loopback.
  if (mode === 'slow' && bytes > 0) {
    const remaining = transferMs(bytes, chaos.state.linkKbps) - (Date.now() - req.chaosStartedAt);
    if (remaining > 0) await sleep(remaining);
  }

  if (chaos.state.latencyMs > 0) await sleep(chaos.state.latencyMs);
  return false;
}

const removeTemp = async file => {
  if (file?.path) await fsp.rm(file.path, { force: true }).catch(() => {});
};

const idempotencyKeyOf = req => {
  const key = req.get('idempotency-key');
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(trimmed)) return null;
  return trimmed;
};

const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get('/v1/health', (req, res) => {
  res.json({ ok: true, now: new Date().toISOString(), limits: { maxImageBytes: MAX_IMAGE_BYTES, maxImages: MAX_IMAGES_PER_REPORT } });
});

/**
 * Upload one image.
 *
 * Idempotency-Key is the client's image id, generated and persisted on device
 * BEFORE the first attempt. That ordering is the whole trick: however many
 * times this request is replayed (retry, force-quit, lost response), the key is
 * the same, so the second arrival returns the first result instead of storing
 * a second copy.
 */
app.post('/v1/uploads', upload.single('file'), async (req, res) => {
  const key = idempotencyKeyOf(req);
  if (!key) {
    await removeTemp(req.file);
    return fail(res, 400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required.');
  }
  if (!req.file) {
    return fail(res, 400, 'MISSING_FILE', 'Expected a multipart field named "file".');
  }

  const existing = store.getUpload(key);
  if (existing) {
    await removeTemp(req.file);
    res.locals.note = `duplicate ${key.slice(0, 8)}`;
    chaos.note({ kind: 'duplicate', message: `upload ${key} already stored · returned original, nothing written` });
    if (await chaosAfterBody(req, res, { stage: 'upload (duplicate)', bytes: req.file.size })) return;
    return res.status(200).json({ ...existing, duplicate: true });
  }

  const expected = req.get('x-expected-bytes');
  if (expected !== undefined && expected !== null && expected !== '') {
    const declared = Number(expected);
    if (Number.isFinite(declared) && declared !== req.file.size) {
      await removeTemp(req.file);
      return fail(
        res,
        422,
        'BYTE_COUNT_MISMATCH',
        `Client declared ${declared} bytes but sent ${req.file.size}. Treated as permanent: replaying a payload the client measures incorrectly will not fix it.`,
      );
    }
  }

  if (req.file.size > MAX_IMAGE_BYTES) {
    await removeTemp(req.file);
    return fail(res, 413, 'IMAGE_TOO_LARGE', `Image is ${req.file.size} bytes; the ceiling is ${MAX_IMAGE_BYTES}.`);
  }

  if (req.chaosMode === 'refuse' || req.chaosMode === 'error500' || req.chaosMode === 'drop') {
    await removeTemp(req.file);
    if (await chaosAfterBody(req, res, { stage: 'upload' })) return;
  }

  const record = await store.commitUpload(key, req.file.path, {
    mime: req.file.mimetype,
    filename: req.file.originalname,
    reportId: req.get('x-report-id') || null,
  });

  res.locals.note = `stored ${record.bytes}B`;
  if (await chaosAfterBody(req, res, { stage: 'upload', bytes: record.bytes })) return;
  res.status(201).json({ ...record, duplicate: false });
});

/**
 * Commit a report. Also idempotent, keyed by the client's report id.
 * Returns 200 (not an error) when the report already exists, so a client that
 * lost the first response can converge instead of getting stuck.
 */
app.post('/v1/reports', express.json({ limit: '256kb' }), async (req, res) => {
  const key = idempotencyKeyOf(req);
  if (!key) return fail(res, 400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required.');

  const existing = store.getReport(key);
  if (existing) {
    res.locals.note = `duplicate report ${key.slice(0, 8)}`;
    chaos.note({ kind: 'duplicate', message: `report ${key} already committed · returned original, nothing written` });
    if (await chaosAfterBody(req, res, { stage: 'report (duplicate)' })) return;
    return res.status(200).json({ report: existing, duplicate: true });
  }

  const body = req.body ?? {};
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const imageIds = Array.isArray(body.imageIds) ? body.imageIds : null;

  if (!description) return fail(res, 400, 'DESCRIPTION_REQUIRED', 'description must be a non-empty string.');
  if (description.length > MAX_DESCRIPTION_CHARS) return fail(res, 400, 'DESCRIPTION_TOO_LONG', `description exceeds ${MAX_DESCRIPTION_CHARS} characters.`);
  if (!imageIds) return fail(res, 400, 'IMAGES_REQUIRED', 'imageIds must be an array.');
  if (imageIds.length < MIN_IMAGES_PER_REPORT || imageIds.length > MAX_IMAGES_PER_REPORT) {
    return fail(res, 400, 'IMAGE_COUNT_OUT_OF_RANGE', `A report must contain ${MIN_IMAGES_PER_REPORT}-${MAX_IMAGES_PER_REPORT} images; got ${imageIds.length}.`);
  }
  const missing = imageIds.filter(id => !store.getUpload(id));
  if (missing.length) {
    return fail(res, 409, 'IMAGES_NOT_UPLOADED', `These images have not been uploaded yet: ${missing.join(', ')}. Retryable once the uploads land.`);
  }

  if (req.chaosMode === 'refuse' || req.chaosMode === 'error500' || req.chaosMode === 'drop') {
    if (await chaosAfterBody(req, res, { stage: 'report' })) return;
  }

  const report = await store.commitReport(key, { description, imageIds, createdAt: body.createdAt, deviceId: body.deviceId });
  res.locals.note = `report ${report.id.slice(0, 8)} with ${imageIds.length} image(s)`;
  if (await chaosAfterBody(req, res, { stage: 'report' })) return;
  res.status(201).json({ report, duplicate: false });
});

app.get('/v1/reports', async (req, res) => {
  if (await chaosAfterBody(req, res, { stage: 'list' })) return;
  res.json({ reports: store.listReports(), stats: store.stats() });
});

app.get('/v1/images/:id', (req, res) => {
  const filePath = store.filePathFor(req.params.id);
  if (!filePath) return fail(res, 404, 'NOT_FOUND', 'No such image.');
  const record = store.getUpload(req.params.id);
  res.setHeader('Content-Type', record.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  // dotfiles:'allow' is required because the storage directory is `.data`.
  // send() defaults to dotfiles:'ignore', which treats ANY path component
  // beginning with a dot as missing -- so every image 404'd while sitting
  // right there on disk.
  res.sendFile(filePath, { dotfiles: 'allow' });
});

app.delete('/v1/reports', async (req, res) => {
  await store.reset();
  chaos.note({ kind: 'reset', message: 'server storage wiped' });
  res.json({ ok: true, stats: store.stats() });
});

// ---------------------------------------------------------------------------
// Chaos control (never itself affected by chaos, or you could not turn it off)
// ---------------------------------------------------------------------------
app.get('/chaos', (req, res) => res.json({ state: chaos.state, modes: MODES, stats: store.stats() }));

app.post('/chaos', express.json(), (req, res) => {
  try {
    res.json({ state: chaos.update(req.body ?? {}), modes: MODES });
  } catch (error) {
    fail(res, 400, 'BAD_CHAOS_CONFIG', error.message);
  }
});

app.get('/chaos/log', (req, res) => res.json({ log: chaos.log, state: chaos.state, stats: store.stats() }));
app.delete('/chaos/log', (req, res) => { chaos.clearLog(); res.json({ ok: true }); });

app.use(express.static(path.join(__dirname, '..', 'public')));

// Multer / unexpected failures
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (!req.socket || req.socket.destroyed) return; // chaos destroyed it on purpose
  if (error?.code === 'LIMIT_FILE_SIZE') {
    return fail(res, 413, 'IMAGE_TOO_LARGE', `Image exceeds the ${MAX_IMAGE_BYTES} byte ceiling.`);
  }
  chaos.note({ kind: 'error', message: `${req.method} ${req.path} · ${error?.message ?? error}` });
  fail(res, 500, 'UNEXPECTED', error?.message ?? 'Unexpected server error.');
});

const server = app.listen(PORT, '0.0.0.0', () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);

  console.log('\n  Field Reports backend');
  console.log(`  ─────────────────────────────────────────────`);
  console.log(`  Control panel   http://localhost:${PORT}/`);
  console.log(`  Android emulator  http://10.0.2.2:${PORT}`);
  addresses.forEach(a => console.log(`  Physical device   http://${a}:${PORT}`));
  console.log(`  Data dir        ${DATA_DIR}`);
  console.log(`  Image ceiling   ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MB\n`);
});

// "hang" must really never answer, so Node's own request timeouts are disabled.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 120000;
