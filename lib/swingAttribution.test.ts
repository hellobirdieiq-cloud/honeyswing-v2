/**
 * swingAttribution.test.ts — proves the button-press snapshot resolves to the
 * correct persisted attribution, so Leighton saves as Leighton and Luca as Luca
 * (the wrong-kid bug), and a missing profile hard-blocks rather than falling back.
 *
 * Run with: npx tsx lib/swingAttribution.test.ts
 */

import { resolveAttribution } from './swingAttribution';

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

// ── Leighton (left-handed) → Leighton/left ───────────────────────────────────
const leighton = resolveAttribution({ id: 'leighton', isLeftHanded: true });
assert(leighton?.playerProfileId === 'leighton', 'Leighton snapshot → player_profile_id = leighton');
assert(leighton?.isLeftHanded === true, 'Leighton snapshot → handedness = left');

// ── Luca (right-handed) → Luca/right ─────────────────────────────────────────
const luca = resolveAttribution({ id: 'luca', isLeftHanded: false });
assert(luca?.playerProfileId === 'luca', 'Luca snapshot → player_profile_id = luca');
assert(luca?.isLeftHanded === false, 'Luca snapshot → handedness = right');

// ── No active profile → hard-block (null, no fallback) ───────────────────────
assert(resolveAttribution(null) === null, 'null snapshot → blocked');
assert(resolveAttribution(undefined) === null, 'undefined snapshot → blocked');
assert(
  resolveAttribution({ id: '', isLeftHanded: false }) === null,
  'empty id → blocked (no attribution to a phantom profile)',
);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All tests passed — swing attribution snapshot validated');
}
