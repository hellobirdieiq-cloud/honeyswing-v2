/**
 * coachDataCore.ts — pure helpers for the coach view (coach pivot Phase 3).
 * No React Native or network imports so tests run under node; the networked
 * fetchers live in coachData.ts (same split as playerProfilesSyncCore).
 */

import type { SwingHistoryRecord } from './swingStore';

/** Roster row shape the coach view needs (subset of player_profiles). */
export type CoachKid = {
  id: string;
  display_name: string;
  age_tier: string | null;
  is_left_handed: boolean;
  user_id: string;
};

/** Label shown for swings whose player_profile_id is unsynced/deleted/null. */
export const UNKNOWN_PLAYER_LABEL = 'Player';

/** Chip id for the orphaned-swings bucket (must not collide with profile ids). */
export const UNKNOWN_TAB_ID = '__unknown__';

export function buildKidLabelMap(roster: CoachKid[]): Record<string, string> {
  return Object.fromEntries(roster.map((k) => [k.id, k.display_name]));
}

export function resolveKidLabel(
  labelMap: Record<string, string>,
  playerProfileId: string | null,
): string {
  if (playerProfileId && labelMap[playerProfileId]) return labelMap[playerProfileId];
  return UNKNOWN_PLAYER_LABEL;
}

/** True when any swing has no resolvable kid (drives the "Player" chip). */
export function hasOrphanSwings(
  swings: SwingHistoryRecord[],
  labelMap: Record<string, string>,
): boolean {
  return swings.some((s) => !s.player_profile_id || !labelMap[s.player_profile_id]);
}

export function filterSwingsForTab(
  swings: SwingHistoryRecord[],
  labelMap: Record<string, string>,
  tabId: string,
): SwingHistoryRecord[] {
  if (tabId === 'all') return swings;
  if (tabId === UNKNOWN_TAB_ID) {
    return swings.filter((s) => !s.player_profile_id || !labelMap[s.player_profile_id]);
  }
  return swings.filter((s) => s.player_profile_id === tabId);
}
