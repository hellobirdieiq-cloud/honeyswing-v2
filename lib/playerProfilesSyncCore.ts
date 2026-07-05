/**
 * playerProfilesSyncCore.ts — pure mapping/dedupe helpers for the device→server
 * kid-profile sync. No React Native or network imports so tests run under node
 * (the RN-touching push/delete functions live in playerProfilesSync.ts).
 *
 * PII posture (coach pivot): display_name / handedness / coarse age_tier only.
 * Nickname and isPrimary are deliberately NOT synced — they are local display
 * concerns, which is also why pushKey excludes them: a nickname keystroke or a
 * primary-switch re-save maps to an identical payload and is skipped.
 */

import type { PlayerProfile } from './playerProfiles';
import type { Database } from './database.types';

export type PlayerProfileRow = Database['public']['Tables']['player_profiles']['Insert'];

export function toPlayerProfileRow(
  p: PlayerProfile,
  userId: string,
  updatedAtIso: string,
): PlayerProfileRow {
  return {
    id: p.id,
    user_id: userId,
    display_name: p.name,
    is_left_handed: p.isLeftHanded,
    age_tier: p.ageTier ?? null,
    // Preserve the true local creation instant (server default would stamp
    // first-sync time, misdating backfilled profiles).
    created_at: new Date(p.createdAt).toISOString(),
    // Set explicitly: the server default only fires on insert, not upsert-update.
    updated_at: updatedAtIso,
  };
}

/**
 * Identity of a push payload for skip-if-unchanged dedupe. Excludes updated_at
 * (changes every call) and any unsynced field; includes userId so an account
 * switch on the same device never skips.
 */
export function pushKey(userId: string, profiles: PlayerProfile[]): string {
  return JSON.stringify([
    userId,
    profiles.map((p) => [p.id, p.name, p.isLeftHanded, p.ageTier ?? null]),
  ]);
}
