/**
 * coachData.test.ts — coach pivot Phase 3
 *
 * Run with: npx tsx lib/coachData.test.ts
 *
 * Tests the pure coach-view helpers (coachDataCore.ts): kid label map, orphan
 * detection, and per-tab filtering. The networked fetchers (RN + Supabase
 * imports) are exercised on device, mirroring the playerProfilesSync split.
 */

import {
  buildKidLabelMap,
  resolveKidLabel,
  hasOrphanSwings,
  filterSwingsForTab,
  UNKNOWN_PLAYER_LABEL,
  UNKNOWN_TAB_ID,
  type CoachKid,
} from './coachDataCore';
import type { SwingHistoryRecord } from './swingStore';

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

const KIDS: CoachKid[] = [
  { id: 'kid-luca', display_name: 'Luca', age_tier: 'youth', is_left_handed: false, user_id: 'user_parent1' },
  { id: 'kid-ley', display_name: 'Leighton', age_tier: 'adult', is_left_handed: true, user_id: 'user_parent1' },
];

function makeSwing(overrides: Partial<SwingHistoryRecord> = {}): SwingHistoryRecord {
  return {
    id: 'swing-1',
    created_at: '2026-07-05T00:00:00+00:00',
    tempo_ratio: 3.0,
    score: 80,
    player_profile_id: 'kid-luca',
    is_favorite: false,
    frame_count: 180,
    ...overrides,
  };
}

const SWINGS: SwingHistoryRecord[] = [
  makeSwing({ id: 's1', player_profile_id: 'kid-luca' }),
  makeSwing({ id: 's2', player_profile_id: 'kid-ley' }),
  makeSwing({ id: 's3', player_profile_id: null }),
  makeSwing({ id: 's4', player_profile_id: 'kid-deleted' }),
];

const MAP = buildKidLabelMap(KIDS);

// ---------------------------------------------------------------------------
// Label map + resolution
// ---------------------------------------------------------------------------

group('buildKidLabelMap / resolveKidLabel');

assertEq(MAP['kid-luca'], 'Luca', 'map resolves a roster kid');
assertEq(resolveKidLabel(MAP, 'kid-ley'), 'Leighton', 'known id resolves to display_name');
assertEq(resolveKidLabel(MAP, null), UNKNOWN_PLAYER_LABEL, 'null id falls back to Player');
assertEq(
  resolveKidLabel(MAP, 'kid-deleted'),
  UNKNOWN_PLAYER_LABEL,
  'unknown id (deleted/unsynced kid) falls back to Player',
);

// ---------------------------------------------------------------------------
// Orphan detection
// ---------------------------------------------------------------------------

group('hasOrphanSwings');

assert(hasOrphanSwings(SWINGS, MAP), 'null + unknown ids count as orphans');
assert(
  !hasOrphanSwings([makeSwing({ player_profile_id: 'kid-luca' })], MAP),
  'fully-resolved swings have no orphans',
);
assert(!hasOrphanSwings([], MAP), 'empty feed has no orphans');

// ---------------------------------------------------------------------------
// Tab filtering
// ---------------------------------------------------------------------------

group('filterSwingsForTab');

assertEq(filterSwingsForTab(SWINGS, MAP, 'all').length, 4, "'all' returns everything");
{
  const luca = filterSwingsForTab(SWINGS, MAP, 'kid-luca');
  assertEq(luca.length, 1, 'kid tab returns only that kid');
  assertEq(luca[0].id, 's1', 'kid tab returns the right row');
}
{
  const orphans = filterSwingsForTab(SWINGS, MAP, UNKNOWN_TAB_ID);
  assertEq(orphans.length, 2, 'unknown tab returns null-id AND unresolvable-id swings');
  assertEq(orphans.map((s) => s.id).join(','), 's3,s4', 'unknown tab preserves order');
}
assertEq(
  filterSwingsForTab(SWINGS, MAP, 'kid-nobody').length,
  0,
  'tab for an id with no swings returns empty',
);

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
  console.log('✅ All tests passed — coachData core validated');
}
