import { supabase } from './supabase';

/**
 * Move a swing to a different player profile. RLS: "Users can update own
 * swings" (USING + WITH CHECK on auth.jwt sub = user_id, migration
 * 20260417061320:88-90) — player_profile_id updates never touch user_id, so
 * the owning user always passes. Also the manual resolution path for legacy
 * swings whose player_profile_id is null or references a pre-coach-pivot id.
 */
export async function reassignSwing(
  swingId: string,
  playerProfileId: string,
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('swings')
      .update({ player_profile_id: playerProfileId })
      .eq('id', swingId);
    if (error) {
      console.warn('[reassignSwing] update failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[reassignSwing] update failed:', err);
    return false;
  }
}
