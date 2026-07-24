/**
 * downloadSwingVideo.ts — filesystem plumbing for the P-105 history
 * swing→putt repair: fetch a persisted swing's stored video (signed URL) into
 * an attempt-unique cache file so the native putting passes can decode LOCAL
 * pixels. All cache-file filesystem access for the repair lives here — the
 * result screen never touches expo-file-system directly.
 *
 * Integrity contract (fresh-download-per-attempt): each attempt gets its OWN
 * cache path (convert-putt-<swingId>-<nowMs>.mov), read only by the
 * immediately-following convertToPutt call in the same async chain. A failed
 * or partial download is never reusable: failure paths delete before
 * returning, the caller finally-deletes its attempt's file, and attempt-unique
 * names keep a zombie writer (a timed-out downloadAsync still writing) off any
 * path a retry reads. Hard-kill stragglers are swept at the next attempt for
 * the same swing and live in the OS-evictable Caches directory.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { getSwingVideoSignedUrl } from './getSwingVideoUrl';

// Generous bound for a ~4s H.265 clip; without it a stalled network pins the
// affordance in "Downloading video…" until the screen closes.
const DOWNLOAD_TIMEOUT_MS = 30000;

export type DownloadSwingVideoResult =
  | { ok: true; uri: string }
  | { ok: false; message: string };

/**
 * Best-effort cache-file delete — idempotent, never throws. Every delete of a
 * downloaded video (this module's failure paths AND the caller's finally)
 * routes through here.
 */
export async function deleteDownloadedSwingVideo(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Best-effort: a straggler is swept at the next attempt / OS-evicted.
  }
}

/** Sweep stale convert-putt-<swingId>-* files (hard-kill leftovers). */
async function sweepStaleDownloads(swingId: string): Promise<void> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return;
  try {
    const names = await FileSystem.readDirectoryAsync(dir);
    const prefix = `convert-putt-${swingId}-`;
    await Promise.all(
      names
        .filter((n) => n.startsWith(prefix))
        .map((n) => deleteDownloadedSwingVideo(dir + n)),
    );
  } catch {
    // Best-effort only — never blocks the attempt.
  }
}

/**
 * Download the swing's stored video to an attempt-unique cache file. Returns
 * the local uri on success; on any failure the attempt's file is already
 * deleted and the row is untouched (this module never writes the DB). The
 * caller owns deleting the returned uri (deleteDownloadedSwingVideo) once the
 * conversion settles.
 */
export async function downloadSwingVideoToCache(
  swingId: string,
  storagePath: string,
): Promise<DownloadSwingVideoResult> {
  await sweepStaleDownloads(swingId);

  const signedUrl = await getSwingVideoSignedUrl(storagePath);
  if (signedUrl == null) {
    return { ok: false, message: "download failed — couldn't get video link; tap to retry" };
  }
  const dir = FileSystem.cacheDirectory;
  if (dir == null) {
    return { ok: false, message: 'download failed — no cache directory; tap to retry' };
  }

  const uri = `${dir}convert-putt-${swingId}-${Date.now()}.mov`;
  try {
    const download = await Promise.race([
      FileSystem.downloadAsync(signedUrl, uri),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('download-timeout')), DOWNLOAD_TIMEOUT_MS),
      ),
    ]);
    if (download.status !== 200) {
      await deleteDownloadedSwingVideo(uri);
      return { ok: false, message: 'download failed — check connection; tap to retry' };
    }
    return { ok: true, uri };
  } catch (e) {
    console.warn(
      '[downloadSwingVideo] failed:',
      e instanceof Error ? e.message : String(e),
    );
    await deleteDownloadedSwingVideo(uri);
    return { ok: false, message: 'download failed — check connection; tap to retry' };
  }
}
