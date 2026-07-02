/**
 * accountLifecycle.test.ts — Batch 5.3 validation
 *
 * Run with: npx tsx lib/accountLifecycle.test.ts
 *
 * Pins the ACCOUNT_PURGE_KEYS contract: exactly which local keys are wiped on
 * account deletion, resolved against STORAGE_KEYS values. A key silently
 * dropped from this list leaks the previous account's state into the next
 * session. deleteAccountAndPurgeLocal itself is supabase-bound (lazy-required)
 * and verified on-device, not here.
 */

import { ACCOUNT_PURGE_KEYS } from './accountLifecycle';
import { STORAGE_KEYS } from './storageKeys';

let passed = 0;
let failed = 0;

function group(name: string): void {
  console.log(`\n── ${name} ──`);
}

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

group('purge list membership (the 7 keys, exact)');
const EXPECTED = [
  STORAGE_KEYS.onboardingComplete,
  STORAGE_KEYS.profileId,
  STORAGE_KEYS.isLeftHanded,
  STORAGE_KEYS.coachCode,
  STORAGE_KEYS.pendingReferralCode,
  STORAGE_KEYS.subscriptionStatus,
  STORAGE_KEYS.ageTier,
];
assert(ACCOUNT_PURGE_KEYS.length === 7, `exactly 7 keys (got ${ACCOUNT_PURGE_KEYS.length})`);
for (const key of EXPECTED) {
  assert(ACCOUNT_PURGE_KEYS.includes(key), `includes ${key}`);
}

group('key values are real AsyncStorage keys');
for (const key of ACCOUNT_PURGE_KEYS) {
  assert(typeof key === 'string' && key.length > 0, `${key} is a non-empty string`);
}
assert(new Set(ACCOUNT_PURGE_KEYS).size === ACCOUNT_PURGE_KEYS.length, 'no duplicate keys');

group('deliberately NOT purged (survives account deletion)');
assert(!ACCOUNT_PURGE_KEYS.includes(STORAGE_KEYS.todaysFocus), 'todaysFocus not purged (device-local, not account-scoped)');

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All tests passed — account purge contract pinned');
}
