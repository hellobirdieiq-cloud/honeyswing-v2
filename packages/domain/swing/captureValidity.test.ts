/**
 * captureValidity.test.ts — Comprehensive tests for isGoodFrame and classifyCapture
 *
 * Run with: npx tsx packages/domain/swing/captureValidity.test.ts
 */

import {
  isGoodFrame,
  classifyCapture,
  VALID_MIN_FRAMES,
  VALID_MIN_POSE_RATE,
  PARTIAL_MIN_FRAMES,
  PARTIAL_MIN_POSE_RATE,
  JOINT_CONFIDENCE_THRESHOLD,
} from './captureValidity';
import type { PoseFrame, JointName } from '../../pose/PoseTypes';
import { createEmptyJoints } from '../../pose/PoseTypes';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let currentGroup = '';

function group(name: string): void {
  currentGroup = name;
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
// Helpers
// ---------------------------------------------------------------------------

const KEY_JOINTS: JointName[] = [
  'leftShoulder', 'rightShoulder', 'leftHip', 'rightHip',
  'leftElbow', 'rightElbow', 'leftKnee', 'rightKnee',
];

function makeFrame(confidentKeyJointCount: number, confidence = 0.9): PoseFrame {
  const joints = createEmptyJoints();
  for (let i = 0; i < confidentKeyJointCount && i < KEY_JOINTS.length; i++) {
    const name = KEY_JOINTS[i];
    joints[name] = { name, x: 0.5, y: 0.5, confidence };
  }
  return { timestampMs: 0, joints, frameWidth: 1080, frameHeight: 1920 };
}

function makeFrameArray(totalCount: number, goodCount: number): PoseFrame[] {
  const frames: PoseFrame[] = [];
  for (let i = 0; i < goodCount; i++) {
    frames.push(makeFrame(8)); // all 8 key joints confident
  }
  for (let i = 0; i < totalCount - goodCount; i++) {
    frames.push(makeFrame(0)); // no confident joints
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Section A — isGoodFrame
// ---------------------------------------------------------------------------

console.log('\n=== Capture Validity Tests ===');

group('A. isGoodFrame');

// A1: All 8 key joints confident → true
assertEq(isGoodFrame(makeFrame(8)), true, 'A1: all 8 key joints confident → true');

// A2: Exactly MIN_KEY_JOINTS_PER_FRAME (4) joints confident → true
assertEq(isGoodFrame(makeFrame(4)), true, 'A2: exactly 4 key joints → true (boundary)');

// A3: One fewer than minimum → false
assertEq(isGoodFrame(makeFrame(3)), false, 'A3: 3 key joints → false (one below min)');

// A4: All joints at exactly JOINT_CONFIDENCE_THRESHOLD (0.3) → true
assertEq(
  isGoodFrame(makeFrame(8, JOINT_CONFIDENCE_THRESHOLD)),
  true,
  'A4: all joints at exact threshold (0.3) → true (>= check)',
);

// A5: All joints at threshold minus 0.01 → false
assertEq(
  isGoodFrame(makeFrame(8, JOINT_CONFIDENCE_THRESHOLD - 0.01)),
  false,
  'A5: all joints at 0.29 → false',
);

// A6: No key joints defined → false
assertEq(isGoodFrame(makeFrame(0)), false, 'A6: no key joints → false');

// A7: Non-key joints only (nose, leftWrist at 0.9) → false
{
  const joints = createEmptyJoints();
  joints['nose'] = { name: 'nose', x: 0.5, y: 0.5, confidence: 0.9 };
  joints['leftWrist'] = { name: 'leftWrist', x: 0.5, y: 0.5, confidence: 0.9 };
  const frame: PoseFrame = { timestampMs: 0, joints, frameWidth: 1080, frameHeight: 1920 };
  assertEq(isGoodFrame(frame), false, 'A7: non-key joints only → false');
}

// A8: Empty joints object → false
{
  const frame: PoseFrame = {
    timestampMs: 0,
    joints: createEmptyJoints(),
    frameWidth: 1080,
    frameHeight: 1920,
  };
  assertEq(isGoodFrame(frame), false, 'A8: empty joints → false');
}

// ---------------------------------------------------------------------------
// Section B — classifyCapture
// ---------------------------------------------------------------------------

group('B1. Valid: VALID_MIN_FRAMES, 100% good');
{
  const frames = makeFrameArray(VALID_MIN_FRAMES, VALID_MIN_FRAMES);
  const result = classifyCapture(frames);
  assertEq(result.validity, 'valid', 'validity = valid');
  assertEq(result.reason, null, 'reason = null');
}

group('B2. Valid: many frames, above VALID_MIN_POSE_RATE');
{
  // 60 frames, 50 good → rate = 50/60 ≈ 0.833
  const frames = makeFrameArray(60, 50);
  const result = classifyCapture(frames);
  assertEq(result.validity, 'valid', 'validity = valid');
}

group('B3. Valid boundary: exactly VALID_MIN_FRAMES, exactly VALID_MIN_POSE_RATE');
{
  // 30 frames, need rate = 0.70 → 21 good (21/30 = 0.70)
  const frames = makeFrameArray(30, 21);
  const result = classifyCapture(frames);
  assertEq(result.validity, 'valid', 'validity = valid at exact boundary');
  assertEq(result.reason, null, 'reason = null');
}

group('B4. Partial (few frames): between PARTIAL and VALID min frames');
{
  // 20 frames, 18 good → rate = 0.90, but frameCount < 30
  const frames = makeFrameArray(20, 18);
  const result = classifyCapture(frames);
  assertEq(result.validity, 'partial', 'validity = partial');
  assertEq(result.reason, 'Try a slower, fuller swing next time.', 'reason mentions slower swing');
}

group('B5. Partial (low quality): >= VALID_MIN_FRAMES, rate between thresholds');
{
  // 30 frames, 15 good → rate = 0.50 (between 0.40 and 0.70)
  const frames = makeFrameArray(30, 15);
  const result = classifyCapture(frames);
  assertEq(result.validity, 'partial', 'validity = partial');
  assertEq(result.reason, 'Step back a bit so we can see you better.', 'reason mentions step back');
}

group('B6. Partial boundary: exactly PARTIAL_MIN_FRAMES, exactly PARTIAL_MIN_POSE_RATE');
{
  // 15 frames, need rate = 0.40 → 6 good (6/15 = 0.40)
  const frames = makeFrameArray(15, 6);
  const result = classifyCapture(frames);
  assertEq(result.validity, 'partial', 'validity = partial at exact boundary');
}

group('B7. Invalid (too quick): fewer than PARTIAL_MIN_FRAMES');
{
  const frames = makeFrameArray(10, 10);
  const result = classifyCapture(frames);
  assertEq(result.validity, 'invalid', 'validity = invalid');
  assertEq(result.reason, 'The swing was too quick to catch.', 'reason = too quick');
}

group('B8. Invalid (can\'t see): >= PARTIAL_MIN_FRAMES, below PARTIAL_MIN_POSE_RATE');
{
  // 20 frames, 5 good → rate = 0.25 (below 0.40)
  const frames = makeFrameArray(20, 5);
  const result = classifyCapture(frames);
  assertEq(result.validity, 'invalid', 'validity = invalid');
  assertEq(result.reason, 'We couldn\u2019t see you clearly enough.', 'reason = couldn\u2019t see');
}

group('B9. Empty array');
{
  const result = classifyCapture([]);
  assertEq(result.validity, 'invalid', 'validity = invalid');
  assertEq(result.frameCount, 0, 'frameCount = 0');
  assertEq(result.poseSuccessRate, 0, 'poseSuccessRate = 0');
}

group('B10. Single frame');
{
  const result = classifyCapture(makeFrameArray(1, 1));
  assertEq(result.validity, 'invalid', 'validity = invalid');
}

group('B11. One frame short of partial minimum');
{
  // 14 frames (PARTIAL_MIN_FRAMES - 1), all good
  const frames = makeFrameArray(PARTIAL_MIN_FRAMES - 1, PARTIAL_MIN_FRAMES - 1);
  const result = classifyCapture(frames);
  assertEq(result.validity, 'invalid', 'validity = invalid (14 frames)');
  assertEq(result.reason, 'The swing was too quick to catch.', 'reason = too quick');
}

group('B12. Output shape: frameCount, goodFrameCount, poseSuccessRate');
{
  const frames = makeFrameArray(40, 32);
  const result = classifyCapture(frames);
  assertEq(result.frameCount, 40, 'frameCount = 40');
  assertEq(result.goodFrameCount, 32, 'goodFrameCount = 32');
  assert(typeof result.poseSuccessRate === 'number', 'poseSuccessRate is number');
  assert(typeof result.validity === 'string', 'validity is string');
  assert(result.reason === null || typeof result.reason === 'string', 'reason is string|null');
}

group('B13. poseSuccessRate = goodFrameCount / frameCount');
{
  const frames = makeFrameArray(40, 32);
  const result = classifyCapture(frames);
  assertEq(result.poseSuccessRate, 32 / 40, 'poseSuccessRate = 32/40 = 0.80');
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
  console.log('✅ All capture validity tests passed');
}
