/**
 * phaseDetection.test.ts — Tests for findSetupEndIndex directional gate.
 *
 * Run with: npx --yes tsx packages/domain/swing/phaseDetection.test.ts
 */

import {
  findSetupEndIndex,
  findSetupEndIndexStillness,
  type SwingTrailPoint,
} from './phaseDetection';
import { findTakeawayOnsetFaceOn } from './phaseDetectionShared';
import { createEmptyJoints, type PoseFrame } from '../../pose/PoseTypes';

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

// Mirror of the private smoother in phaseDetection.ts so tests can build a
// realistic `smoothed` array from synthetic points.
function velocity(a: SwingTrailPoint, b: SwingTrailPoint): number {
  const dt = b.timestamp - a.timestamp;
  if (dt === 0) return 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy) / dt;
}

function computeSmoothed(points: SwingTrailPoint[], window = 5): number[] {
  const v: number[] = [0];
  for (let i = 1; i < points.length; i++) v.push(velocity(points[i - 1], points[i]));
  const half = Math.floor(window / 2);
  return v.map((_, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(v.length - 1, i + half);
    let sum = 0;
    for (let j = start; j <= end; j++) sum += v[j];
    return sum / (end - start + 1);
  });
}

const FRAME_DT_MS = 1000 / 120; // 120 fps capture

function makePoint(x: number, y: number, frameIdx: number): SwingTrailPoint {
  return { x, y, timestamp: frameIdx * FRAME_DT_MS, leadX: 0, leadY: 0, trailX: 0, trailY: 0 };
}

// ---------------------------------------------------------------------------
// T1 — Clean immediate backswing
// ---------------------------------------------------------------------------
group('T1. Clean immediate backswing → gate fires near start');
{
  const N = 80;
  const points: SwingTrailPoint[] = [];
  for (let i = 0; i < N; i++) {
    // Δx = 0.005/frame > DIRECTION_THRESHOLD (0.002)
    points.push(makePoint(0.3 + i * 0.005, 0.5, i));
  }
  const smoothed = computeSmoothed(points);
  const idx = findSetupEndIndex(smoothed, points);

  const DIRECTION_FRAMES = 20;
  assert(idx >= 0, 'T1: returns a valid integer');
  assert(
    idx <= DIRECTION_FRAMES,
    `T1: addressIdx within first DIRECTION_FRAMES window (got ${idx})`,
  );
  // First frame at which delta over DIRECTION_FRAMES exceeds threshold is i = DIRECTION_FRAMES.
  // So candidate = i - DIRECTION_FRAMES = 0.
  assertEq(idx, 0, 'T1: addressIdx is 0 for clean immediate motion');
}

// ---------------------------------------------------------------------------
// T2 — Pre-swing settle then clean backswing
// ---------------------------------------------------------------------------
group('T2. Settle then backswing → addressIdx at end of still period');
{
  const STILL = 30;
  const MOVE = 40;
  const points: SwingTrailPoint[] = [];
  for (let i = 0; i < STILL; i++) points.push(makePoint(0.5, 0.5, i));
  for (let j = 0; j < MOVE; j++) points.push(makePoint(0.5 + (j + 1) * 0.005, 0.5, STILL + j));
  const smoothed = computeSmoothed(points);
  const idx = findSetupEndIndex(smoothed, points);

  // First frame i where points[i].x - points[i - 20].x > 0.04 (= 20 * 0.002)
  // Search analytically: at i = STILL + k, points[i].x = 0.5 + (k+1)*0.005,
  // points[i - 20].x is in still region when k <= 20. So delta = (k+1)*0.005.
  // Need (k+1)*0.005 > 0.04 → k > 7. Smallest k = 8 → i = 38, candidate = 18.
  assert(idx > 0, `T2: addressIdx > 0 (got ${idx})`);
  assert(idx < STILL, `T2: addressIdx is before motion onset frame (got ${idx}, STILL=${STILL})`);
  assert(
    idx >= STILL - 20,
    `T2: addressIdx is within DIRECTION_FRAMES of still→move boundary (got ${idx})`,
  );
}

// ---------------------------------------------------------------------------
// T3 — Waggle (opposite direction) then backswing
// ---------------------------------------------------------------------------
group('T3. Waggle then backswing → addressIdx points past the waggle');
{
  const WAGGLE = 25;
  const MOVE = 40;
  const points: SwingTrailPoint[] = [];
  // Waggle: x decreases
  for (let i = 0; i < WAGGLE; i++) points.push(makePoint(0.5 - i * 0.005, 0.5, i));
  // Backswing: x increases from waggle low
  const waggleEndX = 0.5 - (WAGGLE - 1) * 0.005;
  for (let j = 0; j < MOVE; j++) {
    points.push(makePoint(waggleEndX + (j + 1) * 0.005, 0.5, WAGGLE + j));
  }
  const smoothed = computeSmoothed(points);
  const idx = findSetupEndIndex(smoothed, points);

  // During waggle, delta over 20 frames = -20 * 0.005 = -0.1 < threshold → no fire.
  // After backswing onset, the 20-frame window straddles waggle and backswing.
  // The first i where delta > 0.04 lands inside the backswing run, so
  // candidate = i - 20 must be >= WAGGLE - 20 + 1 (well past the waggle origin)
  // and importantly NOT 0 (which would be the start of the waggle).
  assert(idx > 0, `T3: addressIdx is not 0/waggle-start (got ${idx})`);
  assert(
    idx >= WAGGLE - 20,
    `T3: addressIdx is at or past the waggle-to-backswing transition (got ${idx})`,
  );
}

// ---------------------------------------------------------------------------
// T4 — Pure noise: directional gate falls through to stillness fallback
// ---------------------------------------------------------------------------
group('T4. No sustained direction → matches stillness fallback exactly');
{
  // Deterministic pseudo-random so the test is reproducible
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const N = 80;
  const points: SwingTrailPoint[] = [];
  for (let i = 0; i < N; i++) {
    points.push(makePoint(0.5 + (rand() - 0.5) * 0.02, 0.5 + (rand() - 0.5) * 0.02, i));
  }
  const smoothed = computeSmoothed(points);

  const idx = findSetupEndIndex(smoothed, points);
  const stillIdx = findSetupEndIndexStillness(smoothed, points);

  assert(Number.isInteger(idx), `T4: returns a valid integer (got ${idx})`);
  assertEq(idx, stillIdx, 'T4: noise input → directional gate matches stillness fallback');
}

// ---------------------------------------------------------------------------
// T5 — MAX_ADDRESS_FRACTION guard: late onset → stillness fallback
// ---------------------------------------------------------------------------
group('T5. Onset past 0.6 * lastIdx → directional gate skips, falls through');
{
  // Constant x for the first 80% of frames, then fast directional motion.
  const N = 100;            // lastIdx = 99
  const STILL = Math.floor(N * 0.8); // 80 still frames
  const points: SwingTrailPoint[] = [];
  for (let i = 0; i < STILL; i++) points.push(makePoint(0.5, 0.5, i));
  for (let j = 0; j < N - STILL; j++) {
    points.push(makePoint(0.5 + (j + 1) * 0.005, 0.5, STILL + j));
  }
  const smoothed = computeSmoothed(points);

  const idx = findSetupEndIndex(smoothed, points);
  const stillIdx = findSetupEndIndexStillness(smoothed, points);

  // Earliest possible directional candidate index: motion starts at i = STILL = 80.
  // First i with delta > 0.04 is roughly STILL + 8 = 88 → candidate = 68.
  // MAX_ADDRESS_FRACTION * lastIdx = 0.6 * 99 = 59.4 → 68 > 59.4 → skip.
  assertEq(idx, stillIdx, 'T5: late directional onset → falls through to stillness fallback');
}

// ===========================================================================
// Body-scaled, reversal-rejecting takeaway onset (findTakeawayOnsetFaceOn).
// FACE-ON only; additive override for findSetupEndIndex. Expectations derived
// analytically from the fixture math + the running-min / backward-climb rule.
// ===========================================================================

function assertClose(actual: number | null, expected: number, tol: number, label: string): void {
  assert(
    actual !== null && Math.abs(actual - expected) <= tol,
    `${label} (got ${JSON.stringify(actual)}, expected ${expected} ± ${tol})`,
  );
}

// Lead-wrist signal lives in trailX (the historically inverted trail-naming
// trap). Mirror it into x too so the legacy midpoint gate sees the same motion.
function makeLeadPoint(trailX: number, frameIdx: number): SwingTrailPoint {
  return { x: trailX, y: 0.5, timestamp: frameIdx * FRAME_DT_MS, leadX: 0, leadY: 0, trailX, trailY: 0.5 };
}

// nose at y=0.1, rightAnkle at y=0.9, same x ⇒ body height = 0.8 ⇒ 0.5 BH = 0.4.
function makeBodyFrame(frameIdx: number, conf = 0.9): PoseFrame {
  const joints = createEmptyJoints();
  joints.nose = { name: 'nose', x: 0.5, y: 0.1, confidence: conf };
  joints.rightAnkle = { name: 'rightAnkle', x: 0.5, y: 0.9, confidence: conf };
  return { timestampMs: frameIdx * FRAME_DT_MS, joints, frameWidth: 1, frameHeight: 1 };
}
function makeBodyFrames(n: number, conf = 0.9): PoseFrame[] {
  return Array.from({ length: n }, (_, i) => makeBodyFrame(i, conf));
}
const BH = 0.8; // body height implied by makeBodyFrame

// ---------------------------------------------------------------------------
// T6 — Clean rising run ≥ 0.5 BH → fires, returns the onset at the rise bottom
// ---------------------------------------------------------------------------
group('T6. Clean ≥0.5 BH lead-wrist run → body-scaled gate fires at onset');
{
  const N = 50;
  const trail: SwingTrailPoint[] = [];
  for (let i = 0; i < N; i++) {
    // Flat address for i<10, then +0.02/frame → reaches 0.30 + 40*0.02 = 1.10
    const x = i < 10 ? 0.3 : 0.3 + (i - 9) * 0.02;
    trail.push(makeLeadPoint(x, i));
  }
  const r = findTakeawayOnsetFaceOn(trail, makeBodyFrames(N));

  assert(r.fired, 'T6: fired');
  assert(r.onsetTrailIdx !== null, 'T6: onset returned (non-null)');
  assertEq(r.fallbackReason, null, 'T6: no fallback reason');
  assertEq(r.candidateTrailIdx, r.onsetTrailIdx, 'T6: candidate == onset when fired');
  assertClose(r.lockedBodyHeight, BH, 1e-9, 'T6: lockedBodyHeight = 0.8');
  // Onset is the bottom of the smoothed rise (~ transition at frame 10, pulled a
  // couple frames earlier by the 5-wide smoother). Well before the 0.6*49≈29 cap.
  assert(r.onsetTrailIdx! >= 4 && r.onsetTrailIdx! <= 12, `T6: onset near rise bottom (got ${r.onsetTrailIdx})`);
  // Raw travel ≈ 1.10−0.30 = 0.80 ⇒ ~1.0 BH, comfortably ≥ 0.5.
  assert((r.travelBH ?? 0) >= 0.5, `T6: travelBH ≥ 0.5 (got ${r.travelBH})`);
}

// ---------------------------------------------------------------------------
// T7 — Waggle rises <0.5 BH then reverses, no real takeaway → null → fallback
// ---------------------------------------------------------------------------
group('T7. Waggle <0.5 BH then back → null (caller falls back to findSetupEndIndex)');
{
  const N = 50;
  const trail: SwingTrailPoint[] = [];
  for (let i = 0; i < N; i++) {
    let x = 0.3;
    if (i >= 10 && i < 20) x = 0.3 + (i - 9) * 0.016;        // feint up to ~0.46 (0.16 raw = 0.2 BH)
    else if (i >= 20 && i < 30) x = 0.46 - (i - 19) * 0.016; // reverse back to 0.30
    // i >= 30: flat 0.30 again (no committed takeaway)
    trail.push(makeLeadPoint(x, i));
  }
  const r = findTakeawayOnsetFaceOn(trail, makeBodyFrames(N));

  assertEq(r.onsetTrailIdx, null, 'T7: onset null (declines to override)');
  assert(!r.fired, 'T7: did not fire');
  assertEq(r.fallbackReason, 'no_confirmed_trigger', 'T7: reason = no_confirmed_trigger');
  assertClose(r.lockedBodyHeight, BH, 1e-9, 'T7: lockedBodyHeight still reported');
  assert((r.travelBH ?? 1) < 0.5, `T7: peak travel < 0.5 BH (got ${r.travelBH})`);
  // Caller contract: `onset.onsetTrailIdx ?? findSetupEndIndex(...)` ⇒ uses the legacy gate.
  const smoothed = computeSmoothed(trail);
  const fallback = findSetupEndIndex(smoothed, trail);
  assertEq(r.onsetTrailIdx ?? fallback, fallback, 'T7: caller-equivalent fallback == findSetupEndIndex');
}

// ---------------------------------------------------------------------------
// T8 — Feint <0.5 BH THEN a real ≥0.5 BH takeaway (synthetic 6623e3e8)
// ---------------------------------------------------------------------------
group('T8. Feint then real takeaway → onset at post-feint bottom, NOT the feint');
{
  const N = 50;
  const trail: SwingTrailPoint[] = [];
  for (let i = 0; i < N; i++) {
    let x = 0.3;
    if (i >= 10 && i < 20) x = 0.3 + (i - 9) * 0.016;        // feint up to ~0.46 (0.2 BH)
    else if (i >= 20 && i < 30) x = 0.46 - (i - 19) * 0.016; // reversal back to 0.30 (valley)
    else if (i >= 30) x = 0.3 + (i - 29) * 0.04;             // real takeaway to 0.30+0.80 = 1.10 (1.0 BH)
    trail.push(makeLeadPoint(x, i));
  }
  const r = findTakeawayOnsetFaceOn(trail, makeBodyFrames(N));

  assert(r.fired, 'T8: fired on the real takeaway');
  assert(r.onsetTrailIdx !== null, 'T8: onset returned');
  // Onset must be the post-feint valley bottom (~frame 29-30), NOT the feint
  // origin (~frame 10). This is the bug the rule fixes.
  assert(r.onsetTrailIdx! > 20, `T8: onset past the feint, not at its origin (got ${r.onsetTrailIdx})`);
  assert(r.onsetTrailIdx! >= 24 && r.onsetTrailIdx! <= 34, `T8: onset at the takeaway valley bottom (got ${r.onsetTrailIdx})`);
  assert((r.travelBH ?? 0) >= 0.5, `T8: travelBH ≥ 0.5 (got ${r.travelBH})`);
}

// ---------------------------------------------------------------------------
// T9 — Ruler unreliable (low confidence / too few frames) → null → fallback
// ---------------------------------------------------------------------------
group('T9. Ruler unreliable → null (caller falls back)');
{
  const N = 50;
  const trail: SwingTrailPoint[] = [];
  for (let i = 0; i < N; i++) trail.push(makeLeadPoint(i < 10 ? 0.3 : 0.3 + (i - 9) * 0.02, i));

  // 9a — nose/ankle confidence below 0.5 everywhere ⇒ 0 valid frames.
  const rLowConf = findTakeawayOnsetFaceOn(trail, makeBodyFrames(N, 0.3));
  assertEq(rLowConf.onsetTrailIdx, null, 'T9a: low-confidence ruler → onset null');
  assertEq(rLowConf.fallbackReason, 'ruler_unreliable', 'T9a: reason = ruler_unreliable');
  assertEq(rLowConf.lockedBodyHeight, null, 'T9a: lockedBodyHeight null when ruler unreliable');

  // 9b — fewer than 20 confident frames (15) ⇒ ruler unreliable.
  const shortTrail = trail.slice(0, 15);
  const rFew = findTakeawayOnsetFaceOn(shortTrail, makeBodyFrames(15, 0.9));
  assertEq(rFew.onsetTrailIdx, null, 'T9b: <20 confident frames → onset null');
  assertEq(rFew.fallbackReason, 'ruler_unreliable', 'T9b: reason = ruler_unreliable');
}

// ---------------------------------------------------------------------------
// T10 — Onset past 0.6 * lastIdx → null, but candidate still reported
// ---------------------------------------------------------------------------
group('T10. Late onset (past 0.6 cap) → null with candidate telemetry');
{
  const N = 100;                 // lastIdx = 99, cap = 0.6 * 99 = 59.4
  const trail: SwingTrailPoint[] = [];
  for (let i = 0; i < N; i++) trail.push(makeLeadPoint(i < 85 ? 0.3 : 0.3 + (i - 84) * 0.04, i));
  const r = findTakeawayOnsetFaceOn(trail, makeBodyFrames(N));

  assertEq(r.onsetTrailIdx, null, 'T10: late onset → onset null');
  assertEq(r.fallbackReason, 'onset_too_late', 'T10: reason = onset_too_late');
  assert(!r.fired, 'T10: did not fire');
  assert(r.candidateTrailIdx !== null && r.candidateTrailIdx! > 59, `T10: candidate reported past cap (got ${r.candidateTrailIdx})`);
  assertClose(r.lockedBodyHeight, BH, 1e-9, 'T10: lockedBodyHeight reported on fallback');
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
  console.log('✅ All phaseDetection tests passed');
}
