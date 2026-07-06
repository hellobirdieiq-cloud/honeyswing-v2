import { purgeOutboxEntriesForSwing } from './outbox';

// Adapter (overridable for tests — mirrors outbox.ts sb()/fs())

export type DeleteSwingAdapter = {
  getUserId(): Promise<string | null>;
  purgeOutbox(swingId: string): Promise<void>;
  removeVideo(storagePath: string): Promise<{ error: { message?: string } | null }>;
  deleteRow(swingId: string): Promise<{ error: { message?: string } | null }>;
};

let adapter: DeleteSwingAdapter | null = null;

function resolveAdapter(): DeleteSwingAdapter {
  if (adapter) return adapter;
  // Lazy require so the module stays importable under the tsx test runner
  // without ./supabase's env requirements (same reason as outbox.ts sb()).
  const mod = require('./supabase') as {
    supabase: {
      storage: {
        from(bucket: string): {
          remove(
            paths: string[],
          ): Promise<{ error: { message?: string } | null }>;
        };
      };
      from(table: string): {
        delete(): {
          eq(
            col: string,
            val: string,
          ): Promise<{ error: { message?: string } | null }>;
        };
      };
    };
    getUserId(): Promise<string | null>;
  };
  adapter = {
    getUserId: () => mod.getUserId(),
    purgeOutbox: (swingId) => purgeOutboxEntriesForSwing(swingId),
    async removeVideo(storagePath) {
      const { error } = await mod.supabase.storage
        .from('swing-videos')
        .remove([storagePath]);
      return { error: error ?? null };
    },
    async deleteRow(swingId) {
      const { error } = await mod.supabase
        .from('swings')
        .delete()
        .eq('id', swingId);
      return { error: error ?? null };
    },
  };
  return adapter;
}

/**
 * Delete one swing everywhere it lives: queued outbox entries, the storage
 * video, and the swings row (motion_frames/swing_debug/pose_full are inline
 * JSONB columns — they die with the row; no child tables reference swings).
 * Returns true on success, false on any failure (logged) — callers use the
 * boolean to revert optimistic UI. Does not throw.
 *
 * Order is load-bearing:
 * 1. Outbox purge FIRST — a queued video entry would otherwise re-upload the
 *    object after step 2 and, once the row is gone, dead-letter as
 *    'zero_rows' with spurious telemetry. (An upload already in flight when
 *    this runs can still strand one object — accepted; the account wipe's
 *    prefix removal cleans it up.)
 * 2. Storage remove on the DERIVED path, not swings.video_storage_path: the
 *    column is null while upload is pending/failed even though the object may
 *    exist. The format is pinned to its single write-site, outbox.ts
 *    runVideoUpload (`${userId}/${swingId}.mov`). Removing a missing object
 *    is not an error; a real storage error is tolerated (worst case one
 *    orphan object) — the row delete alone decides success.
 * 3. Row delete last; RLS scopes it to the owner.
 */
export async function deleteSwing(swingId: string): Promise<boolean> {
  try {
    const a = resolveAdapter();
    const userId = await a.getUserId();
    if (!userId) return false;

    await a.purgeOutbox(swingId);

    const removal = await a.removeVideo(`${userId}/${swingId}.mov`);
    if (removal.error) {
      console.warn(
        '[HoneySwing] deleteSwing storage remove failed (continuing):',
        removal.error.message,
      );
    }

    const del = await a.deleteRow(swingId);
    if (del.error) {
      console.error('[HoneySwing] deleteSwing error:', del.error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[HoneySwing] deleteSwing error:', err);
    return false;
  }
}

export function __setAdapterForTesting(a: DeleteSwingAdapter | null): void {
  adapter = a;
}
