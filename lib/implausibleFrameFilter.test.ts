/**
 * implausibleFrameFilter.test.ts — Task 12 Test Suite
 *
 * Run: npx tsx lib/implausibleFrameFilter.test.ts
 * NOT Jest. Custom assert harness matching Tasks 5, 7, 8, 9, 10, 11.
 *
 * Coverage:
 *   - Core scoring (scoreFramePlausibility)
 *   - Normal frames, collapsed segments, out-of-range ratios
 *   - Boundary cases (just inside / just outside 25% deviation)
 *   - Missing/low-confidence joints → defers to visibility weighting
 *   - Knee metric uses shin:thigh reference
 *   - Metrics without limb checks → always plausible
 *   - Integration with computeFrameWeight (plausibility parameter)
 *   - Constants integrity
 */

import {
  TABLE_VERSION,
  DEVIATION_THRESHOLD,
  SEGMENT_CONFIDENCE_THRESHOLD,
  MIN_SEGMENT_LENGTH,
  FOREARM_UPPERARM_REFERENCE,
  SHIN_THIGH_REFERENCE,
  METRIC_LIMB_CHECKS,
  scoreFramePlausibility,
  type LimbSegmentCheck,
  type FramePlausibility,
} from '../packages/domain/swing/implausibleFrameFilter';

import {
  computeFrameWeight,
} from '../packages/domain/swing/visibilityWeighting';

import type { JointName, PoseFrame } from '../packages/pose/PoseTypes';

// ---------------------------------------------------------------------------
// Test harness (matches existing suites)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let currentGroup = '';

function group(name: string): void {
  currentGroup = name;
}

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL [${currentGroup}]: ${msg}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL [${currentGroup}]: ${msg} — expected ${expected}, got ${actual}`);
  }
}

function assertApprox(actual: number, expected: number, tolerance: number, msg: string): void {
  if (Number.isNaN(expected) && Number.isNaN(actual)) {
    passed++;
    return;
  }
  if (Math.abs(actual - expected) <= tolerance) {
    passed++;
  } else {
    failed++;
    console.error(
      `  FAIL [${currentGroup}]: ${msg} — expected ~${expected} (±${tolerance}), got ${actual}`
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal PoseFrame with specified joints. */
function makeFrame(joints: Partial<Record<JointName, { x: number; y: number; confidence?: number }>>): PoseFrame {
  const fullJoints = {} as Record<JointName, { name: JointName; x: number; y: number; confidence?: number } | undefined>;
  for (const [name, data] of Object.entries(joints)) {
    fullJoints[name as JointName] = {
      name: name as JointName,
      x: data!.x,
      y: data!.y,
      confidence: data!.confidence ?? 0.9,
    };
  }
  return {
    timestampMs: 0,
    joints: fullJoints,
    frameWidth: 1080,
    frameHeight: 1920,
  };
}

/** Create a frame with anatomically normal arm proportions (ratio ~target). */
function makeNormalArmFrame(ratio = 0.94): PoseFrame {
  // shoulder at (0.3, 0.3), elbow at (0.3, 0.5) → upperArm = 0.2
  // wrist offset to produce desired ratio: forearm = ratio * 0.2
  const forearmLen = ratio * 0.2;
  return makeFrame({
    leftShoulder: { x: 0.3, y: 0.3 },
    leftElbow: { x: 0.3, y: 0.5 },
    leftWrist: { x: 0.3, y: 0.5 + forearmLen },
    rightShoulder: { x: 0.7, y: 0.3 },
    rightElbow: { x: 0.7, y: 0.5 },
    rightWrist: { x: 0.7, y: 0.5 + forearmLen },
  });
}

/** Create a frame with anatomically normal leg proportions (ratio ~target). */
function makeNormalLegFrame(ratio = 0.90): PoseFrame {
  // hip at (0.4, 0.5), knee at (0.4, 0.75) → thigh = 0.25
  // ankle offset to produce desired ratio: shin = ratio * 0.25
  const shinLen = ratio * 0.25;
  return makeFrame({
    leftHip: { x: 0.4, y: 0.5 },
    leftKnee: { x: 0.4, y: 0.75 },
    leftAnkle: { x: 0.4, y: 0.75 + shinLen },
    rightHip: { x: 0.6, y: 0.5 },
    rightKnee: { x: 0.6, y: 0.75 },
    rightAnkle: { x: 0.6, y: 0.75 + shinLen },
  });
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
group('Constants integrity');
// ---------------------------------------------------------------------------

assertEq(TABLE_VERSION, '12.1.0', 'TABLE_VERSION matches expected');
assertApprox(DEVIATION_THRESHOLD, 0.25, 0.001, 'DEVIATION_THRESHOLD = 0.25');
assertApprox(SEGMENT_CONFIDENCE_THRESHOLD, 0.3, 0.001, 'SEGMENT_CONFIDENCE_THRESHOLD = 0.3');
assertApprox(MIN_SEGMENT_LENGTH, 0.01, 0.001, 'MIN_SEGMENT_LENGTH = 0.01');
assertApprox(FOREARM_UPPERARM_REFERENCE, 0.94, 0.001, 'FOREARM_UPPERARM_REFERENCE = 0.94');
assertApprox(SHIN_THIGH_REFERENCE, 0.90, 0.001, 'SHIN_THIGH_REFERENCE = 0.90');

// ---------------------------------------------------------------------------
group('METRIC_LIMB_CHECKS coverage');
// ---------------------------------------------------------------------------

assert(METRIC_LIMB_CHECKS['leftElbowAngle'] != null, 'leftElbowAngle has limb check');
assert(METRIC_LIMB_CHECKS['rightElbowAngle'] != null, 'rightElbowAngle has limb check');
assert(METRIC_LIMB_CHECKS['leftKneeAngle'] != null, 'leftKneeAngle has limb check');
assert(METRIC_LIMB_CHECKS['rightKneeAngle'] != null, 'rightKneeAngle has limb check');
assert(METRIC_LIMB_CHECKS['spineAngle'] == null, 'spineAngle has no limb check');
assert(METRIC_LIMB_CHECKS['hipSpreadDelta'] == null, 'hipSpreadDelta has no limb check');
assert(METRIC_LIMB_CHECKS['shoulderTilt'] == null, 'shoulderTilt has no limb check');

// Elbow checks use forearm/upperArm reference
assertApprox(
  METRIC_LIMB_CHECKS['leftElbowAngle']!.referenceRatio,
  FOREARM_UPPERARM_REFERENCE,
  0.001,
  'leftElbow uses forearm/upperArm reference',
);

// Knee checks use shin/thigh reference
assertApprox(
  METRIC_LIMB_CHECKS['leftKneeAngle']!.referenceRatio,
  SHIN_THIGH_REFERENCE,
  0.001,
  'leftKnee uses shin/thigh reference',
);

// ---------------------------------------------------------------------------
group('Normal frame — plausible');
// ---------------------------------------------------------------------------

{
  const frame = makeNormalArmFrame(0.94);
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 1.0, 'normal arm frame is plausible');
  assertEq(result.failedCheck, undefined, 'no failed check for normal frame');
}

{
  const frame = makeNormalLegFrame(0.90);
  const check = METRIC_LIMB_CHECKS['leftKneeAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 1.0, 'normal leg frame is plausible');
}

// ---------------------------------------------------------------------------
group('Collapsed segment');
// ---------------------------------------------------------------------------

{
  // Elbow and wrist at nearly the same position → forearm length ≈ 0
  const frame = makeFrame({
    leftShoulder: { x: 0.3, y: 0.3 },
    leftElbow: { x: 0.3, y: 0.5 },
    leftWrist: { x: 0.3, y: 0.5005 }, // forearm = 0.0005, below MIN_SEGMENT_LENGTH
  });
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 0.0, 'collapsed forearm → implausible');
  assertEq(result.failedCheck, 'segment_collapsed', 'failedCheck is segment_collapsed');
  assertEq(result.measuredRatio, 0, 'measuredRatio is 0 for collapsed segment');
}

{
  // Shoulder and elbow at nearly the same position → upperArm length ≈ 0
  const frame = makeFrame({
    leftShoulder: { x: 0.3, y: 0.3 },
    leftElbow: { x: 0.3, y: 0.3004 }, // upperArm = 0.0004
    leftWrist: { x: 0.3, y: 0.5 },
  });
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 0.0, 'collapsed upperArm → implausible');
  assertEq(result.failedCheck, 'segment_collapsed', 'proximal segment collapsed');
}

// ---------------------------------------------------------------------------
group('Extreme ratio — out of range');
// ---------------------------------------------------------------------------

{
  // Forearm much shorter than upper arm: ratio = 0.40, deviation = |0.40 - 0.94| / 0.94 = 57%
  const frame = makeNormalArmFrame(0.40);
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 0.0, 'ratio 0.40 (57% deviation) → implausible');
  assertEq(result.failedCheck, 'ratio_out_of_range', 'failedCheck is ratio_out_of_range');
  assert(result.measuredRatio != null, 'measuredRatio is set');
  assertApprox(result.measuredRatio!, 0.40, 0.02, 'measuredRatio ≈ 0.40');
}

{
  // Forearm much longer than upper arm: ratio = 1.50, deviation = |1.50 - 0.94| / 0.94 = 60%
  const frame = makeNormalArmFrame(1.50);
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 0.0, 'ratio 1.50 (60% deviation) → implausible');
}

// ---------------------------------------------------------------------------
group('Borderline — just inside 25% deviation');
// ---------------------------------------------------------------------------

{
  // ratio = 0.72, deviation = |0.72 - 0.94| / 0.94 = 23.4% < 25%
  const frame = makeNormalArmFrame(0.72);
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 1.0, 'ratio 0.72 (23.4% deviation) → plausible');
}

{
  // ratio = 1.17, deviation = |1.17 - 0.94| / 0.94 = 24.5% < 25%
  const frame = makeNormalArmFrame(1.17);
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 1.0, 'ratio 1.17 (24.5% deviation) → plausible');
}

// ---------------------------------------------------------------------------
group('Borderline — just outside 25% deviation');
// ---------------------------------------------------------------------------

{
  // ratio = 0.70, deviation = |0.70 - 0.94| / 0.94 = 25.5% > 25%
  const frame = makeNormalArmFrame(0.70);
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 0.0, 'ratio 0.70 (25.5% deviation) → implausible');
}

{
  // ratio = 1.18, deviation = |1.18 - 0.94| / 0.94 = 25.5% > 25%
  const frame = makeNormalArmFrame(1.18);
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 0.0, 'ratio 1.18 (25.5% deviation) → implausible');
}

// ---------------------------------------------------------------------------
group('Missing joint — defers to visibility weighting');
// ---------------------------------------------------------------------------

{
  // Frame with no leftWrist → cannot assess → plausible (score 1.0)
  const frame = makeFrame({
    leftShoulder: { x: 0.3, y: 0.3 },
    leftElbow: { x: 0.3, y: 0.5 },
    // leftWrist missing
  });
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 1.0, 'missing joint → plausible (defers to visibility)');
}

{
  // Frame with no leftElbow
  const frame = makeFrame({
    leftShoulder: { x: 0.3, y: 0.3 },
    // leftElbow missing
    leftWrist: { x: 0.3, y: 0.7 },
  });
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 1.0, 'missing middle joint → plausible');
}

// ---------------------------------------------------------------------------
group('Low confidence joint — defers to visibility weighting');
// ---------------------------------------------------------------------------

{
  // One joint below SEGMENT_CONFIDENCE_THRESHOLD (0.3)
  const frame = makeFrame({
    leftShoulder: { x: 0.3, y: 0.3, confidence: 0.9 },
    leftElbow: { x: 0.3, y: 0.5, confidence: 0.2 }, // below 0.3
    leftWrist: { x: 0.3, y: 0.7, confidence: 0.9 },
  });
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 1.0, 'low confidence joint → plausible (cannot assess)');
}

{
  // Joint at exactly 0.3 threshold should pass
  const frame = makeNormalArmFrame(0.94);
  // Override confidence to exactly threshold
  frame.joints.leftElbow = { ...frame.joints.leftElbow!, confidence: 0.3 };
  const check = METRIC_LIMB_CHECKS['leftElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 1.0, 'joint at exactly 0.3 confidence → can assess (plausible)');
}

// ---------------------------------------------------------------------------
group('Knee metric — shin:thigh reference');
// ---------------------------------------------------------------------------

{
  // Normal knee proportions (ratio ~0.90)
  const frame = makeNormalLegFrame(0.90);
  const check = METRIC_LIMB_CHECKS['leftKneeAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 1.0, 'knee ratio 0.90 → plausible');
}

{
  // Shin much shorter than thigh: ratio = 0.50, deviation = |0.50 - 0.90| / 0.90 = 44%
  const frame = makeNormalLegFrame(0.50);
  const check = METRIC_LIMB_CHECKS['leftKneeAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 0.0, 'knee ratio 0.50 (44% deviation) → implausible');
}

{
  // Right knee check works too
  const frame = makeNormalLegFrame(0.90);
  const check = METRIC_LIMB_CHECKS['rightKneeAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 1.0, 'right knee normal → plausible');
}

// ---------------------------------------------------------------------------
group('Right elbow — symmetric check');
// ---------------------------------------------------------------------------

{
  const frame = makeNormalArmFrame(0.94);
  const check = METRIC_LIMB_CHECKS['rightElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 1.0, 'right elbow normal ratio → plausible');
}

{
  const frame = makeNormalArmFrame(0.40);
  const check = METRIC_LIMB_CHECKS['rightElbowAngle']!;
  const result = scoreFramePlausibility(frame, check);
  assertEq(result.score, 0.0, 'right elbow extreme ratio → implausible');
}

// ---------------------------------------------------------------------------
group('Integration — computeFrameWeight with plausibility');
// ---------------------------------------------------------------------------

{
  // High visibility, plausibility = 0 → weight should be 0
  const visibilities = [0.9, 0.8, 0.85];
  const weight = computeFrameWeight(visibilities, 0.0);
  assertEq(weight, 0, 'plausibility 0 + high visibility → weight 0');
}

{
  // High visibility, plausibility = 1.0 → weight = min(visibilities) * 1.0
  const visibilities = [0.9, 0.8, 0.85];
  const weight = computeFrameWeight(visibilities, 1.0);
  assertApprox(weight, 0.8, 0.001, 'plausibility 1.0 → weight = min(vis)');
}

{
  // High visibility, plausibility undefined → same as 1.0 (backward compat)
  const visibilities = [0.9, 0.8, 0.85];
  const weight = computeFrameWeight(visibilities);
  assertApprox(weight, 0.8, 0.001, 'plausibility undefined → weight = min(vis) (backward compat)');
}

{
  // Low visibility (below threshold) + plausibility 1.0 → still 0
  const visibilities = [0.05, 0.8, 0.85];
  const weight = computeFrameWeight(visibilities, 1.0);
  assertEq(weight, 0, 'low visibility still excludes even with plausibility 1.0');
}

// ===========================================================================
// Summary
// ===========================================================================

console.log('');
console.log('=======================================');
console.log(`  Task 12 — implausibleFrameFilter tests`);
console.log(`  PASSED: ${passed}`);
console.log(`  FAILED: ${failed}`);
console.log(`  TOTAL:  ${passed + failed}`);
console.log('=======================================');

if (failed > 0) {
  process.exit(1);
}
