import { Dirs, FileSystem } from 'react-native-file-access';

/**
 * Where a report's bytes live.
 *
 * DocumentDir, not CacheDir: the OS may evict the cache under storage
 * pressure, and "the system deleted your evidence while you were underground"
 * is not an acceptable failure mode. The picker hands us cache paths, so the
 * first thing the composer does with a photo is copy it here.
 */
const ROOT = `${Dirs.DocumentDir}/field-reports`;

export const paths = {
  root: ROOT,
  reportDir: (reportId: string) => `${ROOT}/${reportId}`,
  source: (reportId: string, imageId: string) => `${ROOT}/${reportId}/src_${imageId}.jpg`,
  prepared: (reportId: string, imageId: string) => `${ROOT}/${reportId}/out_${imageId}.jpg`,
  thumbnail: (reportId: string, imageId: string) => `${ROOT}/${reportId}/thumb_${imageId}.jpg`,
};

/** Records store `file://` URIs so they can go straight into <Image> and FormData. */
export const toFileUri = (path: string) => (path.startsWith('file://') ? path : `file://${path}`);

/** FileSystem calls want a bare path. */
export const toPath = (uri: string) => uri.replace(/^file:\/\//, '');

export async function ensureDir(path: string): Promise<void> {
  if (!(await FileSystem.exists(path))) await FileSystem.mkdir(path);
}

export async function fileSize(uriOrPath: string): Promise<number> {
  const stat = await FileSystem.stat(toPath(uriOrPath));
  return stat.size;
}

/** Never throws: used on cleanup paths where failing is worse than leaking. */
export async function removeQuietly(uriOrPath: string | undefined): Promise<void> {
  if (!uriOrPath) return;
  try {
    const path = toPath(uriOrPath);
    if (await FileSystem.exists(path)) await FileSystem.unlink(path);
  } catch {
    // A file we cannot delete is a storage leak, not a lost report.
  }
}

export async function bytesUsed(): Promise<number> {
  try {
    if (!(await FileSystem.exists(ROOT))) return 0;
    let total = 0;
    for (const dir of await FileSystem.ls(ROOT)) {
      const dirPath = `${ROOT}/${dir}`;
      const stat = await FileSystem.stat(dirPath);
      if (stat.type !== 'directory') {
        total += stat.size;
        continue;
      }
      for (const name of await FileSystem.ls(dirPath)) {
        total += (await FileSystem.stat(`${dirPath}/${name}`)).size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}
