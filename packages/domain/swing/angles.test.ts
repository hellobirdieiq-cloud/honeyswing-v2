/**
 * angles.test.ts — Tests for calculateGolfAngles
 *
 * Every expected value is derived from angles.ts source:
 *   - MIN_CONFIDENCE = 0.5, inclusive >=            (angles.ts:67, :73-75)
 *   - per-metric joint guards → independent nulls   (angles.ts:92-129)
 *   - angleBetween: interior angle at middle joint, rounded degrees;
 *     zero-length vector → 0                        (angles.ts:38-48, :45)
 *   - spineAngle: midpoint(shoulders) vs midpoint(hips) angle-to-vertical
 *     via abs(dy)/mag                               (angles.ts:56-65, :91-96)
 *   - hipSpreadDelta = round(abs(rh.x − lh.x) × 100)  (angles.ts:118-121)
 *   - shoulderTilt = round(atan2(dy, abs(dx)) in deg) (angles.ts:123-129)
 *   - Z_RANGE_THRESHOLD = 0.02, z used only when finite-z count ≥ 2 AND
 *     max−min >= threshold                          (angles.ts:28, :30-36)
 *   - spineDrift always null here (pipeline fills it) (angles.ts:139)
 *
 * Geometry expectations are hand-derived in the comments per case.
 * Coordinates are normalized screen space: y grows DOWNWARD.
 *
 * Run with: npx --yes tsx packages/domain/swing/angles.test.ts
 */

import { calculateGolfAngles, Z_RANGE_THRESHOLD } from './angles';
import { createEmptyJoints } from '../../pose/PoseTypes';
import type { JointName, NormalizedJoint, PoseFrame } from '../../pose/PoseTypes';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joint(
  name: JointName,
  x: number,
  y: number,
  opts: { z?: number; confidence?: number } = {},
): NormalizedJoint {
  return { name, x, y, confidence: opts.confidence ?? 0.9, ...(opts.z != null ? { z: opts.z } : {}) };
}

function makeFrame(joints: NormalizedJoint[]): PoseFrame {
  const map = createEmptyJoints();
  for (const j of joints) map[j.name] = j;
  return { timestampMs: 0, joints: map, frameWidth: 1080, frameHeight: 1920 };
}

console.log('\n=== Angles Module Tests ===');

// ---------------------------------------------------------------------------
// Section A — confidence gating (MIN_CONFIDENCE 0.5, angles.ts:67, :73-75)
// ---------------------------------------------------------------------------

group('A. Confidence gating');

{
  const angles = calculateGolfAngles(makeFrame([]));
  const allNull = Object.values(angles).every((v) => v === null);
  assert(allNull, 'A1: empty frame → every field null (guards :92-129, spineDrift :139)');
}
{
  // Left arm present but wrist below threshold
  const angles = calculateGolfAngles(
    makeFrame([
      joint('leftShoulder', 0.3, 0.2),
      joint('leftElbow', 0.3, 0.4),
      joint('leftWrist', 0.3, 0.6, { confidence: 0.49 }),
    ]),
  );
  assertEq(angles.leftElbowAngle, null, 'A2: wrist confidence 0.49 < 0.5 → leftElbowAngle null (:74)');
}
{
  const angles = calculateGolfAngles(
    makeFrame([
      joint('leftShoulder', 0.3, 0.2),
      joint('leftElbow', 0.3, 0.4),
      joint('leftWrist', 0.3, 0.6, { confidence: 0.5 }),
    ]),
  );
  assertEq(angles.leftElbowAngle, 180, 'A3: confidence exactly 0.5 passes (inclusive >=, :74)');
}
{
  // confidence omitted → isGood treats as 0 (?? 0, :74)
  const noConf: NormalizedJoint = { name: 'leftWrist', x: 0.3, y: 0.6 };
  const map = createEmptyJoints();
  map.leftShoulder = joint('leftShoulder', 0.3, 0.2);
  map.leftElbow = joint('leftElbow', 0.3, 0.4);
  map.leftWrist = noConf;
  const angles = calculateGolfAngles({ timestampMs: 0, joints: map, frameWidth: 1080, frameHeight: 1920 });
  assertEq(angles.leftElbowAngle, null, 'A4: missing confidence treated as 0 → null (?? 0, :74)');
}
{
  // Only shoulders + hips good → torso metrics computed, limbs null (independent guards)
  const angles = calculateGolfAngles(
    makeFrame([
      joint('leftShoulder', 0.4, 0.2),
      joint('rightShoulder', 0.6, 0.2),
      joint('leftHip', 0.4, 0.6),
      joint('rightHip', 0.6, 0.6),
    ]),
  );
  assert(angles.spineAngle !== null, 'A5a: spineAngle computed from shoulders+hips (:92)');
  assert(angles.shoulderTilt !== null, 'A5b: shoulderTilt computed from shoulders (:124)');
  assert(angles.hipSpreadDelta !== null, 'A5c: hipSpreadDelta computed from hips (:119)');
  assertEq(angles.leftElbowAngle, null, 'A5d: leftElbowAngle null without arm joints (:99)');
  assertEq(angles.rightKneeAngle, null, 'A5e: rightKneeAngle null without leg joints (:114)');
}

// ---------------------------------------------------------------------------
// Section B — angleBetween geometry (angles.ts:38-48)
// ---------------------------------------------------------------------------

group('B. angleBetween geometry');

{
  // Collinear vertical arm: ba=(0,−0.2), bc=(0,0.2) → cos=−1 → 180°
  const angles = calculateGolfAngles(
    makeFrame([joint('leftShoulder', 0.3, 0.2), joint('leftElbow', 0.3, 0.4), joint('leftWrist', 0.3, 0.6)]),
  );
  assertEq(angles.leftElbowAngle, 180, 'B1: collinear shoulder-elbow-wrist → 180°');
}
{
  // Right angle: ba=(0,−0.2), bc=(0.2,0) → dot=0 → 90°
  const angles = calculateGolfAngles(
    makeFrame([joint('rightShoulder', 0.5, 0.2), joint('rightElbow', 0.5, 0.4), joint('rightWrist', 0.7, 0.4)]),
  );
  assertEq(angles.rightElbowAngle, 90, 'B2: perpendicular limb segments → 90°');
}
{
  // 45°: ba=(0,−0.2), bc=(0.2,−0.2) → cos = 0.04/(0.2×0.28284) = 0.7071 → 45°
  const angles = calculateGolfAngles(
    makeFrame([joint('leftHip', 0.4, 0.5), joint('leftKnee', 0.4, 0.7), joint('leftAnkle', 0.6, 0.5)]),
  );
  assertEq(angles.leftKneeAngle, 45, 'B3: hand-derived 45° knee (cos = √2/2)');
}
{
  // Coincident hip and knee → zero-length ba → 0 (:45)
  const angles = calculateGolfAngles(
    makeFrame([joint('rightHip', 0.5, 0.5), joint('rightKnee', 0.5, 0.5), joint('rightAnkle', 0.5, 0.8)]),
  );
  assertEq(angles.rightKneeAngle, 0, 'B4: zero-length vector (hip == knee) → 0 (:45)');
}

// ---------------------------------------------------------------------------
// Section C — spineAngle via midpoints + angle-to-vertical (angles.ts:56-65, :91-96)
// ---------------------------------------------------------------------------

group('C. spineAngle');

{
  // shoulderMid (0.5,0.2), hipMid (0.5,0.6): dx=0 → perfectly vertical → 0°
  const angles = calculateGolfAngles(
    makeFrame([
      joint('leftShoulder', 0.4, 0.2),
      joint('rightShoulder', 0.6, 0.2),
      joint('leftHip', 0.4, 0.6),
      joint('rightHip', 0.6, 0.6),
    ]),
  );
  assertEq(angles.spineAngle, 0, 'C1: vertical spine → 0° from vertical');
}
{
  // shoulderMid (0.7,0.2), hipMid (0.3,0.6): dx=0.4, dy=−0.4 → abs(dy)/mag=√2/2 → 45°
  const angles = calculateGolfAngles(
    makeFrame([
      joint('leftShoulder', 0.6, 0.2),
      joint('rightShoulder', 0.8, 0.2),
      joint('leftHip', 0.2, 0.6),
      joint('rightHip', 0.4, 0.6),
    ]),
  );
  assertEq(angles.spineAngle, 45, 'C2: hand-derived 45° lean');
}
{
  // shoulderMid (0.7,0.6), hipMid (0.3,0.6): dy=0 → acos(0) → 90°
  const angles = calculateGolfAngles(
    makeFrame([
      joint('leftShoulder', 0.6, 0.6),
      joint('rightShoulder', 0.8, 0.6),
      joint('leftHip', 0.2, 0.6),
      joint('rightHip', 0.4, 0.6),
    ]),
  );
  assertEq(angles.spineAngle, 90, 'C3: horizontal spine → 90° from vertical');
}

// ---------------------------------------------------------------------------
// Section D — hipSpreadDelta (angles.ts:118-121)
// ---------------------------------------------------------------------------

group('D. hipSpreadDelta');

{
  // abs(0.53 − 0.40) × 100 = 13
  const angles = calculateGolfAngles(makeFrame([joint('leftHip', 0.4, 0.6), joint('rightHip', 0.53, 0.6)]));
  assertEq(angles.hipSpreadDelta, 13, 'D1: round(abs(Δx)×100) = 13 (:120)');
}
{
  // Reversed x-order (mirror) → abs() makes it identical
  const angles = calculateGolfAngles(makeFrame([joint('leftHip', 0.53, 0.6), joint('rightHip', 0.4, 0.6)]));
  assertEq(angles.hipSpreadDelta, 13, 'D2: mirror-invariant via abs (:120)');
}

// ---------------------------------------------------------------------------
// Section E — shoulderTilt sign convention (angles.ts:123-129)
// ---------------------------------------------------------------------------

group('E. shoulderTilt');

{
  const angles = calculateGolfAngles(makeFrame([joint('leftShoulder', 0.4, 0.5), joint('rightShoulder', 0.6, 0.5)]));
  assertEq(angles.shoulderTilt, 0, 'E1: level shoulders → 0');
}
{
  // dy = 0.55−0.5 = +0.05 (right shoulder LOWER on screen), dx=0.2 → atan2(0.05,0.2) = 14.04° → 14
  const angles = calculateGolfAngles(makeFrame([joint('leftShoulder', 0.4, 0.5), joint('rightShoulder', 0.6, 0.55)]));
  assertEq(angles.shoulderTilt, 14, 'E2: right shoulder lower → +14 (dy>0, :125-128)');
}
{
  // dy = −0.05 (right shoulder HIGHER) → −14
  const angles = calculateGolfAngles(makeFrame([joint('leftShoulder', 0.4, 0.55), joint('rightShoulder', 0.6, 0.5)]));
  assertEq(angles.shoulderTilt, -14, 'E3: right shoulder higher → −14');
}
{
  // CHARACTERIZATION — abs(dx) at :127 makes tilt sign follow dy regardless of
  // x-order, so a horizontally mirrored pose keeps the same sign.
  const angles = calculateGolfAngles(makeFrame([joint('leftShoulder', 0.6, 0.5), joint('rightShoulder', 0.4, 0.55)]));
  assertEq(angles.shoulderTilt, 14, 'E4: x-mirrored pose → same +14 (abs(dx), :127)');
}

// ---------------------------------------------------------------------------
// Section F — z reliability (Z_RANGE_THRESHOLD 0.02, angles.ts:28, :30-36, :39-41)
// ---------------------------------------------------------------------------

group('F. z reliability');

{
  // z range 0.01 < threshold → z ignored → xy-collinear arm stays 180°
  const angles = calculateGolfAngles(
    makeFrame([
      joint('leftShoulder', 0.3, 0.2, { z: 0.10 }),
      joint('leftElbow', 0.3, 0.4, { z: 0.105 }),
      joint('leftWrist', 0.3, 0.6, { z: 0.11 }),
    ]),
  );
  assertEq(angles.leftElbowAngle, 180, `F1: z range 0.01 < ${Z_RANGE_THRESHOLD} → 2D math (:35)`);
}
{
  // Reliable z bends the xy-collinear arm: ls z=0, le z=0.2, lw z=0
  // ba=(0,−0.2,−0.2), bc=(0,0.2,−0.2) → dot = −0.04+0.04 = 0 → 90°
  const angles = calculateGolfAngles(
    makeFrame([
      joint('leftShoulder', 0.3, 0.2, { z: 0 }),
      joint('leftElbow', 0.3, 0.4, { z: 0.2 }),
      joint('leftWrist', 0.3, 0.6, { z: 0 }),
    ]),
  );
  assertEq(angles.leftElbowAngle, 90, 'F2: z range 0.2 ≥ threshold → 3D math bends 180° to 90° (:39-41)');
}
{
  // Boundary: z range exactly 0.02 engages 3D (inclusive >=, :35).
  // ba=(0,−0.2,−0.02), bc=(0,0.2,−0.02) → cos = −0.0396/0.0404 = −0.98020 → 168.58° → 169
  const angles = calculateGolfAngles(
    makeFrame([
      joint('leftShoulder', 0.3, 0.2, { z: 0 }),
      joint('leftElbow', 0.3, 0.4, { z: Z_RANGE_THRESHOLD }),
      joint('leftWrist', 0.3, 0.6, { z: 0 }),
    ]),
  );
  assertEq(angles.leftElbowAngle, 169, `F3: z range exactly ${Z_RANGE_THRESHOLD} engages 3D → 169 (inclusive >=, :35)`);
}
{
  // Only one finite z → fewer than 2 → unreliable → 2D (:34)
  const angles = calculateGolfAngles(
    makeFrame([
      joint('leftShoulder', 0.3, 0.2),
      joint('leftElbow', 0.3, 0.4, { z: 0.5 }),
      joint('leftWrist', 0.3, 0.6),
    ]),
  );
  assertEq(angles.leftElbowAngle, 180, 'F4: single finite z → unreliable → 2D math (:34)');
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
  console.log('✅ All angles tests passed');
}
