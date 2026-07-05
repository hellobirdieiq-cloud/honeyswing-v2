/**
 * playerProfilesSync.test.ts — coach pivot Phase 2
 *
 * Run with: npx tsx lib/playerProfilesSync.test.ts
 *
 * Tests the pure sync core (playerProfilesSyncCore.ts): row mapping and the
 * skip-if-unchanged push key. The networked push/delete paths (RN + Supabase
 * imports) are exercised on device, mirroring ageTier.test.ts's split.
 */

import { toPlayerProfileRow, pushKey } from './playerProfilesSyncCore';
import type { PlayerProfile } from './playerProfiles';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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

function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(
    actual === expected,
    `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_ISO = '2026-07-05T00:00:00.000Z';
const USER = 'user_test123';

function makeProfile(overrides: Partial<PlayerProfile> = {}): PlayerProfile {
  return {
    id: '1781236471643p7s',
    name: 'Leighton',
    isLeftHanded: false,
    createdAt: 1781236471643,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toPlayerProfileRow
// ---------------------------------------------------------------------------

group('toPlayerProfileRow field mapping');

{
  const row = toPlayerProfileRow(
    makeProfile({ isLeftHanded: true, ageTier: 'youth' }),
    USER,
    NOW_ISO,
  );
  assertEq(row.id, '1781236471643p7s', 'id passes through');
  assertEq(row.user_id, USER, 'user_id comes from the caller (account id)');
  assertEq(row.display_name, 'Leighton', 'name maps to display_name');
  assertEq(row.is_left_handed, true, 'isLeftHanded maps to is_left_handed');
  assertEq(row.age_tier, 'youth', 'ageTier passes through');
  assertEq(row.updated_at, NOW_ISO, 'updated_at set explicitly from caller');
  assertEq(
    row.created_at,
    new Date(1781236471643).toISOString(),
    'created_at preserves the local creation instant',
  );
}

{
  const row = toPlayerProfileRow(makeProfile(), USER, NOW_ISO);
  assertEq(row.age_tier, null, 'missing ageTier maps to null (not undefined)');
}

{
  for (const tier of ['junior', 'youth', 'teen', 'adult'] as const) {
    const row = toPlayerProfileRow(makeProfile({ ageTier: tier }), USER, NOW_ISO);
    assertEq(row.age_tier, tier, `tier '${tier}' passes through`);
  }
}

group('PII posture: unsynced fields');

{
  const row = toPlayerProfileRow(
    makeProfile({ nickname: 'Ley', isPrimary: true }),
    USER,
    NOW_ISO,
  );
  const keys = Object.keys(row).sort().join(',');
  assertEq(
    keys,
    'age_tier,created_at,display_name,id,is_left_handed,updated_at,user_id',
    'row contains exactly the posture-approved columns',
  );
  assert(!('nickname' in row), 'nickname is not synced');
  assert(!('isPrimary' in row) && !('is_primary' in row), 'isPrimary is not synced');
}

// ---------------------------------------------------------------------------
// pushKey — skip-if-unchanged dedupe identity
// ---------------------------------------------------------------------------

group('pushKey dedupe identity');

{
  const a = makeProfile();
  assertEq(
    pushKey(USER, [a]),
    pushKey(USER, [makeProfile({ nickname: 'Ley' })]),
    'nickname edits produce an identical key (keystrokes skip the network)',
  );
  assertEq(
    pushKey(USER, [a]),
    pushKey(USER, [makeProfile({ isPrimary: true })]),
    'primary switches produce an identical key',
  );
  assert(
    pushKey(USER, [a]) !== pushKey(USER, [makeProfile({ name: 'Luca' })]),
    'name change produces a different key',
  );
  assert(
    pushKey(USER, [a]) !== pushKey(USER, [makeProfile({ ageTier: 'teen' })]),
    'age change produces a different key',
  );
  assert(
    pushKey(USER, [a]) !== pushKey(USER, [makeProfile({ isLeftHanded: true })]),
    'handedness change produces a different key',
  );
  assert(
    pushKey(USER, [a]) !== pushKey('user_other', [a]),
    'same roster under a different account produces a different key',
  );
  assert(
    pushKey(USER, [a]) !== pushKey(USER, [a, makeProfile({ id: 'x2' })]),
    'added profile produces a different key',
  );
  assertEq(
    pushKey(USER, [makeProfile({ ageTier: undefined })]),
    pushKey(USER, [makeProfile()]),
    'undefined ageTier normalizes to the same key as absent',
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All tests passed — playerProfilesSync core validated');
}
