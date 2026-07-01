/**
 * ageTier.ts — Task 15: Age-Aware Tip Language
 *
 * Reads/writes the player's age tier from AsyncStorage.
 * Affects both tip frequency limits and tip language variants.
 *
 * Tiers:
 *   junior (6-8)  — simplest language, most conservative limits
 *   youth  (9-12) — default tier, current language
 *   teen   (13-17) — slightly more technical
 *   adult  (18+)  — full technical vocabulary
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './storageKeys';
import type { AgeTier } from '@/packages/domain/swing/tipFrequency';

export type { AgeTier } from '@/packages/domain/swing/tipFrequency';

const DEFAULT_TIER: AgeTier = 'youth';

let _cachedTier: AgeTier = DEFAULT_TIER;

/** Synchronous read of the cached age tier. Primed by getAgeTier() on app init. */
export function getCachedAgeTier(): AgeTier {
  return _cachedTier;
}

/** Test-only: directly set the cached tier without AsyncStorage. */
export function _resetCacheForTesting(tier: AgeTier): void {
  _cachedTier = tier;
}

export async function getAgeTier(): Promise<AgeTier> {
  const stored = await AsyncStorage.getItem(STORAGE_KEYS.ageTier);
  if (stored === 'junior' || stored === 'youth' || stored === 'teen' || stored === 'adult') {
    _cachedTier = stored;
    return stored;
  }
  _cachedTier = DEFAULT_TIER;
  return DEFAULT_TIER;
}

export async function setAgeTier(tier: AgeTier): Promise<void> {
  _cachedTier = tier;
  await AsyncStorage.setItem(STORAGE_KEYS.ageTier, tier);
}
