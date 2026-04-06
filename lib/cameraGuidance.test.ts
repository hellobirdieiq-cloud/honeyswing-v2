/**
 * cameraGuidance.test.ts — Task 13 Validation
 *
 * Run with: npx tsx lib/cameraGuidance.test.ts
 *
 * Covers:
 *   - classifyCameraAngle threshold boundaries
 *   - EMA smoothing behavior
 *   - extractShoulderSeparation with confidence gating
 *   - Edge cases (0, 1.0, exact boundaries)
 */

import {
  classifyCameraAngle,
  emaSmooth,
  extractShoulderSeparation,
  GOOD_MIN,
  GOOD_MAX,
  BORDERLINE_LOW_MIN,
  BORDERLINE_HIGH_MAX,
  EMA_ALPHA,
  type CameraGuidanceColor,
} from './cameraGuidance';

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

function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${label} (got ${actual}, expected ~${expected} ±${tolerance})`,
  );
}

// ---------------------------------------------------------------------------
// classifyCameraAngle tests
// ---------------------------------------------------------------------------

group('classifyCameraAngle — good range');
assertEq(classifyCameraAngle(0.15).color, 'good', 'GOOD_MIN boundary → good');
assertEq(classifyCameraAngle(0.25).color, 'good', 'mid-range → good');
assertEq(classifyCameraAngle(0.35).color, 'good', 'GOOD_MAX boundary → good');

group('classifyCameraAngle — borderline range (low)');
assertEq(classifyCameraAngle(0.08).color, 'borderline', 'BORDERLINE_LOW_MIN → borderline');
assertEq(classifyCameraAngle(0.10).color, 'borderline', 'between low bounds → borderline');
assertEq(classifyCameraAngle(0.149).color, 'borderline', 'just below GOOD_MIN → borderline');

group('classifyCameraAngle — borderline range (high)');
assertEq(classifyCameraAngle(0.351).color, 'borderline', 'just above GOOD_MAX → borderline');
assertEq(classifyCameraAngle(0.40).color, 'borderline', 'between high bounds → borderline');
assertEq(classifyCameraAngle(0.45).color, 'borderline', 'BORDERLINE_HIGH_MAX → borderline');

group('classifyCameraAngle — poor range');
assertEq(classifyCameraAngle(0).color, 'poor', 'zero → poor');
assertEq(classifyCameraAngle(0.05).color, 'poor', 'below BORDERLINE_LOW_MIN → poor');
assertEq(classifyCameraAngle(0.079).color, 'poor', 'just below 0.08 → poor');
assertEq(classifyCameraAngle(0.451).color, 'poor', 'just above BORDERLINE_HIGH_MAX → poor');
assertEq(classifyCameraAngle(1.0).color, 'poor', 'extreme value → poor');

group('classifyCameraAngle — labels');
assertEq(classifyCameraAngle(0.25).label, 'Great angle', 'good → Great angle');
assertEq(classifyCameraAngle(0.10).label, 'Adjust angle', 'borderline → Adjust angle');
assertEq(classifyCameraAngle(0.02).label, 'Move to the side', 'poor → Move to the side');

group('classifyCameraAngle — threshold constants sanity');
assert(GOOD_MIN === 0.15, 'GOOD_MIN = 0.15');
assert(GOOD_MAX === 0.35, 'GOOD_MAX = 0.35');
assert(BORDERLINE_LOW_MIN === 0.08, 'BORDERLINE_LOW_MIN = 0.08');
assert(BORDERLINE_HIGH_MAX === 0.45, 'BORDERLINE_HIGH_MAX = 0.45');
assert(BORDERLINE_LOW_MIN < GOOD_MIN, 'borderline low < good min');
assert(GOOD_MAX < BORDERLINE_HIGH_MAX, 'good max < borderline high');

// ---------------------------------------------------------------------------
// emaSmooth tests
// ---------------------------------------------------------------------------

group('emaSmooth');
assertEq(emaSmooth(null, 0.5), 0.5, 'null previous → returns newValue directly');
assertClose(emaSmooth(0.5, 0.5), 0.5, 0.001, 'same value → no change');
assertClose(
  emaSmooth(0.0, 1.0, 0.3),
  0.3,
  0.001,
  'ema(0, 1, 0.3) = 0.3',
);
assertClose(
  emaSmooth(0.5, 1.0, 0.3),
  0.65,
  0.001,
  'ema(0.5, 1.0, 0.3) = 0.65',
);
assertClose(
  emaSmooth(0.8, 0.2, 0.3),
  0.62,
  0.001,
  'ema(0.8, 0.2, 0.3) = 0.62',
);

group('emaSmooth — convergence');
{
  let ema: number | null = null;
  for (let i = 0; i < 20; i++) {
    ema = emaSmooth(ema, 0.25);
  }
  assertClose(ema!, 0.25, 0.001, 'converges to constant input after 20 iterations');
}

// ---------------------------------------------------------------------------
// extractShoulderSeparation tests
// ---------------------------------------------------------------------------

group('extractShoulderSeparation — valid landmarks');
{
  const landmarks = [
    { name: 'leftShoulder', x: 0.3, y: 0.5, inFrameLikelihood: 0.9 },
    { name: 'rightShoulder', x: 0.6, y: 0.5, inFrameLikelihood: 0.9 },
    { name: 'leftHip', x: 0.35, y: 0.7, inFrameLikelihood: 0.8 },
  ];
  assertClose(extractShoulderSeparation(landmarks)!, 0.3, 0.001, 'separation = |0.6 - 0.3| = 0.3');
}

group('extractShoulderSeparation — low confidence');
{
  const landmarks = [
    { name: 'leftShoulder', x: 0.3, y: 0.5, inFrameLikelihood: 0.4 },
    { name: 'rightShoulder', x: 0.6, y: 0.5, inFrameLikelihood: 0.9 },
  ];
  assertEq(extractShoulderSeparation(landmarks), null, 'left shoulder below threshold → null');
}
{
  const landmarks = [
    { name: 'leftShoulder', x: 0.3, y: 0.5, inFrameLikelihood: 0.9 },
    { name: 'rightShoulder', x: 0.6, y: 0.5, inFrameLikelihood: 0.3 },
  ];
  assertEq(extractShoulderSeparation(landmarks), null, 'right shoulder below threshold → null');
}

group('extractShoulderSeparation — missing shoulders');
{
  const landmarks = [
    { name: 'leftHip', x: 0.3, y: 0.7, inFrameLikelihood: 0.9 },
    { name: 'rightHip', x: 0.6, y: 0.7, inFrameLikelihood: 0.9 },
  ];
  assertEq(extractShoulderSeparation(landmarks), null, 'no shoulders → null');
}

group('extractShoulderSeparation — custom confidence threshold');
{
  const landmarks = [
    { name: 'leftShoulder', x: 0.3, y: 0.5, inFrameLikelihood: 0.3 },
    { name: 'rightShoulder', x: 0.6, y: 0.5, inFrameLikelihood: 0.3 },
  ];
  assertEq(extractShoulderSeparation(landmarks, 0.2) !== null, true, 'lowered threshold → not null');
  assertEq(extractShoulderSeparation(landmarks, 0.5), null, 'higher threshold → null');
}

group('extractShoulderSeparation — empty array');
assertEq(extractShoulderSeparation([]), null, 'empty array → null');

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
  console.log('✅ All tests passed — Task 13 camera guidance validated');
}
