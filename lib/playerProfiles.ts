import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './storageKeys';
import { clearCurrentSwingMotion } from './swingMotionStore';

export type PlayerProfile = {
  id: string;
  name: string;
  isLeftHanded: boolean;
  createdAt: number;
  isPrimary?: boolean;
  nickname?: string;
};

// POST-CLINIC TODO: sync profiles to Supabase when signed in

export async function getProfiles(): Promise<PlayerProfile[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.playerProfiles);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PlayerProfile[]) : [];
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
  };
  await saveProfiles([...existing, profile]);
  return profile;
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
}

export async function setPrimaryProfile(id: string): Promise<void> {
  const existing = await getProfiles();
  const updated = existing.map((p) => ({ ...p, isPrimary: p.id === id }));
  await saveProfiles(updated);
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
  if (p.nickname && p.nickname.trim() !== '') return p.nickname;
  return p.name.slice(0, 7);
}
