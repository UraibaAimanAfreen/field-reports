import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Durable, crash-safe server state.
 *
 * Two invariants matter for the client's exactly-once guarantee:
 *
 *  1. A blob is only visible once it is COMPLETE. Uploads are received into
 *     `tmp/`, verified, then renamed into `files/`. rename(2) is atomic on the
 *     same filesystem, so a connection dropped mid-body can never leave a
 *     half-written file that a later request would mistake for a finished one.
 *
 *  2. The idempotency index is written the same way (write tmp, fsync, rename),
 *     so the index is never observed half-updated after a server kill.
 */
export class Store {
  #root;
  #filesDir;
  #tmpDir;
  #indexPath;
  #data = { uploads: {}, reports: {} };
  #chain = Promise.resolve();

  constructor(root) {
    this.#root = root;
    this.#filesDir = path.join(root, 'files');
    this.#tmpDir = path.join(root, 'tmp');
    this.#indexPath = path.join(root, 'index.json');
  }

  get tmpDir() {
    return this.#tmpDir;
  }

  async init() {
    await fsp.mkdir(this.#filesDir, { recursive: true });
    await fsp.mkdir(this.#tmpDir, { recursive: true });
    try {
      const raw = await fsp.readFile(this.#indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.#data = {
        uploads: parsed.uploads ?? {},
        reports: parsed.reports ?? {},
      };
    } catch {
      await this.#flush();
    }
    await this.sweepTmp();
  }

  /** Delete orphaned partial uploads left behind by killed connections. */
  async sweepTmp() {
    let names = [];
    try {
      names = await fsp.readdir(this.#tmpDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      await fsp.rm(path.join(this.#tmpDir, name), { force: true });
      removed += 1;
    }
    return removed;
  }

  /** Serialise index writes so concurrent requests cannot interleave them. */
  #flush() {
    this.#chain = this.#chain.then(async () => {
      const tmp = `${this.#indexPath}.${process.pid}.tmp`;
      const body = JSON.stringify(this.#data, null, 2);
      const handle = await fsp.open(tmp, 'w');
      try {
        await handle.writeFile(body, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(tmp, this.#indexPath);
    });
    return this.#chain;
  }

  getUpload(key) {
    return this.#data.uploads[key] ?? null;
  }

  getReport(key) {
    return this.#data.reports[key] ?? null;
  }

  /**
   * Promote a fully received temp file into permanent storage.
   * Returns the stored descriptor. Safe to call twice with the same key.
   */
  async commitUpload(key, tmpPath, meta) {
    const existing = this.getUpload(key);
    if (existing) {
      await fsp.rm(tmpPath, { force: true });
      return existing;
    }

    const stat = await fsp.stat(tmpPath);
    const sha256 = await hashFile(tmpPath);
    const ext = extensionFor(meta.mime, meta.filename);
    const storedName = `${key}${ext}`;
    const finalPath = path.join(this.#filesDir, storedName);

    await fsp.rename(tmpPath, finalPath);

    const record = {
      imageId: key,
      storedName,
      bytes: stat.size,
      sha256,
      mime: meta.mime || 'application/octet-stream',
      filename: meta.filename || storedName,
      reportId: meta.reportId ?? null,
      receivedAt: new Date().toISOString(),
    };
    this.#data.uploads[key] = record;
    await this.#flush();
    return record;
  }

  async commitReport(key, payload) {
    const existing = this.getReport(key);
    if (existing) return existing;

    const record = {
      id: key,
      description: payload.description,
      imageIds: payload.imageIds,
      clientCreatedAt: payload.createdAt ?? null,
      deviceId: payload.deviceId ?? null,
      receivedAt: new Date().toISOString(),
    };
    this.#data.reports[key] = record;
    await this.#flush();
    return record;
  }

  listReports() {
    return Object.values(this.#data.reports)
      .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
      .map(report => ({
        ...report,
        images: report.imageIds
          .map(id => this.#data.uploads[id])
          .filter(Boolean)
          .map(u => ({
            imageId: u.imageId,
            bytes: u.bytes,
            sha256: u.sha256,
            mime: u.mime,
            url: `/v1/images/${u.imageId}`,
          })),
      }));
  }

  filePathFor(imageId) {
    const record = this.getUpload(imageId);
    if (!record) return null;
    return path.join(this.#filesDir, record.storedName);
  }

  stats() {
    const uploads = Object.values(this.#data.uploads);
    return {
      reports: Object.keys(this.#data.reports).length,
      images: uploads.length,
      bytes: uploads.reduce((sum, u) => sum + u.bytes, 0),
    };
  }

  async reset() {
    this.#data = { uploads: {}, reports: {} };
    await fsp.rm(this.#filesDir, { recursive: true, force: true });
    await fsp.mkdir(this.#filesDir, { recursive: true });
    await this.sweepTmp();
    await this.#flush();
  }
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function extensionFor(mime, filename) {
  const byMime = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  if (mime && byMime[mime]) return byMime[mime];
  const ext = filename ? path.extname(filename) : '';
  return ext || '.bin';
}
