/**
 * scrubberBands.test.ts — pins the FIX 6c precision-scrub band math.
 *
 * Guards:
 *   1. Band resolution honors the spec sensitivities (0–24pt→1pt/frame,
 *      24–64→4, 64+→8) with the ~4pt hysteresis (enter 28/68, leave 20/60).
 *   2. No chatter: inside the hysteresis window the band does NOT change
 *      (one haptic per real crossing depends on this).
 *   3. Whole-frame relative mapping: rounding, clamping at both clip bounds.
 *   4. ZERO-JUMP re-anchor invariant: switching bands with anchorFrame=target,
 *      anchorX=x produces the identical frame at the switch instant.
 *
 * Run with: npx --yes tsx components/scrubberBands.test.ts
 */

import {
  BAND_PT_PER_FRAME,
  BAND_ENTER_PT,
  BAND_LEAVE_PT,
  resolveBand,
  targetFrame,
  frameAtFraction,
  clampFrame,
  type ScrubBand,
} from './scrubberBands';

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

console.log('\n── tunables sane ──');
assert(BAND_PT_PER_FRAME[0] === 1 && BAND_PT_PER_FRAME[1] === 4 && BAND_PT_PER_FRAME[2] === 8,
  'sensitivities are 1 / 4 / 8 pt per frame');
assert(BAND_ENTER_PT[0] > BAND_LEAVE_PT[0] && BAND_ENTER_PT[1] > BAND_LEAVE_PT[1],
  'enter thresholds sit above leave thresholds (real hysteresis gap)');
assert(BAND_LEAVE_PT[1] > BAND_ENTER_PT[0],
  'bands do not overlap (medium leave above fine→medium enter)');

console.log('\n── band resolution ──');
assert(resolveBand(0, 0) === 0, 'at rest → fine band');
assert(resolveBand(0, 27) === 0, 'below enter[0]=28 stays fine');
assert(resolveBand(0, 28) === 1, 'at enter[0]=28 → medium');
assert(resolveBand(0, 67) === 1, 'below enter[1]=68 from fine → medium only');
assert(resolveBand(0, 68) === 2, 'at enter[1]=68 → coarse (multi-band jump in one move)');
assert(resolveBand(1, 20) === 1, 'at leave[0]=20 medium holds');
assert(resolveBand(1, 19) === 0, 'below leave[0]=20 → back to fine');
assert(resolveBand(2, 60) === 2, 'at leave[1]=60 coarse holds');
assert(resolveBand(2, 59) === 1, 'below leave[1]=60 → back to medium');
assert(resolveBand(2, 10) === 0, 'coarse straight down to fine when near rest');

console.log('\n── hysteresis / no-chatter window ──');
// Finger hovering between leave[0]=20 and enter[0]=28: band must not move in
// EITHER direction — this is what makes "one haptic per crossing" true.
for (const up of [21, 24, 27]) {
  assert(resolveBand(0, up) === 0, `fine holds at ${up}pt (inside 20–28 window)`);
  assert(resolveBand(1, up) === 1, `medium holds at ${up}pt (inside 20–28 window)`);
}
for (const up of [61, 64, 67]) {
  assert(resolveBand(1, up) === 1, `medium holds at ${up}pt (inside 60–68 window)`);
  assert(resolveBand(2, up) === 2, `coarse holds at ${up}pt (inside 60–68 window)`);
}

console.log('\n── whole-frame relative mapping ──');
const N = 350;
assert(targetFrame(100, 50, 50, 0, N) === 100, 'no horizontal movement → anchor frame');
assert(targetFrame(100, 50, 57, 0, N) === 107, 'fine: +7pt → +7 frames');
assert(targetFrame(100, 50, 57, 1, N) === 102, 'medium: +7pt → +2 frames (round 1.75)');
assert(targetFrame(100, 50, 57, 2, N) === 101, 'coarse: +7pt → +1 frame (round 0.875)');
assert(targetFrame(100, 50, 46, 2, N) === 100, 'coarse: −4pt is a half step — Math.round(−0.5) → 0, stays 100');
assert(targetFrame(100, 50, 44, 1, N) === 99, 'medium: −6pt → Math.round(−1.5) = −1 (rounds toward +∞), lands 99');
assert(targetFrame(5, 0, -900, 0, N) === 0, 'clamps at frame 0');
assert(targetFrame(340, 0, 900, 0, N) === N - 1, `clamps at frame ${N - 1}`);
assert(targetFrame(0, 0, 10, 0, 0) === 0, 'frameCount 0 → 0 (no negative clamp)');

console.log('\n── zero-jump re-anchor invariant ──');
// Simulate a drag that crosses bands: at each switch, re-anchor exactly the
// way LabelScrubber does and check the displayed frame is unchanged at the
// switch instant, for several (frame, x, band→band) combinations.
const switches: { frame: number; x: number; from: ScrubBand; to: ScrubBand }[] = [
  { frame: 42, x: 133, from: 0, to: 1 },
  { frame: 42, x: 133, from: 1, to: 2 },
  { frame: 0, x: 5, from: 2, to: 1 },
  { frame: 349, x: 300, from: 1, to: 0 },
];
for (const s of switches) {
  const atSwitch = targetFrame(s.frame, s.x, s.x, s.to, N);
  assert(atSwitch === clampFrame(s.frame, N),
    `band ${s.from}→${s.to} at f${s.frame}: re-anchored target === displayed frame (zero jump)`);
}

console.log('\n── tap fraction mapping ──');
assert(frameAtFraction(0, N) === 0, 'fraction 0 → frame 0');
assert(frameAtFraction(1, N) === N - 1, `fraction 1 → frame ${N - 1}`);
assert(frameAtFraction(0.5, N) === Math.round((N - 1) / 2), 'fraction 0.5 → middle frame');
assert(frameAtFraction(-0.3, N) === 0, 'fraction < 0 clamps to 0');
assert(frameAtFraction(1.7, N) === N - 1, 'fraction > 1 clamps to last frame');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
