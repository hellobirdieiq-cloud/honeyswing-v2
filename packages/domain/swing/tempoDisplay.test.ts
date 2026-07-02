/**
 * tempoDisplay.test.ts — Batch 5.2 validation
 *
 * Run with: npx tsx packages/domain/swing/tempoDisplay.test.ts
 *
 * Pins the tempo-display truth table (including the inclusive green boundaries
 * at TEMPO_GREEN_LOWER/UPPER), the kid-facing copy byte-for-byte, and the
 * partial-reason precedence (fallback_gate wins; only 'no-swing' qualifies
 * from failure_reason).
 */

import { deriveTempoDisplay, derivePartialReason } from './tempoDisplay';
import { TEMPO_GREEN_LOWER, TEMPO_GREEN_UPPER } from './scoring';

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
// deriveTempoDisplay — truth table
// ---------------------------------------------------------------------------

group('deriveTempoDisplay: null tempo');
const nullOut = deriveTempoDisplay(null);
assertEq(nullOut.isGreen, false, 'null → not green');
assertEq(nullOut.tooFast, false, 'null → not tooFast');
assertEq(nullOut.tooSlow, false, 'null → not tooSlow');
assertEq(nullOut.scoreColor, '#FFFFFF', 'null → white score');
assertEq(nullOut.tempoLabelText, null, 'null → no label');
assertEq(nullOut.coachingCueText, null, 'null → no cue');
assertEq(deriveTempoDisplay(undefined).isGreen, false, 'undefined behaves as null');

group('deriveTempoDisplay: green band inclusive boundaries');
const atLower = deriveTempoDisplay({ tempoRatio: TEMPO_GREEN_LOWER });
assert(atLower.isGreen && !atLower.tooFast && !atLower.tooSlow, `ratio === ${TEMPO_GREEN_LOWER} (lower bound) → green, not tooFast`);
assertEq(atLower.scoreColor, '#44CC44', 'green → #44CC44');
const atUpper = deriveTempoDisplay({ tempoRatio: TEMPO_GREEN_UPPER });
assert(atUpper.isGreen && !atUpper.tooSlow, `ratio === ${TEMPO_GREEN_UPPER} (upper bound) → green, not tooSlow`);
const mid = deriveTempoDisplay({ tempoRatio: 3.0 });
assert(mid.isGreen, 'ratio 3.0 → green');
assertEq(mid.tempoLabelText, 'Perfect swing speed!', 'green label copy byte-pinned');
assertEq(mid.coachingCueText, null, 'green → no coaching cue');

group('deriveTempoDisplay: tooFast (ratio < lower)');
const fast = deriveTempoDisplay({ tempoRatio: 1.9999 });
assert(!fast.isGreen && fast.tooFast && !fast.tooSlow, 'just below lower bound → tooFast only');
assertEq(fast.scoreColor, '#FFFFFF', 'not green → white');
assertEq(fast.tempoLabelText, 'Slow down your backswing', 'tooFast label copy byte-pinned');
assertEq(fast.coachingCueText, "Swing back slow like you're moving through honey", 'tooFast cue copy byte-pinned');

group('deriveTempoDisplay: tooSlow (ratio > upper)');
const slow = deriveTempoDisplay({ tempoRatio: 4.3001 });
assert(!slow.isGreen && !slow.tooFast && slow.tooSlow, 'just above upper bound → tooSlow only');
assertEq(slow.tempoLabelText, 'Speed up your backswing', 'tooSlow label copy byte-pinned');
assertEq(slow.coachingCueText, 'Whip the club head back fast', 'tooSlow cue copy byte-pinned');

// ---------------------------------------------------------------------------
// derivePartialReason — precedence + != null semantics
// ---------------------------------------------------------------------------

group('derivePartialReason');
assertEq(derivePartialReason({ fallback_gate: 'tempo-implausible' }, null), 'tempo-implausible', 'gate string wins');
assertEq(derivePartialReason({ fallback_gate: 0 }, null), '0', 'gate 0 (falsy, != null) → stringified');
assertEq(derivePartialReason({ fallback_gate: false }, 'no-swing'), 'false', 'gate false beats failure_reason');
assertEq(derivePartialReason({ fallback_gate: null }, 'no-swing'), 'no-swing', 'gate null → falls to no-swing');
assertEq(derivePartialReason(undefined, 'no-swing'), 'no-swing', 'no swing_debug + no-swing → no-swing');
assertEq(derivePartialReason(undefined, 'no-person'), null, 'other failure_reason → null');
assertEq(derivePartialReason(undefined, null), null, 'nothing → null');
assertEq(derivePartialReason({}, undefined), null, 'empty debug + undefined reason → null');

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
  console.log('✅ All tests passed — tempoDisplay validated');
}
