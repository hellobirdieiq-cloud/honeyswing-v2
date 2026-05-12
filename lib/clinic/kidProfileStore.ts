import type { KidProfile } from '@/packages/domain/clinic/KidProfile';

const profiles = new Map<string, KidProfile>();

// Returns a kid profile by id, or null if not found.
export function getKidProfile(id: string): KidProfile | null {
  // stub
  throw new Error('Not implemented');
}

// Inserts or replaces a kid profile in the store.
export function upsertKidProfile(profile: KidProfile): void {
  // stub
  throw new Error('Not implemented');
}

// Returns all kid profiles currently in the store.
export function listKidProfiles(): KidProfile[] {
  // stub
  throw new Error('Not implemented');
}

// Removes a kid profile by id; no-op when not present.
export function removeKidProfile(id: string): void {
  // stub
  throw new Error('Not implemented');
}

// Clears all profiles from the store (test/debug only).
export function clearKidProfiles(): void {
  // stub
  throw new Error('Not implemented');
}
