/**
 * tempoBandScore.test.ts — band formula vs hand-computed expectations
 * (Putting Mode Phase C spec §4; expectations derived from the formula
 * definition, never from implementation output).
 *
 * Run with: npx --yes tsx packages/domain/putting/tempoBandScore.test.ts
 */

import {
  tempoBandScore,
  TEMPO_BAND_TOP,
  TEMPO_BAND_FLOOR,
} from './tempoBandScore';

let passed = 0;
let failed = 0;

function assertEq(actual: number | null, expected: number | null, label: string): void {
  if (actual === expected) {
    console.log(`  ✅ ${label} (${actual})`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label} (got ${actual}, expected ${expected})`);
    failed++;
  }
}

console.log('\n── spec sanity anchors ──');
assertEq(tempoBandScore(1.42), 70, 'son 1.42 → 70 (|Δ|=0.58, 5 bands)');
assertEq(tempoBandScore(1.88), 90, 'son 1.88 → 90 (|Δ|=0.12, 1 band)');
assertEq(tempoBandScore(2.05), 95, '2.05 → 95 (inside dead zone)');
assertEq(tempoBandScore(2.25), 85, '2.25 → 85 (|Δ|=0.25, 2 bands)');
assertEq(tempoBandScore(2.0), TEMPO_BAND_TOP, 'exact center → 95');

console.log('\n── boundaries (integer centi-unit exactness) ──');
assertEq(tempoBandScore(2.1), 95, '|Δ|=0.10 exactly → still 95 (> not ≥)');
assertEq(tempoBandScore(1.9), 95, '|Δ|=0.10 on the low side → 95');
assertEq(tempoBandScore(2.11), 90, '|Δ|=0.11 → first band, 90');
assertEq(tempoBandScore(1.89), 90, '|Δ|=0.11 low side → 90');
assertEq(tempoBandScore(2.2), 90, '|Δ|=0.20 exact band edge → 90 (ceil of 1.0)');
assertEq(tempoBandScore(2.3), 85, '|Δ|=0.30 exact band edge → 85');
assertEq(tempoBandScore(1.7), 85, '|Δ|=0.30 low side → 85');
assertEq(tempoBandScore(2.21), 85, '|Δ|=0.21 just past edge → 85');

console.log('\n── floor clamp ──');
assertEq(tempoBandScore(0.8), 40, '0.8 → 40 (exactly 11 bands = 40)');
assertEq(tempoBandScore(3.5), 40, '3.5 → clamped to 40');
assertEq(tempoBandScore(0.5), 40, 'absurd-fast → 40');
assertEq(tempoBandScore(10), 40, 'absurd-slow → 40');

console.log('\n── null/withheld (never 0) ──');
assertEq(tempoBandScore(null), null, 'null ratio → null score');
assertEq(tempoBandScore(NaN), null, 'NaN → null');
assertEq(tempoBandScore(Infinity), null, 'Infinity → null');
if (TEMPO_BAND_FLOOR <= 0) {
  console.log('  ❌ FAIL: floor must be positive (withheld ≠ 0 invariant)');
  failed++;
} else {
  console.log('  ✅ floor positive (withheld ≠ 0 invariant holds)');
  passed++;
}

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All tempoBandScore tests passed');
}
