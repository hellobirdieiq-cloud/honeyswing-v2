import type { KidProfile } from '@/packages/domain/clinic/KidProfile';

const profiles = new Map<string, KidProfile>();

// Returns a kid profile by id, or null if not found.
export function getKidProfile(id: string): KidProfile | null {
  return profiles.get(id) ?? null;
}

// Inserts or replaces a kid profile in the store.
export function upsertKidProfile(profile: KidProfile): void {
  profiles.set(profile.id, profile);
}

// Returns all kid profiles currently in the store.
export function listKidProfiles(): KidProfile[] {
  return Array.from(profiles.values());
}

// Removes a kid profile by id; no-op when not present.
export function removeKidProfile(id: string): void {
  profiles.delete(id);
}

// Clears all profiles from the store (test/debug only).
export function clearKidProfiles(): void {
  console.warn('[kidProfileStore] clearKidProfiles called — test/debug only');
  profiles.clear();
}
