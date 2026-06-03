/**
 * headerIdentity.ts — Pure resolver for the result-screen header's "<name>'s Swing".
 *
 * A swing's header identity is governed by the swing's OWN attribution
 * (player_profile_id), NOT by whoever is the current primary profile. This
 * exists to kill the silent-wrong-attribution bug: opening kid A's swing while
 * kid B is primary must never render "B's Swing".
 *
 * Rules (do NOT collapse these into one fallback):
 *   - Row not loaded yet → caller's supplied fallback only.
 *   - Row loaded, player_profile_id resolvable in local profiles → that profile.
 *   - Row loaded, attribution null OR profile deleted/unresolvable → null
 *     (header renders neutral "Your Swing"). NEVER substitute another profile.
 *
 * Pure + type-only imports so it runs under the plain tsx test runner.
 */
import type { SwingRecord } from './swingStore';
import type { PlayerProfile } from './playerProfiles';

export function resolveHeaderProfile(
  swingRecord: SwingRecord | null,
  profiles: PlayerProfile[],
  activeProfile: PlayerProfile | null,
  isRowLoaded: boolean,
): PlayerProfile | null {
  if (!isRowLoaded) return activeProfile;
  const id = swingRecord?.player_profile_id;
  if (!id) return null;
  return profiles.find((p) => p.id === id) ?? null;
}
