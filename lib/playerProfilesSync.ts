/**
 * playerProfilesSync.ts — device→server sync of kid profiles into
 * public.player_profiles (coach pivot Phase 2). Device is the source of truth
 * for profile CONTENT (name/handedness/age tier); profile IDENTITY (id)
 * reconciles server-wins at sign-in when the server id owns swings and the
 * local id owns none — a bounded exception to last-push-wins added for the
 * reinstall bug (re-minted local ids orphaned every swing's
 * player_profile_id; see playerProfilesReconcile.ts). Multi-device: a device
 * still pushing stale duplicate ids re-creates rows that own no swings, and
 * converges to the swing-owning ids on its own next sign-in reconcile.
 *
 * Every function is fire-and-forget safe: signed-out calls no-op, errors are
 * logged and swallowed, nothing throws.
 */

import { supabase, getUserId } from './supabase';
import { ensureProfile } from './ensureProfile';
import type { PlayerProfile } from './playerProfiles';
import { toPlayerProfileRow, pushKey } from './playerProfilesSyncCore';

// Set only on push SUCCESS, so a failed push leaves the key stale and the next
// mutation retries. Skips network entirely for payload-identical saves
// (nickname keystrokes, primary switches — neither field is synced).
let lastPushedKey: string | null = null;

export async function pushProfiles(profiles: PlayerProfile[]): Promise<void> {
  try {
    const userId = await getUserId();
    if (!userId) return;
    const key = pushKey(userId, profiles);
    if (key === lastPushedKey) return;
    const nowIso = new Date().toISOString();
    const rows = profiles.map((p) => toPlayerProfileRow(p, userId, nowIso));
    let { error } = await supabase
      .from('player_profiles')
      .upsert(rows, { onConflict: 'id' });
    if (error && error.code === '23503') {
      // Signed-in account with no profiles row yet (pre-first-swing) — same
      // self-heal + single retry as persistSwing's 23503 path.
      const healed = await ensureProfile(userId);
      if (healed) {
        ({ error } = await supabase
          .from('player_profiles')
          .upsert(rows, { onConflict: 'id' }));
      }
    }
    if (error) {
      console.warn('[HoneySwing] pushProfiles error:', error.message);
      return;
    }
    lastPushedKey = key;
  } catch (err) {
    console.warn('[HoneySwing] pushProfiles error:', err);
  }
}

export async function deleteRemoteProfile(id: string): Promise<void> {
  try {
    const userId = await getUserId();
    if (!userId) return;
    const { error } = await supabase.from('player_profiles').delete().eq('id', id);
    if (error) console.warn('[HoneySwing] deleteRemoteProfile error:', error.message);
  } catch (err) {
    console.warn('[HoneySwing] deleteRemoteProfile error:', err);
  }
}

// One-shot app-start backfill (retro-labels historical swings on existing
// devices). A signed-out call does NOT burn the shot — it retries on the next
// call after sign-in.
let pushedOnce = false;

export async function pushProfilesOnce(profiles: PlayerProfile[]): Promise<void> {
  if (pushedOnce) return;
  try {
    const userId = await getUserId();
    if (!userId) return;
    pushedOnce = true;
    await pushProfiles(profiles);
  } catch (err) {
    console.warn('[HoneySwing] pushProfilesOnce error:', err);
  }
}
