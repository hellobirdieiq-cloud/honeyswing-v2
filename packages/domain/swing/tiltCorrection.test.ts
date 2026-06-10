/**
 * tiltCorrection.test.ts — H2 repro: shoulderTilt correction applies the
 * WRONG SIGN.
 *
 * shoulderTilt is measured FROM HORIZONTAL in angles.ts:128
 *   shoulderTilt = round(atan2(dy, absDx) * 180 / PI)
 * A forward phone pitch shifts a from-horizontal angle in the POSITIVE
 * direction, so the correction must ADD pitchDeg. The module's own comment
 * (tiltCorrection.ts:30-34, 398-402) says exactly this:
 *   "If shoulderTilt is angle-from-HORIZONTAL: correction = ADD pitchDeg,
 *    not subtract. This is the single most likely silent-failure point."
 * But correctForPhoneTilt subtracts (tiltCorrection.ts:405).
 *
 * Documented intent → shoulderTilt 10 with pitch +12 should become +22.
 * Current code returns -2. This test FAILS until the sign is fixed.
 *
 * Run with: npx --yes tsx packages/domain/swing/tiltCorrection.test.ts
 */

import { correctForPhoneTilt, type PhoneTilt } from './tiltCorrection';

let passed = 0;
let failed = 0;

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
    failed++;
  }
}

console.log('\n=== tiltCorrection H2 repro ===');
console.log('\n── shoulderTilt is angle-from-horizontal → correction must ADD pitch ──');

// Tilt passes every guard: >=3 samples, stddev 1 < 8, |pitch| 12 in [2,30].
const tilt: PhoneTilt = {
  pitchDeg: 12,
  rollDeg: 0,
  sampleCount: 5,
  pitchStdDev: 1,
  rejectedCount: 0,
};

const { corrected, debug } = correctForPhoneTilt({ shoulderTilt: 10 }, tilt);

console.log(`  (correctionApplied=${debug.correctionApplied}, reason=${debug.reason}, after=${corrected.shoulderTilt})`);

// Documented intent: from-horizontal ⇒ ADD pitch ⇒ 10 + 12 = 22.
assertEq(corrected.shoulderTilt, 22, 'H2: shoulderTilt 10 + pitch 12 → 22 (current code yields -2)');

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All tiltCorrection tests passed');
}
