/**
 * headerIdentity.test.ts — Tests for resolveHeaderProfile.
 *
 * Run with: npx --yes tsx lib/headerIdentity.test.ts
 */
import type { SwingRecord } from './swingStore';
import type { PlayerProfile } from './playerProfiles';
import { resolveHeaderProfile } from './headerIdentity';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function profile(id: string, name: string): PlayerProfile {
  return { id, name, isLeftHanded: false, createdAt: 0 };
}

// Only player_profile_id is read by the helper; cast a minimal stub.
function record(playerProfileId: string | null): SwingRecord {
  return { player_profile_id: playerProfileId } as SwingRecord;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const A = profile('A', 'Avery');
const B = profile('B', 'Blake');
const P = profile('P', 'Primary');

{
  // 1. loaded + id 'A' + profiles include A → profile A
  const result = resolveHeaderProfile(record('A'), [A, B], P, true);
  assert(result === A, "loaded + resolvable id 'A' → profile A");
}
{
  // 2. loaded + id 'ghost' + profiles lack it → null (deleted-locally)
  const result = resolveHeaderProfile(record('ghost'), [A, B], P, true);
  assert(result === null, "loaded + unresolvable id 'ghost' → null");
}
{
  // 3. loaded + player_profile_id null → null
  const result = resolveHeaderProfile(record(null), [A, B], P, true);
  assert(result === null, 'loaded + null attribution → null');
}
{
  // 4. loaded + swingRecord null → null
  const result = resolveHeaderProfile(null, [A, B], P, true);
  assert(result === null, 'loaded + null swingRecord → null');
}
{
  // 5. not loaded + activeProfile P → P (fallback)
  const result = resolveHeaderProfile(null, [A, B], P, false);
  assert(result === P, 'not loaded → caller fallback P');
}

// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  process.exit(1);
}
