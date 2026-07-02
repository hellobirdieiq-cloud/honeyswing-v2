/**
 * computeFocus.test.ts — Batch 4 purity validation
 *
 * Run with: npx tsx lib/computeFocus.test.ts
 *
 * computeFocus is a pure function of (angles, ageTier, savedAtMs): no hidden
 * age-tier global, no Date.now(). These tests pin determinism, tier
 * sensitivity (both eligibility and cue language), and the null path.
 * saveFocus/loadFocus AsyncStorage I/O is tested via device, not here.
 */

import { computeFocus } from './swingMotionStore';
import type { GolfAngles } from '@/packages/domain/swing/angles';
import type { AgeTier } from '@/packages/domain/swing/tipFrequency';

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TIERS: AgeTier[] = ['junior', 'youth', 'teen', 'adult'];

const MIXED_SWING: GolfAngles = {
  spineAngle: 28.0, leftElbowAngle: 121.0, rightElbowAngle: 118.0,
  leftKneeAngle: 139.0, rightKneeAngle: 141.0, hipSpreadDelta: 0.06,
  shoulderTilt: 38.0, spineDrift: 0.05,
};

// spineAngle is the only measured metric; ineligible for junior/youth
// (METRIC_LIMITS limit 0), eligible for adult (limit 6).
const SPINE_ONLY: GolfAngles = {
  spineAngle: 22.0, leftElbowAngle: null, rightElbowAngle: null,
  leftKneeAngle: null, rightKneeAngle: null, hipSpreadDelta: null,
  shoulderTilt: null, spineDrift: null,
};

const ALL_NULL: GolfAngles = {
  spineAngle: null, leftElbowAngle: null, rightElbowAngle: null,
  leftKneeAngle: null, rightKneeAngle: null, hipSpreadDelta: null,
  shoulderTilt: null, spineDrift: null,
};

// ---------------------------------------------------------------------------
// Determinism: same inputs → identical output, every time
// ---------------------------------------------------------------------------

group('determinism: same (angles, tier, savedAtMs) → identical FocusData');
for (const tier of TIERS) {
  const a = computeFocus(MIXED_SWING, tier, 1000);
  const b = computeFocus(MIXED_SWING, tier, 1000);
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${tier}: repeated calls are byte-identical`
  );
}

group('determinism: savedAtMs is passed through, not generated');
{
  const f = computeFocus(MIXED_SWING, 'youth', 12345);
  assert(f !== null && f.savedAt === 12345, 'savedAt === injected savedAtMs');
}

// ---------------------------------------------------------------------------
// Tier sensitivity: the ageTier param is live, not vestigial
// ---------------------------------------------------------------------------

group('tier sensitivity: eligibility differs by tier');
{
  const junior = computeFocus(SPINE_ONLY, 'junior', 0);
  const youth = computeFocus(SPINE_ONLY, 'youth', 0);
  const adult = computeFocus(SPINE_ONLY, 'adult', 0);
  assert(junior === null, 'junior: spineAngle ineligible (limit 0) → null');
  assert(youth === null, 'youth: spineAngle ineligible (limit 0) → null');
  assert(adult !== null && adult.label === 'Spine tilt', 'adult: spineAngle eligible → Spine tilt focus');
}

group('tier sensitivity: cue language varies by tier');
{
  const junior = computeFocus(MIXED_SWING, 'junior', 0);
  const youth = computeFocus(MIXED_SWING, 'youth', 0);
  assert(
    junior !== null && youth !== null && junior.label === youth.label,
    'junior and youth pick the same worst metric'
  );
  assert(
    junior !== null && youth !== null && junior.cue !== youth.cue,
    'junior and youth get different cue wording'
  );
}

// ---------------------------------------------------------------------------
// Null path
// ---------------------------------------------------------------------------

group('null path: no measured eligible metrics → null');
for (const tier of TIERS) {
  assert(computeFocus(ALL_NULL, tier, 0) === null, `${tier}: all-null angles → null`);
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
  console.log('✅ All tests passed — computeFocus purity validated');
}
