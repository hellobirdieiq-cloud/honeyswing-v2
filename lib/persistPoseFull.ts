import { supabase } from './supabase';
import { emit as emitEvent } from './eventBus';
import type { Rtmw133Frame } from '../packages/pose/rtmw/Rtmw133Frame';

export const POSE_SOURCE_TAG = 'rtmw-l-2d-v1';

export async function persistPoseFull(swingId: string, frames: Rtmw133Frame[]): Promise<void> {
  // Bounded retry: the previous single-shot update discarded the returned
  // { error } and had no row-count check, so transient network failures and
  // 0-row updates silently dropped the pose payload. Retry within the call;
  // a 0-row result is deterministic (RLS / stale id) and is not retried.
  const MAX_ATTEMPTS = 3;
  let message = '';
  let code: string | null = null;
  let classification: 'network' | 'postgres' | 'zero_rows' = 'network';
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      const { data, error } = await supabase
        .from('swings')
        .update({ pose_full: frames, pose_source: POSE_SOURCE_TAG })
        .eq('id', swingId)
        .select('id');

      if (!error) {
        if ((data?.length ?? 0) === 0) {
          // 0-row update = RLS filtered or stale/foreign id — retrying
          // cannot help, so emit terminal telemetry and bail.
          message = 'update matched 0 rows';
          code = null;
          classification = 'zero_rows';
          console.error(
            `[HoneySwing] persistPoseFull 0-row update (RLS or stale id), swingId: ${swingId}`,
          );
          break;
        }
        return; // success
      }

      // Returned PostgrestError = Postgres-side failure → retryable.
      message = error.message;
      code = error.code ?? null;
      classification = 'postgres';
      console.error(
        `[HoneySwing] persistPoseFull attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
        error.message,
      );
    } catch (err) {
      // Thrown error = network/fetch reject → retryable.
      message = err instanceof Error ? err.message : String(err);
      code = null;
      classification = 'network';
      console.error('[HoneySwing] persistPoseFull error:', err);
      console.error(
        `[HoneySwing] persistPoseFull attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
        message,
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  // Terminal failure (retries exhausted or deterministic 0-row). Queryable
  // telemetry (drains to public.events via the offline-capable event bus) so
  // pose-persist failure rates are visible across users.
  emitEvent('error.captured', {
    scope: 'persist_pose_full',
    message,
    context: {
      code,
      classification,
      frameCount: frames.length,
      attempts,
    },
  });
  console.error(
    `[HoneySwing] persistPoseFull failed after ${attempts} attempt(s) (${classification}):`,
    message,
  );
}
