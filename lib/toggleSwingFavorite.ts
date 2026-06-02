import { supabase } from './supabase';

/**
 * Set the is_favorite flag on a swing. Scopes by id; RLS additionally ensures
 * the caller can only update their own swings. Returns true on success, false
 * on any DB error (logged) — callers use the boolean to revert optimistic UI.
 * Does not throw.
 */
export async function toggleSwingFavorite(
  swingId: string,
  isFavorite: boolean,
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('swings')
      .update({ is_favorite: isFavorite })
      .eq('id', swingId);
    if (error) {
      console.error('[HoneySwing] toggleSwingFavorite error:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[HoneySwing] toggleSwingFavorite error:', err);
    return false;
  }
}
