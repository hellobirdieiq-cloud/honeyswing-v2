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
  return { x, y, timestamp: frameIdx * FRAME_DT_MS };
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
