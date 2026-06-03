// lib/ensureProfile.ts
import { supabase } from './supabase';

/**
 * Ensure a `profiles` row exists for this user. Returns true on success so
 * callers (e.g. persistSwing's #9 self-heal) can decide whether to retry a
 * dependent write. The swings.user_id -> profiles.id FK requires this row to
 * exist before any swing insert.
 */
export async function ensureProfile(userId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('profiles')
      .upsert({ id: userId }, { onConflict: 'id', ignoreDuplicates: true });

    if (error) {
      console.error('[HoneySwing] ensureProfile error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[HoneySwing] ensureProfile threw:', err);
    return false;
  }
}
