import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './storageKeys';

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
  const profile: PlayerProfile = {
    id: Date.now().toString() + Math.random().toString(36).slice(2),
    name: trimmed,
    isLeftHanded,
    createdAt: Date.now(),
  };
  const existing = await getProfiles();
  await saveProfiles([...existing, profile]);
  return profile;
}

export async function deleteProfile(id: string): Promise<void> {
  const existing = await getProfiles();
  await saveProfiles(existing.filter((p) => p.id !== id));
  const active = await getActiveProfileId();
  if (active === id) await setActiveProfileId(null);
}

export async function getActiveProfileId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(STORAGE_KEYS.activeProfileId);
  } catch {
    return null;
  }
}

export async function setActiveProfileId(id: string | null): Promise<void> {
  try {
    if (id === null) await AsyncStorage.removeItem(STORAGE_KEYS.activeProfileId);
    else await AsyncStorage.setItem(STORAGE_KEYS.activeProfileId, id);
  } catch (err) {
    console.error('[HoneySwing]', err);
  }
}

export async function getActiveProfile(): Promise<PlayerProfile | null> {
  const id = await getActiveProfileId();
  if (!id) return null;
  const profiles = await getProfiles();
  return profiles.find((p) => p.id === id) ?? null;
}

export async function setPrimaryProfile(id: string): Promise<void> {
  const existing = await getProfiles();
  const updated = existing.map((p) => ({ ...p, isPrimary: p.id === id }));
  await saveProfiles(updated);
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
