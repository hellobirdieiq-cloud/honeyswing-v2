/**
 * accountLifecycle.ts — account-deletion teardown, extracted VERBATIM from
 * settings.tsx (Batch 5.3). The purge list is the contract: every local key
 * that must not survive an account deletion. accountLifecycle.test.ts pins it —
 * losing a key here silently leaks the previous account's state into the next.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './storageKeys';

// Lazy require for ./supabase — it transitively loads @clerk/expo which can't
// run under the plain tsx test runner. Matches lib/swingStore.ts:21.
declare function require(id: string): unknown;

/** Local state purged on account deletion. Additions need a matching test pin. */
export const ACCOUNT_PURGE_KEYS: readonly string[] = [
  STORAGE_KEYS.onboardingComplete,
  STORAGE_KEYS.profileId,
  STORAGE_KEYS.isLeftHanded,
  STORAGE_KEYS.coachCode,
  STORAGE_KEYS.pendingReferralCode,
  STORAGE_KEYS.subscriptionStatus,
  STORAGE_KEYS.ageTier,
];

/**
 * Server-side account delete, then local purge. Ordering preserved from the
 * original handler: the server delete must succeed before local state is
 * dropped (a failed delete keeps the session's local state intact).
 * Navigation stays with the caller.
 */
export async function deleteAccountAndPurgeLocal(): Promise<void> {
  const { deleteAccount } = require('./supabase') as { deleteAccount: () => Promise<void> };
  await deleteAccount();
  await AsyncStorage.multiRemove([...ACCOUNT_PURGE_KEYS]);
}
