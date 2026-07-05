/**
 * coachData.ts — networked fetchers for the coach view (coach pivot Phase 3).
 *
 * Scoping model: RLS returns own rows PLUS coach-granted rows (attribution
 * join, migration 20260705020334). Excluding own rows via .neq('user_id', me)
 * leaves exactly the linked accounts' data — the mirror-image of swingStore's
 * documented own-only .eq scoping (swingStore.ts fetchGripHistory comment).
 *
 * Tolerance matches swingStore: errors are logged and empty results returned;
 * nothing throws.
 */

import { supabase, getUserId } from './supabase';
import { SWING_HISTORY_COLUMNS, type SwingHistoryRecord } from './swingStore';
import type { CoachKid } from './coachDataCore';

// EXTERNAL ASSUMPTION: 200 swings is enough for a v1 coach feed — roughly a
// season of weekly lessons across a small roster. There is NO pagination; the
// 201st-newest linked swing silently drops off. Revisit (paginate or raise)
// when a real coach approaches this volume.
export const COACH_SWINGS_FETCH_LIMIT = 200;

export type CoachSelf = { name: string; code: string };

/** The signed-in user's own coaches row; null = not a coach (or signed out). */
export async function getCoachSelf(): Promise<CoachSelf | null> {
  try {
    const userId = await getUserId();
    if (!userId) return null;
    const { data, error } = await supabase
      .from('coaches')
      .select('name, code')
      .eq('auth_user_id', userId)
      .maybeSingle();
    if (error) {
      console.error('[HoneySwing] getCoachSelf error:', error.message);
      return null;
    }
    return data ?? null;
  } catch (err) {
    console.error('[HoneySwing] getCoachSelf error:', err);
    return null;
  }
}

/** Linked kids: coach-granted player_profiles rows, own account excluded. */
export async function getCoachRoster(): Promise<CoachKid[]> {
  try {
    const userId = await getUserId();
    if (!userId) return [];
    const { data, error } = await supabase
      .from('player_profiles')
      .select('id, display_name, age_tier, is_left_handed, user_id')
      .neq('user_id', userId)
      .order('display_name', { ascending: true });
    if (error) {
      console.error('[HoneySwing] getCoachRoster error:', error.message);
      return [];
    }
    return data ?? [];
  } catch (err) {
    console.error('[HoneySwing] getCoachRoster error:', err);
    return [];
  }
}

/** Linked accounts' swings, newest first, compact projection. */
export async function getCoachSwings(): Promise<SwingHistoryRecord[]> {
  try {
    const userId = await getUserId();
    if (!userId) return [];
    const { data, error } = await supabase
      .from('swings')
      .select(SWING_HISTORY_COLUMNS)
      .neq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(COACH_SWINGS_FETCH_LIMIT);
    if (error) {
      console.error('[HoneySwing] getCoachSwings error:', error.message);
      return [];
    }
    return (data as SwingHistoryRecord[] | null) ?? [];
  } catch (err) {
    console.error('[HoneySwing] getCoachSwings error:', err);
    return [];
  }
}
