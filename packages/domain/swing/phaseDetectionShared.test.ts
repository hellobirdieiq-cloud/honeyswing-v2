/**
 * phaseDetectionShared.test.ts — Characterization tests for the shared
 * phase-detection helpers every detector depends on.
 *
 * These pin CURRENT behavior (regression guards, not correctness proofs).
 * Expected values are derived from phaseDetectionShared.ts source:
 *   - msPerFrameFromFrames/Trail: span/(n−1), <2 inputs → 0   (:289-300)
 *   - msToFrames: round(ms/msPerFrame), non-positive rate → 0 (:303-306)
 *   - REF_MS_60 = 1000/60; scalePerFrameFloor linear in rate  (:314, :317-319)
 *   - smoothWindow: 83ms box window, 60fps fallback 5         (:418, :421-423)
 *   - trailVelocity: euclidean/dt, dt=0 → 0                   (:425-431)
 *   - computeTrailVelocities: leading 0, length preserved     (:433-439)
 *   - smoothVelocities: edge-clamped box mean                 (:441-453)
 *   - findSetupEndIndexStillness: threshold max(median×0.2, 0.0001),
 *     default still-run 2, exhaustion → min(2, len−1)         (:344-366)
 *   - findSetupEndIndex: 8-frame window, middle 6 of sorted deltas > 0,
 *     candidate = i − gate, late guard 0.6×lastIdx, stillness fallback
 *                                                             (:376-412, :329-332)
 *   - findTakeawayOnsetFaceOn: gate+1 trail minimum, 20-frame body ruler
 *     (nose↔rightAnkle conf ≥ 0.5, 20% trim), climb target
 *     TAKEAWAY_MIN_TRAVEL_BH × bh on smoothed leadX, 3-frame sustained
 *     reversal rejection, 0.6 late guard                      (:474-673)
 *
 * Does NOT touch any tunable or EXTERNAL_ASSUMPTIONS value.
 *
 * Run with: npx --yes tsx packages/domain/swing/phaseDetectionShared.test.ts
 */

import {
  emptyReliability,
  msPerFrameFromFrames,
  msPerFrameFromTrail,
  msToFrames,
  REF_MS_60,
  scalePerFrameFloor,
  smoothWindow,
  trailVelocity,
  computeTrailVelocities,
  smoothVelocities,
  findSetupEndIndexStillness,
  findSetupEndIndex,
  findTakeawayOnsetFaceOn,
  TAKEAWAY_MIN_TRAVEL_BH,
} from './phaseDetectionShared';
import type { SwingTrailPoint } from './phaseDetection';
import { createEmptyJoints } from '../../pose/PoseTypes';
import type { PoseFrame } from '../../pose/PoseTypes';

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

function assertApprox(actual: number | null, expected: number, label: string, eps = 1e-9): void {
  assert(
    actual !== null && Math.abs(actual - expected) < eps,
    `${label} (got ${actual}, expected ≈${expected})`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tp(x: number, timestamp: number): SwingTrailPoint {
  return { x, y: 0.5, timestamp, leadX: x, leadY: 0.5, trailX: x, trailY: 0.5 };
}

function frameAt(timestampMs: number): PoseFrame {
  return { timestampMs, joints: createEmptyJoints(), frameWidth: 1080, frameHeight: 1920 };
}

/** Frame with a confident nose↔rightAnkle pair, vertical distance 0.8. */
function rulerFrame(timestampMs: number): PoseFrame {
  const joints = createEmptyJoints();
  joints.nose = { name: 'nose', x: 0.5, y: 0.1, confidence: 0.9 };
  joints.rightAnkle = { name: 'rightAnkle', x: 0.5, y: 0.9, confidence: 0.9 };
  return { timestampMs, joints, frameWidth: 1080, frameHeight: 1920 };
}

const MS_60FPS = 1000 / 60;
const MS_120FPS = 1000 / 120;

console.log('\n=== phaseDetectionShared Module Tests ===');

// ---------------------------------------------------------------------------
// Section A — time/frame helpers (:289-319)
// ---------------------------------------------------------------------------

group('A. Time/frame helpers');

assertEq(msPerFrameFromFrames([]), 0, 'A1: no frames → 0 (:290)');
assertEq(msPerFrameFromFrames([frameAt(50)]), 0, 'A2: single frame → 0 (:290)');
assertEq(
  msPerFrameFromFrames([frameAt(0), frameAt(100), frameAt(200), frameAt(300)]),
  100,
  'A3: even spacing → span/(n−1) = 100 (:291-292)',
);
assertEq(
  msPerFrameFromFrames([frameAt(0), frameAt(50), frameAt(200)]),
  100,
  'A4: uneven spacing → AVERAGE rate 200/2 = 100 (characterization, :291-292)',
);
assertEq(msPerFrameFromTrail([tp(0.5, 0)]), 0, 'A5: single trail point → 0 (:297)');
assertEq(
  msPerFrameFromTrail([tp(0.5, 0), tp(0.5, 25), tp(0.5, 50)]),
  25,
  'A6: trail rate = span/(n−1) = 25 (:298-299)',
);
assertEq(msToFrames(100, 0), 0, 'A7: msPerFrame 0 → 0 (guard, :304)');
assertEq(msToFrames(100, -5), 0, 'A8: negative msPerFrame → 0 (:304)');
assertEq(msToFrames(100, 16), 6, 'A9: round(100/16) = 6 (:305)');
assertEq(msToFrames(24, 16), 2, 'A10: round half up — round(1.5) = 2 (:305)');
assertEq(REF_MS_60, 1000 / 60, 'A11: REF_MS_60 = 1000/60 (:314)');
assertEq(scalePerFrameFloor(0.01), 0.01, 'A12: no rate → floor unchanged (:318)');
assertEq(scalePerFrameFloor(0.01, 0), 0.01, 'A13: rate 0 → floor unchanged (guard >0, :318)');
assertEq(scalePerFrameFloor(0.01, REF_MS_60), 0.01, 'A14: at reference rate → identical (:318)');
assertApprox(
  scalePerFrameFloor(0.01, MS_120FPS),
  0.005,
  'A15: at 120fps (half the dt) → floor halves (:318)',
);

// ---------------------------------------------------------------------------
// Section B — smoothing & velocity helpers (:418-453)
// ---------------------------------------------------------------------------

group('B. Smoothing & velocities');

assertEq(smoothWindow(), 5, 'B1: no rate → 60fps literal 5 (:422)');
assertEq(smoothWindow(MS_60FPS), 5, 'B2: 60fps → round(83/16.67) = 5 (:418, :422)');
assertEq(smoothWindow(MS_120FPS), 10, 'B3: 120fps → round(83/8.33) = 10 (:422)');
assertEq(smoothWindow(1000), 1, 'B4: very slow rate clamps to ≥1 (Math.max, :422)');

assertEq(trailVelocity(tp(0.5, 100), tp(0.7, 100)), 0, 'B5: dt = 0 → 0 (:427)');
{
  // dx=0.3, dy=0.4 → distance 0.5 over 100ms → 0.005/ms
  const a: SwingTrailPoint = { x: 0.1, y: 0.2, timestamp: 0, leadX: 0.1, leadY: 0.2, trailX: 0.1, trailY: 0.2 };
  const b: SwingTrailPoint = { x: 0.4, y: 0.6, timestamp: 100, leadX: 0.4, leadY: 0.6, trailX: 0.4, trailY: 0.6 };
  assertApprox(trailVelocity(a, b), 0.005, 'B6: 3-4-5 triangle → 0.5/100 (:428-430)');
}
{
  const v = computeTrailVelocities([tp(0.1, 0), tp(0.2, 100), tp(0.2, 200)]);
  assertEq(v.length, 3, 'B7: velocity array preserves length (:433-439)');
  assertEq(v[0], 0, 'B8: leading velocity is 0 (:434)');
  assertApprox(v[1], 0.001, 'B9: v[1] = 0.1/100 (:436)');
  assertEq(v[2], 0, 'B10: stationary segment → 0');
}
{
  const s = smoothVelocities([3, 3, 3, 3, 3], 5);
  assert(s.every((v) => v === 3), 'B11: constant input is a fixed point (:446-452)');
}
{
  // Edge-clamped box mean over [0,0,10,0,0]:
  // i=0 → mean(0..2)=10/3; i=2 → mean(0..4)=2; i=4 → mean(2..4)=10/3
  const s = smoothVelocities([0, 0, 10, 0, 0], 5);
  assertEq(s[2], 2, 'B12: centered outlier damped 10 → 2 (:446-452)');
  assertEq(s[0], 10 / 3, 'B13: edge clamp — window shrinks to 3 at i=0 (:447-448)');
  assertEq(s[4], 10 / 3, 'B14: edge clamp symmetric at tail');
}
{
  const input = [1, 5, 2, 8];
  const s = smoothVelocities(input, 1);
  assert(s.every((v, i) => v === input[i]), 'B15: window 1 is the identity (half=0, :445)');
}

// ---------------------------------------------------------------------------
// Section C — emptyReliability (:273-282)
// ---------------------------------------------------------------------------

group('C. emptyReliability');

{
  const r = emptyReliability();
  const keys = Object.keys(r).sort();
  assertEq(
    JSON.stringify(keys),
    JSON.stringify(['finish', 'impact', 'swing_start', 'takeaway', 'top', 'true_address']),
    'C1: exactly the six phase keys',
  );
  assert(Object.values(r).every((v) => v === null), 'C2: all values null');
}

// ---------------------------------------------------------------------------
// Section D — findSetupEndIndexStillness (:344-366)
// ---------------------------------------------------------------------------

group('D. findSetupEndIndexStillness');

{
  // 4 still frames then motion: median of positives 5 → threshold 1;
  // at i=4 (first > threshold) stillCount 4 ≥ default run 2 → return i−1 = 3
  const smoothed = [0, 0, 0, 0, 5, 5, 5, 5, 5, 5];
  const points = smoothed.map((_, i) => tp(0.5, i * 16));
  assertEq(findSetupEndIndexStillness(smoothed, points), 3, 'D1: still-then-move → last still index (:356-360)');
}
{
  // All-still input never crosses the threshold → exhaustion fallback min(2, len−1)
  const smoothed = new Array(10).fill(0);
  const points = smoothed.map((_: number, i: number) => tp(0.5, i * 16));
  assertEq(findSetupEndIndexStillness(smoothed, points), 2, 'D2: all-still → fallback min(2, len−1) (:365)');
}
{
  // Motion from frame 0 (no still run) → exhaustion fallback 2 (characterization)
  const smoothed = [5, 5, 5, 5, 5, 0, 0, 0, 0, 0];
  const points = smoothed.map((_, i) => tp(0.5, i * 16));
  assertEq(findSetupEndIndexStillness(smoothed, points), 2, 'D3: motion-first → fallback 2 (:365)');
}

// ---------------------------------------------------------------------------
// Section E — findSetupEndIndex (:376-412)
// ---------------------------------------------------------------------------

group('E. findSetupEndIndex');

{
  // 20 points: x flat 0.5 through idx 7, then +0.01/frame.
  // Deltas > 0 from j=8. First window passing "middle 6 of 8 sorted deltas > 0"
  // is i=14 (deltas 7..14: one zero dropped as sorted[0]) → candidate = 14−8 = 6.
  // Late guard: 6 ≤ 0.6×19 = 11.4 → returned.
  const points = Array.from({ length: 20 }, (_, i) =>
    tp(i <= 7 ? 0.5 : 0.5 + 0.01 * (i - 7), i * 16),
  );
  const smoothed = new Array(20).fill(0);
  assertEq(findSetupEndIndex(smoothed, points), 6, 'E1: directional gate fires → candidate i−gate = 6 (:392-407)');
}
{
  // Fewer than gate+1 (=9) points → straight to stillness fallback (:386-388)
  const points = Array.from({ length: 8 }, (_, i) => tp(0.5, i * 16));
  const smoothed = new Array(8).fill(0);
  assertEq(findSetupEndIndex(smoothed, points), 2, 'E2: short trail → stillness fallback (:386-388)');
}
{
  // Motion starting at idx 30 of 40 → candidate 28 > 0.6×39 = 23.4 → late guard
  // breaks to the stillness fallback (all-zero smoothed → 2). (:405-411)
  const points = Array.from({ length: 40 }, (_, i) =>
    tp(i <= 29 ? 0.5 : 0.5 + 0.02 * (i - 29), i * 16),
  );
  const smoothed = new Array(40).fill(0);
  assertEq(findSetupEndIndex(smoothed, points), 2, 'E3: late onset rejected → stillness fallback (:405-411)');
}

// ---------------------------------------------------------------------------
// Section F — findTakeawayOnsetFaceOn (:474-673)
// ---------------------------------------------------------------------------

group('F. findTakeawayOnsetFaceOn');

{
  const r = findTakeawayOnsetFaceOn([tp(0.5, 0)], [rulerFrame(0)]);
  assertEq(r.fallbackReason, 'trail_too_short' as const, 'F1: trail < gate+1 → trail_too_short (:563-565)');
  assertEq(r.fired, false, 'F1b: not fired');
  assertEq(r.onsetTrailIdx, null, 'F1c: null onset');
}
{
  // 12-point trail but zero confident ruler frames → ruler_unreliable (:567-570)
  const trail = Array.from({ length: 12 }, (_, i) => tp(0.5, i * 16));
  const r = findTakeawayOnsetFaceOn(trail, [frameAt(0), frameAt(16)]);
  assertEq(r.fallbackReason, 'ruler_unreliable' as const, 'F2: no confident nose/ankle frames → ruler_unreliable');
  assertEq(r.lockedBodyHeight, null, 'F2b: no locked body height');
}
{
  // FIRING case, hand-traced:
  //   40-pt trail: leadX = x = 0.30 flat through idx 9, then +0.02/frame → 0.90 at idx 39.
  //   Ruler: 40 confident frames, nose↔ankle distance 0.8 → bh ≈ 0.8, so the
  //   confirm target = TAKEAWAY_MIN_TRAVEL_BH×bh = 0.4 climb on smoothed leadX.
  //   First passing 8-delta window is i=16 → trigger/candidate = 8.
  //   Smoothed s[8] ≈ 0.304; climb crosses 0.4 at s[30] ≈ 0.72 → confirms, no
  //   reversal (monotone rise). Late guard: 8 ≤ 0.6×39 = 23.4 → FIRED at 8.
  const trail = Array.from({ length: 40 }, (_, i) =>
    tp(i <= 9 ? 0.3 : 0.3 + 0.02 * (i - 9), i * 16),
  );
  const frames = Array.from({ length: 40 }, (_, i) => rulerFrame(i * 16));
  const r = findTakeawayOnsetFaceOn(trail, frames);
  assertEq(r.fired, true, 'F3: committed climb fires the gate');
  assertEq(r.onsetTrailIdx, 8, 'F3b: onset = first trigger-group start (i−gate = 8)');
  assertEq(r.candidateTrailIdx, 8, 'F3c: candidate mirrors the trigger');
  assertEq(r.fallbackReason, null, 'F3d: no fallback reason');
  assertApprox(r.lockedBodyHeight, 0.8, 'F3e: locked body height = trimmed-mean 0.8');
  assert(
    r.travelBH !== null && r.travelBH >= TAKEAWAY_MIN_TRAVEL_BH,
    `F3f: confirm travel ≥ TAKEAWAY_MIN_TRAVEL_BH (got ${r.travelBH})`,
  );
}
{
  // FEINT case, hand-traced:
  //   0.30 flat ×10 → climb +0.02 for 8 frames (peak 0.46 at idx 17) → fall
  //   −0.02 for 10 frames (0.26 at idx 27) → flat to idx 39.
  //   Windows pass at i=16..18 → single trigger group at 8. Max smoothed climb
  //   ≈ 0.132 ≪ 0.4 target; the falling section produces ≥3 strictly-decreasing
  //   smoothed frames → sustained reversal rejects the group →
  //   no_confirmed_trigger with telemetry (candidate 8, small travelBH).
  const xs: number[] = [];
  for (let i = 0; i < 40; i++) {
    if (i <= 9) xs.push(0.3);
    else if (i <= 17) xs.push(0.3 + 0.02 * (i - 9));
    else if (i <= 27) xs.push(0.46 - 0.02 * (i - 17));
    else xs.push(0.26);
  }
  const trail = xs.map((x, i) => tp(x, i * 16));
  const frames = Array.from({ length: 40 }, (_, i) => rulerFrame(i * 16));
  const r = findTakeawayOnsetFaceOn(trail, frames);
  assertEq(r.fired, false, 'F4: waggle/feint does not fire');
  assertEq(r.fallbackReason, 'no_confirmed_trigger' as const, 'F4b: sustained reversal rejects the trigger (:632-637)');
  assertEq(r.candidateTrailIdx, 8, 'F4c: candidate telemetry preserved');
  assert(
    r.travelBH !== null && r.travelBH > 0 && r.travelBH < TAKEAWAY_MIN_TRAVEL_BH,
    `F4d: telemetry travel in (0, ${TAKEAWAY_MIN_TRAVEL_BH}) (got ${r.travelBH})`,
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
  console.log('✅ All phaseDetectionShared tests passed');
}
