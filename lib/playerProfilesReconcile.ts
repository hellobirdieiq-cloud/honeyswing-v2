import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, getUserId } from './supabase';
import { STORAGE_KEYS } from './storageKeys';
import { getProfiles, saveProfiles, type PlayerProfile } from './playerProfiles';
import { deleteRemoteProfile } from './playerProfilesSync';

/**
 * Sign-in profile reconcile (reinstall fix): local profile ids are minted on
 * device and the sync is push-only, so a reinstall re-mints NEW ids for the
 * same kids — the history filter (swings.player_profile_id === local id) then
 * matches nothing and duplicate server rows accumulate. This module runs at
 * sign-in, BEFORE retroPersistHeldSwings, and:
 *
 *   ADOPTION — for each local profile whose display_name matches a server row
 *   that OWNS swings while the local id owns none, adopt the server id in
 *   place (isPrimary/nickname/ageTier untouched), record oldId→serverId in
 *   STORAGE_KEYS.profileIdAdoptions (consumed by held-swing remap), and
 *   delete the abandoned 0-swing duplicate row remotely.
 *
 *   PULL-ON-EMPTY — a truly fresh device (no local profiles yet) materializes
 *   local profiles directly from the server rows, ids preserved.
 *
 * Bounded, deliberate exception to the one-way-push contract (see
 * playerProfilesSync.ts header): server wins for swing-owning IDENTITY at
 * sign-in; device stays the source of truth for content. Every failure path
 * leaves local state untouched (fire-and-forget discipline, nothing throws).
 * Ambiguous cases (both ids own swings, e.g. two kids sharing a name) are
 * logged and skipped — resolvable manually via the swing Move action.
 *
 * Lives in its own module: playerProfiles.ts already value-imports
 * playerProfilesSync.ts, so hosting this in either would create a runtime
 * import cycle.
 */

type ServerProfileRow = {
  id: string;
  display_name: string;
  is_left_handed: boolean | null;
  age_tier: string | null;
  created_at: string | null;
  updated_at: string | null;
};

let inFlight = false;

async function swingCount(playerProfileId: string): Promise<number> {
  const { count, error } = await supabase
    .from('swings')
    .select('id', { count: 'exact', head: true })
    .eq('player_profile_id', playerProfileId);
  if (error) throw new Error(`swing count failed: ${error.message}`);
  return count ?? 0;
}

/** Adoption map (oldLocalId -> serverId), for held-swing remap. */
export async function getProfileIdAdoptions(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.profileIdAdoptions);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function appendAdoptions(newEntries: Record<string, string>): Promise<void> {
  const existing = await getProfileIdAdoptions();
  await AsyncStorage.setItem(
    STORAGE_KEYS.profileIdAdoptions,
    JSON.stringify({ ...existing, ...newEntries }),
  );
}

export async function reconcileProfilesFromServer(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const userId = await getUserId();
    if (!userId) return;

    const { data, error } = await supabase
      .from('player_profiles')
      .select('id, display_name, is_left_handed, age_tier, created_at, updated_at')
      .eq('user_id', userId);
    if (error) {
      console.warn('[profileReconcile] server fetch failed:', error.message);
      return;
    }
    const server = (data ?? []) as ServerProfileRow[];
    if (server.length === 0) return; // nothing server-side to reconcile against

    const local = await getProfiles();

    // PULL-ON-EMPTY: fresh device, restore server identities wholesale.
    if (local.length === 0) {
      const restored: PlayerProfile[] = server.map((s, i) => ({
        id: s.id,
        name: s.display_name,
        isLeftHanded: s.is_left_handed ?? false,
        createdAt: s.created_at ? Date.parse(s.created_at) : Date.now(),
        isPrimary: i === 0,
        ageTier: (s.age_tier ?? undefined) as PlayerProfile['ageTier'],
      }));
      await saveProfiles(restored);
      console.log(`[profileReconcile] restored ${restored.length} profile(s) from server`);
      return;
    }

    // ADOPTION: swap local ids onto swing-owning server identities by name.
    const counts = new Map<string, number>();
    const countFor = async (id: string): Promise<number> => {
      if (!counts.has(id)) counts.set(id, await swingCount(id));
      return counts.get(id)!;
    };

    const adoptions: Record<string, string> = {};
    const abandoned: string[] = [];
    for (const L of local) {
      const candidates = server.filter((s) => s.display_name === L.name.trim());
      if (candidates.length === 0) continue; // local-only name — push handles it
      let best: ServerProfileRow | null = null;
      let bestCount = -1;
      for (const c of candidates) {
        const n = await countFor(c.id);
        if (
          n > bestCount ||
          (n === bestCount &&
            best !== null &&
            Date.parse(c.updated_at ?? '') > Date.parse(best.updated_at ?? ''))
        ) {
          best = c;
          bestCount = n;
        }
      }
      if (!best || best.id === L.id) continue; // consistent already
      const localOwns = await countFor(L.id);
      if (bestCount >= 1 && localOwns === 0) {
        adoptions[L.id] = best.id;
        abandoned.push(L.id);
        L.id = best.id; // in place — isPrimary/nickname/ageTier preserved
      } else if (bestCount >= 1 && localOwns >= 1) {
        console.warn('[profileReconcile] ambiguous (both ids own swings), skipping', {
          name: L.name,
          localId: L.id,
          serverId: best.id,
        });
      }
    }

    if (Object.keys(adoptions).length === 0) return;

    await saveProfiles(local); // persists adopted ids + pushes (updates server rows)
    await appendAdoptions(adoptions);
    // Self-clean the abandoned 0-swing duplicates server-side (guarded above:
    // an adopted local id owned zero swings by definition of the rule).
    for (const oldId of abandoned) {
      if (server.some((s) => s.id === oldId)) {
        await deleteRemoteProfile(oldId);
      }
    }
    console.log('[profileReconcile] adopted server profile id(s)', adoptions);
  } catch (err) {
    console.warn('[profileReconcile] failed (local state untouched):', err);
  } finally {
    inFlight = false;
  }
}
