import type { PostgrestError } from '@supabase/supabase-js';
import { supabase, getUserId } from './supabase';
import { ensureProfile } from './ensureProfile';
import { decrementLocalSwingCount } from './swingLimit';
import type { Database } from './database.types';
import {
  listHeldSwings,
  writeHeldRecord,
  deleteHeldRow,
  deadLetterHeldTriple,
  attachSwingId,
  registerHeldRetroHook,
  type HeldSwingRecord,
} from './outbox';

/**
 * Queue-until-login Phase 4: retroactively persist held signed-out swings
 * under the now-signed-in user. Re-entrant and idempotent — safe to call from
 * every trigger (AuthListener sign-in / cold-start, outbox foreground /
 * reconnect edges); overlapping calls no-op on the in-flight flag.
 *
 * Per record, oldest-first: insert {...row, user_id, id: insertId} with the
 * Clerk JWT → attach the video/pose entries (the existing drain uploads from
 * there) → delete the held-row JSON → decrement the local anon counter.
 *
 * Idempotency: insertId is a stable uuid persisted IN the held record, so a
 * crash-retry re-inserts the same PK and 23505 is treated as already-inserted
 * (proceed to attach/cleanup). The counter DECREMENT is keyed off successful
 * held-row deletion — a crash before deletion re-runs the whole path once
 * (23505), a crash in the milliseconds between deletion and decrement leaves
 * the count 1 too high (accepted residual, documented in the design study).
 *
 * Failure semantics: network/unknown errors leave records HELD and stop the
 * loop (later records would fail identically; the next trigger retries).
 * Schema-shaped errors dead-letter the triple as 'held_schema_drift' —
 * a row that predates the current schema can never insert; don't retry
 * forever.
 */

// Insert-error codes that mean "this row can NEVER insert against the current
// schema": PGRST204 (column missing from schema cache), 42703 (undefined
// column), 22P02 (invalid literal for column type, e.g. a pre-insertId legacy
// id that is not a uuid).
const SCHEMA_DRIFT_CODES = new Set(['PGRST204', '42703', '22P02']);

let inFlight = false;

type InsertResult = { ok: boolean; code: string | null; message: string | null };

async function insertHeld(
  rec: HeldSwingRecord,
  userId: string,
  insertId: string,
): Promise<InsertResult> {
  const row = {
    ...rec.row,
    user_id: userId,
    id: insertId,
  } as Database['public']['Tables']['swings']['Insert'];
  try {
    const { error } = await supabase.from('swings').insert(row);
    if (!error) return { ok: true, code: null, message: null };
    return { ok: false, code: error.code ?? null, message: error.message ?? null };
  } catch (err) {
    const pg = err as Partial<PostgrestError>;
    return {
      ok: false,
      code: typeof pg?.code === 'string' ? pg.code : null,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** rec.insertId, or backfill a uuid and REWRITE the record to disk before the
 *  first insert attempt — the id must be stable across crash-retries. */
async function resolveInsertId(rec: HeldSwingRecord): Promise<string> {
  if (rec.insertId) return rec.insertId;
  const insertId = uuidv4();
  await writeHeldRecord({ ...rec, insertId });
  return insertId;
}

/** RFC-4122-shaped v4 uuid (idempotency key, not security). */
function uuidv4(): string {
  let out = '';
  for (const ch of 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx') {
    if (ch === 'x') out += Math.floor(Math.random() * 16).toString(16);
    else if (ch === 'y') out += (8 + Math.floor(Math.random() * 4)).toString(16);
    else out += ch;
  }
  return out;
}

export async function retroPersistHeldSwings(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const userId = await getUserId();
    if (!userId) return;
    const records = (await listHeldSwings()).sort(
      (a, b) => Date.parse(a.capturedAtIso) - Date.parse(b.capturedAtIso), // oldest first
    );
    if (records.length === 0) return;
    console.log(`[retroPersist] ${records.length} held swing(s) to persist`);

    let healedProfile = false;
    for (const rec of records) {
      const insertId = await resolveInsertId(rec);
      let res = await insertHeld(rec, userId, insertId);

      // FK race: profiles row missing for this session (failed/raced
      // ensureProfile at sign-in) — heal and retry exactly once, no loop.
      // player_profile_id carries NO FK (verified: 20260516000000 migration
      // adds a plain text column), so 23503 can only be user_id → profiles.
      if (!res.ok && res.code === '23503' && !healedProfile) {
        healedProfile = await ensureProfile(userId);
        if (healedProfile) res = await insertHeld(rec, userId, insertId);
      }

      if (res.ok || res.code === '23505') {
        // Inserted — or already inserted by a run that crashed before
        // cleanup. Attach is idempotent (patches only swingId:null metas,
        // no-ops on missing entries); deletion is idempotent.
        attachSwingId(
          [rec.videoEntryId, rec.poseEntryId].filter((x): x is string => x !== null),
          insertId,
        );
        await deleteHeldRow(rec.heldSwingId);
        await decrementLocalSwingCount(); // AFTER deletion — the dedupe key
        console.log('[retroPersist] persisted held swing', {
          heldSwingId: rec.heldSwingId,
          swingId: insertId,
          recovered: res.code === '23505',
        });
      } else if (res.code && SCHEMA_DRIFT_CODES.has(res.code)) {
        console.warn('[retroPersist] held row predates schema — dead-lettering', {
          heldSwingId: rec.heldSwingId,
          code: res.code,
          message: res.message,
        });
        await deadLetterHeldTriple(rec);
      } else {
        // Network/RLS/unknown: leave HELD, stop — the next trigger retries.
        console.warn('[retroPersist] insert failed, leaving held', {
          heldSwingId: rec.heldSwingId,
          code: res.code,
          message: res.message,
        });
        break;
      }
    }
  } finally {
    inFlight = false;
  }
}

// Register as the outbox's pre-drain hook (foreground/reconnect edges) at
// module load — app/_layout.tsx's static import makes this run on app mount.
// A direct outbox → this-module import would cycle; the seam avoids it.
registerHeldRetroHook(retroPersistHeldSwings);
