import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './storageKeys';
import { clearCurrentSwingMotion } from './swingMotionStore';
import { applyAgeTier, getAgeTier, type AgeTier } from './ageTier';

export type PlayerProfile = {
  id: string;
  name: string;
  isLeftHanded: boolean;
  createdAt: number;
  isPrimary?: boolean;
  nickname?: string;
  // Per-player age tier. Optional only for type-compat with old stored rows;
  // addProfile stamps it and getProfiles backfills legacy rows, so runtime
  // profiles always carry one.
  ageTier?: AgeTier;
};

// POST-CLINIC TODO: sync profiles to Supabase when signed in

export async function getProfiles(): Promise<PlayerProfile[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.playerProfiles);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    let profiles = parsed as PlayerProfile[];
    // One-time migration: stamp age-less legacy profiles with the current global
    // tier (their effective tier today) so the active-player mirror never drifts.
    if (profiles.some((p) => p.ageTier === undefined)) {
      const tier = await getAgeTier();
      profiles = profiles.map((p) => (p.ageTier === undefined ? { ...p, ageTier: tier } : p));
      await saveProfiles(profiles);
    }
    return profiles;
  } catch {
    return [];
  }
}

export async function saveProfiles(profiles: PlayerProfile[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEYS.playerProfiles, JSON.stringify(profiles));
  } catch (err) {
    console.error('[HoneySwing]', err);
  }
}

export async function addProfile(name: string, isLeftHanded: boolean): Promise<PlayerProfile> {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('Profile name required');
  const existing = await getProfiles();
  const profile: PlayerProfile = {
    id: Date.now().toString() + Math.random().toString(36).slice(2),
    name: trimmed,
    isLeftHanded,
    createdAt: Date.now(),
    // The first profile created becomes primary so swings always have a kid to
    // attribute to (getPrimaryProfile never returns null once a profile exists).
    isPrimary: existing.length === 0,
    // Default the new player's tier to the current global so no profile is ever
    // age-less (mirror-drift guard); editable per-player in Settings.
    ageTier: await getAgeTier(),
  };
  await saveProfiles([...existing, profile]);
  return profile;
}

/**
 * Seed a local primary profile if none exists yet, so the Record tab always has a
 * kid to attribute a swing to — useSwingCapture hard-blocks recording without one
 * (ce8fd1f). No-op when a profile already exists. `resolveName` supplies a display
 * name (e.g. the onboarding name from Supabase) and is only invoked when a seed is
 * actually needed; falls back to "Me" when it yields nothing. Handedness comes from
 * the onboarding-stored flag. Idempotent.
 */
export async function ensureLocalPrimaryProfile(
  resolveName: () => Promise<string | null | undefined>,
): Promise<PlayerProfile | null> {
  const existing = await getProfiles();
  if (existing.length > 0) return null;
  let name = '';
  try {
    name = (await resolveName())?.trim() ?? '';
  } catch {
    name = '';
  }
  if (name === '') name = 'Me';
  const isLeftHanded =
    (await AsyncStorage.getItem(STORAGE_KEYS.isLeftHanded)) === 'true';
  return addProfile(name, isLeftHanded);
}

export async function deleteProfile(id: string): Promise<void> {
  const existing = await getProfiles();
  const remaining = existing.filter((p) => p.id !== id);
  // If we deleted the primary and others remain, promote one so there is always
  // exactly one primary to attribute swings to.
  const deletedWasPrimary = existing.find((p) => p.id === id)?.isPrimary === true;
  if (deletedWasPrimary && remaining.length > 0 && !remaining.some((p) => p.isPrimary)) {
    remaining[0] = { ...remaining[0], isPrimary: true };
  }
  await saveProfiles(remaining);
  const promoted = remaining.find((p) => p.isPrimary);
  if (deletedWasPrimary && promoted?.ageTier) {
    await applyAgeTier(promoted.ageTier);
  }
}

export async function setPrimaryProfile(id: string): Promise<void> {
  const existing = await getProfiles();
  const updated = existing.map((p) => ({ ...p, isPrimary: p.id === id }));
  await saveProfiles(updated);
  // Keep the global age-tier mirror (honeyswing:ageTier key + sync cache +
  // tip-frequency limiter) pointed at the active player, so downstream readers
  // (persistSwing, computeFocus, VisualCoachCard, sessionAccumulator) stay
  // unchanged. Profiles without an ageTier inherit whatever the mirror holds.
  const newPrimary = updated.find((p) => p.id === id);
  if (newPrimary?.ageTier) {
    await applyAgeTier(newPrimary.ageTier);
  }
  // Invalidate the in-memory "current swing" singleton on every profile switch.
  // It survives navigation (module-level, not zustand/context) and the viewer
  // (app/analysis/result.tsx) renders it whenever isLiveSwing is true — so a
  // switch without clearing leaves the previous kid's video + wrong-handedness
  // skeleton on screen until an app reload. Clearing forces the viewer back to
  // the authoritative per-swing DB load.
  clearCurrentSwingMotion();
}

export async function getPrimaryProfile(): Promise<PlayerProfile | null> {
  const profiles = await getProfiles();
  const primary = profiles.find((p) => p.isPrimary === true);
  if (primary) return primary;
  if (profiles.length > 0) return profiles[0];
  return null;
}

export function getDisplayName(p: PlayerProfile): string {
  if (p.nickname && p.nickname.trim() !== '') return p.nickname.slice(0, 7);
  return p.name.slice(0, 7);
}
