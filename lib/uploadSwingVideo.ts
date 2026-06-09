import { runVideoUpload } from './outbox';

/**
 * Thin fallback wrapper — the non-iOS / OUTBOX_ENABLED=false path (and the
 * rollback path on iOS). The durable outbox (lib/outbox.ts) owns
 * persistence + retry/backoff; this runs the upload+idempotency body ONCE via
 * the shared `runVideoUpload` handler (the 409-as-success rule lives there).
 * The old inline 3-attempt retry loop has been removed.
 *
 * Errors are swallowed to match the prior fire-and-forget contract — the call
 * site `.catch(console.warn)`s anyway and neither blocks UI nor navigation.
 */
export async function uploadSwingVideo(swingId: string, videoPath: string): Promise<void> {
  try {
    const { outcome } = await runVideoUpload(swingId, videoPath);
    if (outcome !== 'done') {
      console.warn(`[HoneySwing] uploadSwingVideo (fallback) outcome: ${outcome}`);
    }
  } catch (err) {
    console.error('[HoneySwing] uploadSwingVideo (fallback) error:', err);
  }
}
