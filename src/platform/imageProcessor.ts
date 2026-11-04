import ImageResizer from '@bam.tech/react-native-image-resizer';
import { FileSystem } from 'react-native-file-access';
import { ImagingError } from '../core/errors';
import { LIMITS, MIME_JPEG } from '../core/limits';
import type { Imaging, PreparedImage } from '../core/ports';
import type { ImageFile } from '../core/types';
import { ensureDir, fileSize, paths, removeQuietly, toFileUri, toPath } from './files';
import { logger } from './logger';

/** Hard stop on the search. Each pass is a full decode+encode of a large photo. */
const MAX_PASSES = 5;

interface Pass {
  edge: number;
  quality: number;
}

/**
 * Get every photo under 5 MB without making it useless.
 *
 * Two requirements pull against each other: "the app never sends one over it"
 * and "it has to still be worth looking at". A fixed quality satisfies neither
 * reliably — an 18 MB wide-angle shot of a dim stairwell and a 6 MB close-up
 * of a weld compress completely differently.
 *
 * So the ceiling is treated as a search, not a setting. The first pass resizes
 * to the longest edge we want and encodes at high quality. If that misses, the
 * second pass uses the measured result to jump straight to a size that should
 * fit — JPEG size tracks pixel count closely enough that sqrt(target/actual)
 * is a good estimate — rather than creeping down a quality ladder. Typical
 * photos need one or two passes.
 *
 * Resolution is spent before quality: 2560 px at q76 is far more readable than
 * 4032 px at q35, and it is the detail in the frame that the inspector needs.
 *
 * All of it runs in the native module, off the JS thread, so the UI never
 * stalls behind it.
 */
export class DeviceImaging implements Imaging {
  async prepare(reportId: string, imageId: string, source: ImageFile): Promise<PreparedImage> {
    await ensureDir(paths.reportDir(reportId));
    const target = paths.prepared(reportId, imageId);

    const longestEdge = Math.max(source.width, source.height);
    const knownDimensions = longestEdge > 0;

    // Already acceptable: don't re-encode and lose detail for nothing.
    if (knownDimensions && source.bytes <= LIMITS.maxImageBytes && longestEdge <= LIMITS.maxEdgePx) {
      await FileSystem.cp(toPath(source.uri), target);
      const bytes = await fileSize(target);
      logger.info(`${imageId}: kept original (${mb(bytes)}, ${source.width}x${source.height})`);
      return {
        uri: toFileUri(target),
        bytes,
        width: source.width,
        height: source.height,
        passthrough: true,
        quality: null,
      };
    }

    const startEdge = knownDimensions ? Math.min(LIMITS.maxEdgePx, longestEdge) : LIMITS.maxEdgePx;
    let pass: Pass = { edge: startEdge, quality: LIMITS.qualityLadder[0] };
    let attempt = 0;

    while (attempt < MAX_PASSES) {
      attempt += 1;
      const result = await this.#encode(source.uri, pass);

      if (result.bytes <= LIMITS.maxImageBytes) {
        await FileSystem.mv(toPath(result.uri), target);
        const bytes = await fileSize(target);
        logger.info(
          `${imageId}: ${mb(source.bytes)} -> ${mb(bytes)} (${result.width}x${result.height} q${pass.quality}, ${attempt} pass${attempt === 1 ? '' : 'es'})`,
        );
        return {
          uri: toFileUri(target),
          bytes,
          width: result.width,
          height: result.height,
          passthrough: false,
          quality: pass.quality,
        };
      }

      await removeQuietly(result.uri);
      pass = nextPass(pass, result.bytes, attempt);
      logger.warn(`${imageId}: ${mb(result.bytes)} still over the ceiling, retrying at ${pass.edge}px q${pass.quality}`);
    }

    throw new ImagingError(
      `This photo could not be brought under ${mb(LIMITS.maxImageBytes)} after ${MAX_PASSES} attempts. It has not been sent.`,
    );
  }

  async thumbnail(reportId: string, imageId: string, source: ImageFile): Promise<string | null> {
    try {
      await ensureDir(paths.reportDir(reportId));
      const target = paths.thumbnail(reportId, imageId);
      const result = await this.#encode(source.uri, { edge: LIMITS.thumbEdgePx, quality: LIMITS.thumbQuality });
      await FileSystem.mv(toPath(result.uri), target);
      return toFileUri(target);
    } catch (error) {
      // A missing thumbnail costs a grey square. It must never cost a delivery.
      logger.warn(`${imageId}: thumbnail failed`, error);
      return null;
    }
  }

  async discard(uri: string | undefined): Promise<void> {
    await removeQuietly(uri);
  }

  async discardReport(reportId: string): Promise<void> {
    const dir = paths.reportDir(reportId);
    try {
      if (await FileSystem.exists(dir)) await FileSystem.unlink(dir);
    } catch (error) {
      logger.warn(`could not remove ${dir}`, error);
    }
  }

  /**
   * Delete image folders with no owning record: a composer abandoned mid-draft,
   * or a delivery that died between removing the record and removing its bytes.
   * Without this, "reset" leaves megabytes behind that nothing will ever claim.
   */
  async sweepOrphans(liveReportIds: string[]): Promise<number> {
    try {
      if (!(await FileSystem.exists(paths.root))) return 0;
      const live = new Set(liveReportIds);
      let removed = 0;
      for (const name of await FileSystem.ls(paths.root)) {
        if (live.has(name)) continue;
        await FileSystem.unlink(`${paths.root}/${name}`);
        removed += 1;
      }
      return removed;
    } catch (error) {
      logger.warn('orphan sweep failed', error);
      return 0;
    }
  }

  async #encode(sourceUri: string, pass: Pass): Promise<ImageFile> {
    try {
      const result = await ImageResizer.createResizedImage(
        sourceUri,
        pass.edge,
        pass.edge,
        'JPEG',
        pass.quality,
        0,
        null, // write to cache; we move it to its final home once it fits
        false, // drop EXIF: the pixels are already rotated upright, and this
        // also strips GPS, which has no business leaving the device
        { mode: 'contain', onlyScaleDown: true },
      );
      // Trust the filesystem, not the module's reported size: this number is
      // sent as X-Expected-Bytes and the server rejects a mismatch.
      const bytes = await fileSize(result.path);
      return { uri: toFileUri(result.path), bytes, width: result.width, height: result.height };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ImagingError(`This photo could not be read (${message}). It has not been sent.`);
    }
  }
}

/**
 * JPEG size tracks pixel count, so the measured overshoot tells us how far to
 * scale down. Aim slightly under the ceiling and drop quality a notch each
 * time, so the search converges instead of creeping.
 */
function nextPass(current: Pass, measuredBytes: number, attempt: number): Pass {
  const ratio = LIMITS.maxImageBytes / measuredBytes;
  const estimate = Math.round(current.edge * Math.sqrt(ratio) * 0.92);
  const edge = Math.max(LIMITS.minEdgePx, Math.min(current.edge - 1, estimate));
  const quality = LIMITS.qualityLadder[Math.min(attempt, LIMITS.qualityLadder.length - 1)];
  return { edge, quality };
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const JPEG_MIME = MIME_JPEG;
