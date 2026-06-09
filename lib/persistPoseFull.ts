import { emit as emitEvent } from './eventBus';
import type { Rtmw133Frame } from '../packages/pose/rtmw/Rtmw133Frame';
import { runPoseUpdate, POSE_SOURCE_TAG } from './outbox';

// POSE_SOURCE_TAG's source of truth now lives in ./outbox (the outbox engine
// imports it, and a re-import here would be circular). Re-export it so
// persistPoseFull's public surface is unchanged for existing importers.
export { POSE_SOURCE_TAG };

/**
 * Thin fallback wrapper — the non-iOS / OUTBOX_ENABLED=false path (and the
 * rollback path on iOS). The durable outbox (lib/outbox.ts) owns
 * persistence + retry/backoff; this runs the pose write+idempotency body ONCE
 * via the shared `runPoseUpdate` handler (precheck + tag-skip live there) and
 * emits the terminal telemetry on a non-`done` outcome. The old inline
 * 3-attempt retry loop has been removed.
 */
export async function persistPoseFull(swingId: string, frames: Rtmw133Frame[]): Promise<void> {
  const { outcome, code } = await runPoseUpdate(swingId, frames);
  if (outcome === 'done') return;

  // 0-row = RLS/stale id; a returned code = Postgres-side; else network.
  const classification: 'network' | 'postgres' | 'zero_rows' =
    outcome === 'zero_row' ? 'zero_rows' : code ? 'postgres' : 'network';
  const message =
    outcome === 'zero_row' ? 'update matched 0 rows' : 'pose update failed';

  // Queryable telemetry (drains to public.events via the offline-capable event
  // bus) so pose-persist failure rates stay visible across users.
  emitEvent('error.captured', {
    scope: 'persist_pose_full',
    message,
    context: {
      code: code ?? null,
      classification,
      frameCount: frames.length,
      attempts: 1,
    },
  });
  console.error(
    `[HoneySwing] persistPoseFull (fallback) failed (${classification}):`,
    message,
  );
}
