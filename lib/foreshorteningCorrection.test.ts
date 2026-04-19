/**
 * foreshorteningCorrection.test.ts — Task 5 Comprehensive Validation
 *
 * Run with: npx tsx lib/foreshorteningCorrection.test.ts
 *   (from honeyswing-v2 root — same runner as Tasks 7 & 8)
 *
 * Covers:
 *   - estimateAngleDegrees: spread → degrees, edge cases, NaN
 *   - correctAngleFromVertical: spine correction, identity, 90° edge, NaN
 *   - correctJointAngle: elbow/knee correction, 180° edge, NaN
 *   - correctHipRotation: pure horizontal, NaN
 *   - correctForeshortening: full pipeline, all guards, NaN metrics
 *   - Guard boundaries: exact MIN (10°) and MAX (75°) thresholds
 *   - Immutability: original angles not mutated
 *   - shoulderTilt NOT corrected
 *   - Debug output shape + corrections.before matches input
 *   - Roadmap validation: 45° roundtrip within 5° for spine, hip, elbow, knee
 *   - Monotonicity: larger camera angle → larger correction
 *   - Constants validation
 */

import {
  estimateAngleDegrees,
  correctForeshortening,
  _testExports,
  type CorrectionResult,
  type ForeshorteningDebug,
} from '../packages/domain/swing/foreshorteningCorrection';

import type { GolfAngles } from '../packages/domain/swing/angles';
import type { CameraAngleResult } from '../packages/domain/swing/cameraAngle';

const {
  MIN_CORRECTION_ANGLE,
  MAX_CORRECTION_ANGLE,
  FACE_ON_REFERENCE_SPREAD,
  correctAngleFromVertical,
  correctJointAngle,
  correctHipRotation,
} = _testExports;

// ---------------------------------------------------------------------------
// Test harness (matches Task 7/8 pattern)
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

function assertApprox(actual: number, expected: number, tolerance: number, label: string): void {
  const diff = Math.abs(actual - expected);
  assert(
    diff <= tolerance,
    `${label} (got ${actual}, expected ${expected} ±${tolerance}, diff=${diff.toFixed(2)})`,
  );
}

function assertNull<T>(val: T | null, label: string): void {
  assert(val === null, `${label} (expected null, got ${JSON.stringify(val)})`);
}

function assertNotNull<T>(val: T | null | undefined, label: string): void {
  assert(val !== null && val !== undefined, `${label} (got ${JSON.stringify(val)})`);
}

function assertNaN(val: number, label: string): void {
  assert(Number.isNaN(val), `${label} (expected NaN, got ${val})`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAngles(overrides?: Partial<GolfAngles>): GolfAngles {
  return {
    spineAngle: 35,
    leftElbowAngle: 165,
    rightElbowAngle: 160,
    leftKneeAngle: 155,
    rightKneeAngle: 155,
    hipRotation: 25,
    shoulderTilt: 8,
    ...overrides,
  };
}

function makeCameraResult(avgSpread: number, angle?: 'front' | 'side' | 'unknown'): CameraAngleResult {
  return {
    angle: angle ?? (avgSpread >= 0.15 ? 'front' : avgSpread <= 0.08 ? 'side' : 'unknown'),
    shoulderSpread: avgSpread * 1.1,
    hipSpread: avgSpread * 0.9,
    avgSpread,
    weights: {
      spineAngle: 1, leftElbowAngle: 1, rightElbowAngle: 1,
      leftKneeAngle: 1, rightKneeAngle: 1, hipRotation: 1,
      shoulderTilt: 1, tempo: 1,
    },
  };
}

/** Compute avgSpread that yields a specific camera angle in degrees. */
function spreadForAngle(degrees: number): number {
  return FACE_ON_REFERENCE_SPREAD * Math.cos(degrees * Math.PI / 180);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// =========================================================================
// estimateAngleDegrees
// =========================================================================

group('estimateAngleDegrees — core conversions');

{
  const result = estimateAngleDegrees(FACE_ON_REFERENCE_SPREAD);
  assertApprox(result!, 0, 0.1, 'face-on reference spread → 0°');
}

{
  const result = estimateAngleDegrees(spreadForAngle(45));
  assertApprox(result!, 45, 0.5, '45° camera → ~45°');
}

{
  const result = estimateAngleDegrees(spreadForAngle(60));
  assertApprox(result!, 60, 0.5, '60° camera → ~60°');
}

{
  const result = estimateAngleDegrees(spreadForAngle(30));
  assertApprox(result!, 30, 0.5, '30° camera → ~30°');
}

{
  const result = estimateAngleDegrees(0.40);
  assertApprox(result!, 0, 0.1, 'over-reference spread clamped to 0°');
}

{
  const result = estimateAngleDegrees(0.04);
  assertNotNull(result, 'small spread returns a value');
  assert(result! > 60, `small spread (0.04) → large angle (got ${result}°)`);
}

group('estimateAngleDegrees — edge cases');

{
  assertNull(estimateAngleDegrees(0), 'zero spread → null');
}

{
  assertNull(estimateAngleDegrees(-0.1), 'negative spread → null');
}

{
  assertNull(estimateAngleDegrees(NaN), 'NaN spread → null');
}

{
  assertNull(estimateAngleDegrees(Infinity), 'Infinity spread → null');
}

{
  assertNull(estimateAngleDegrees(-Infinity), '-Infinity spread → null');
}

// =========================================================================
// correctAngleFromVertical (spine)
// =========================================================================

group('correctAngleFromVertical — spine correction');

{
  assertEq(correctAngleFromVertical(35, 0), 35, '0° camera → identity');
}

{
  const camera45 = 45 * Math.PI / 180;
  const result = correctAngleFromVertical(35, camera45);
  assert(result > 35, `45° camera: spine 35 → ${result} (increases)`);
  assert(result < 55, `45° camera: spine 35 → ${result} (reasonable range)`);
}

{
  const camera30 = 30 * Math.PI / 180;
  const result = correctAngleFromVertical(35, camera30);
  assert(result > 35, `30° camera: spine 35 → ${result} (increases)`);
  assert(result <= 45, `30° camera: spine 35 → ${result} (modest increase)`);
}

{
  const camera45 = 45 * Math.PI / 180;
  assertEq(correctAngleFromVertical(0, camera45), 0, '0° spine stays 0° at any camera angle');
}

{
  // tan(90°) = Infinity, atan(Infinity / cos(45°)) = atan(Infinity) = 90°
  const camera45 = 45 * Math.PI / 180;
  assertEq(correctAngleFromVertical(90, camera45), 90, '90° spine stays 90° (tan→Infinity handled)');
}

{
  // Negative spine angles shouldn't happen in practice, but should not crash
  const camera45 = 45 * Math.PI / 180;
  const result = correctAngleFromVertical(-10, camera45);
  assert(result < 0, `negative spine: corrected to ${result} (still negative)`);
}

{
  // NaN passes through unchanged
  const camera45 = 45 * Math.PI / 180;
  assertNaN(correctAngleFromVertical(NaN, camera45), 'NaN spine → NaN');
}

group('correctAngleFromVertical — monotonicity');

{
  const spine = 35;
  const r15 = correctAngleFromVertical(spine, 15 * Math.PI / 180);
  const r30 = correctAngleFromVertical(spine, 30 * Math.PI / 180);
  const r45 = correctAngleFromVertical(spine, 45 * Math.PI / 180);
  const r60 = correctAngleFromVertical(spine, 60 * Math.PI / 180);
  assert(r15 <= r30, `monotonic: 15°(${r15}) ≤ 30°(${r30})`);
  assert(r30 < r45, `monotonic: 30°(${r30}) < 45°(${r45})`);
  assert(r45 < r60, `monotonic: 45°(${r45}) < 60°(${r60})`);
}

// =========================================================================
// correctJointAngle (elbow, knee)
// =========================================================================

group('correctJointAngle — joint correction');

{
  assertEq(correctJointAngle(165, 0), 165, '0° camera → identity');
}

{
  const camera45 = 45 * Math.PI / 180;
  const result = correctJointAngle(165, camera45);
  assert(result <= 165, `45° camera: elbow 165 → ${result} (more bent)`);
  assert(result >= 155, `45° camera: elbow 165 → ${result} (reasonable)`);
}

{
  // More bent → larger correction magnitude
  const camera45 = 45 * Math.PI / 180;
  const r165 = correctJointAngle(165, camera45);
  const r120 = correctJointAngle(120, camera45);
  const delta165 = r165 - 165;
  const delta120 = r120 - 120;
  assert(Math.abs(delta120) > Math.abs(delta165), `more bent (120°) gets larger correction: |Δ${delta120}| > |Δ${delta165}|`);
}

{
  // 180° (fully straight) → stays 180°
  const camera45 = 45 * Math.PI / 180;
  assertEq(correctJointAngle(180, camera45), 180, '180° stays 180°');
}

{
  // 181° (beyond straight, shouldn't happen) → stays 181, clamped to 180
  const camera45 = 45 * Math.PI / 180;
  const result = correctJointAngle(181, camera45);
  assertEq(result, 181, '181° passes through (deviation ≤ 0 guard)');
}

{
  // Extreme bend (45°) at extreme camera angle — result clamped [0,180]
  const camera65 = 65 * Math.PI / 180;
  const result = correctJointAngle(45, camera65);
  assert(result >= 0 && result <= 180, `extreme correction clamped to [0,180] (got ${result})`);
}

{
  assertNaN(correctJointAngle(NaN, 45 * Math.PI / 180), 'NaN joint angle → NaN');
}

group('correctJointAngle — monotonicity');

{
  const angle = 150;
  const r15 = correctJointAngle(angle, 15 * Math.PI / 180);
  const r30 = correctJointAngle(angle, 30 * Math.PI / 180);
  const r45 = correctJointAngle(angle, 45 * Math.PI / 180);
  const r60 = correctJointAngle(angle, 60 * Math.PI / 180);
  assert(r15 >= r30, `monotonic: 15°(${r15}) ≥ 30°(${r30})`);
  assert(r30 >= r45, `monotonic: 30°(${r30}) ≥ 45°(${r45})`);
  assert(r45 >= r60, `monotonic: 45°(${r45}) ≥ 60°(${r60})`);
}

// =========================================================================
// correctHipRotation
// =========================================================================

group('correctHipRotation');

{
  assertEq(correctHipRotation(25, 0), 25, '0° camera → identity');
}

{
  const camera45 = 45 * Math.PI / 180;
  assertApprox(correctHipRotation(25, camera45), 35, 1, '45°: 25 → ~35');
}

{
  const camera60 = 60 * Math.PI / 180;
  assertApprox(correctHipRotation(25, camera60), 50, 1, '60°: 25 → ~50');
}

{
  assertEq(correctHipRotation(0, 45 * Math.PI / 180), 0, '0 hipRotation stays 0');
}

{
  // Negative hip rotation (delta can be negative) → corrected negative
  const camera45 = 45 * Math.PI / 180;
  const result = correctHipRotation(-10, camera45);
  assert(result < 0, `negative hip rotation corrected: ${result}`);
  assertApprox(result, -14, 1, 'negative hip: -10 → ~-14 at 45°');
}

{
  assertNaN(correctHipRotation(NaN, 45 * Math.PI / 180), 'NaN hipRotation → NaN');
}

// =========================================================================
// correctForeshortening — full pipeline
// =========================================================================

group('correctForeshortening — applied');

{
  const angles = makeAngles();
  const camera = makeCameraResult(spreadForAngle(45));
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.applied, true, 'correction applied at ~45°');
  assertApprox(result.debug.estimatedAngleDegrees!, 45, 1, 'estimated ~45°');
  assertEq(result.debug.reason, 'corrected', 'reason = corrected');

  assert(result.angles.spineAngle! > angles.spineAngle!, 'spine corrected upward');
  assert(result.angles.leftElbowAngle! <= angles.leftElbowAngle!, 'left elbow corrected (more bent)');
  assert(result.angles.rightElbowAngle! <= angles.rightElbowAngle!, 'right elbow corrected (more bent)');
  assert(result.angles.leftKneeAngle! <= angles.leftKneeAngle!, 'left knee corrected (more bent)');
  assert(result.angles.rightKneeAngle! <= angles.rightKneeAngle!, 'right knee corrected (more bent)');
  assert(result.angles.hipRotation! > angles.hipRotation!, 'hip rotation corrected upward');
  assertEq(result.angles.shoulderTilt, angles.shoulderTilt, 'shoulderTilt NOT corrected');
}

group('correctForeshortening — guards');

{
  const angles = makeAngles();
  const camera = makeCameraResult(FACE_ON_REFERENCE_SPREAD, 'front');
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.applied, false, 'face-on: no correction');
  assertEq(result.debug.reason, 'angle_too_small', 'face-on: reason');
  assertEq(result.angles.spineAngle, angles.spineAngle, 'face-on: angles unchanged');
}

{
  const angles = makeAngles();
  const camera = makeCameraResult(0.02, 'side');
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.applied, false, 'extreme side: no correction');
  assertEq(result.debug.reason, 'angle_too_large', 'extreme side: reason');
}

{
  const angles = makeAngles();
  const camera = makeCameraResult(0, 'unknown');
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.applied, false, 'zero spread: no correction');
  assertEq(result.debug.reason, 'no_spread_data', 'zero spread: reason');
  assertNull(result.debug.estimatedAngleDegrees, 'zero spread: null degrees');
}

{
  // NaN avgSpread → no_spread_data
  const angles = makeAngles();
  const camera = makeCameraResult(NaN, 'unknown');
  // makeCameraResult puts NaN in avgSpread
  camera.avgSpread = NaN;
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.applied, false, 'NaN spread: no correction');
  assertEq(result.debug.reason, 'no_spread_data', 'NaN spread: reason');
}

group('correctForeshortening — boundary thresholds');

{
  // Exactly at MIN_CORRECTION_ANGLE (10°) → should apply
  const spreadAtMin = spreadForAngle(MIN_CORRECTION_ANGLE);
  const angles = makeAngles();
  const camera = makeCameraResult(spreadAtMin);
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.applied, true, 'exactly at MIN (10°): applied');
}

{
  // Just below MIN_CORRECTION_ANGLE (9°) → should NOT apply
  const spreadAt9 = spreadForAngle(9);
  const angles = makeAngles();
  const camera = makeCameraResult(spreadAt9);
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.applied, false, 'just below MIN (9°): not applied');
  assertEq(result.debug.reason, 'angle_too_small', 'just below MIN: reason');
}

{
  // Exactly at MAX_CORRECTION_ANGLE (75°) → should apply
  const spreadAtMax = spreadForAngle(MAX_CORRECTION_ANGLE);
  const angles = makeAngles();
  const camera = makeCameraResult(spreadAtMax);
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.applied, true, 'exactly at MAX (75°): applied');
}

{
  // Just above MAX_CORRECTION_ANGLE (76°) → should NOT apply
  const spreadAt76 = spreadForAngle(76);
  const angles = makeAngles();
  const camera = makeCameraResult(spreadAt76);
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.applied, false, 'just above MAX (76°): not applied');
  assertEq(result.debug.reason, 'angle_too_large', 'just above MAX: reason');
}

// =========================================================================
// Null and NaN metric handling
// =========================================================================

group('Null metric handling');

{
  const angles = makeAngles({ spineAngle: null, leftElbowAngle: null, hipRotation: null });
  const camera = makeCameraResult(spreadForAngle(45));
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.applied, true, 'still applies with some null metrics');
  assertNull(result.angles.spineAngle, 'null spineAngle stays null');
  assertNull(result.angles.leftElbowAngle, 'null leftElbowAngle stays null');
  assertNull(result.angles.hipRotation, 'null hipRotation stays null');
  assertNotNull(result.angles.rightElbowAngle, 'non-null metric still corrected');
  assert(!('spineAngle' in result.debug.corrections!), 'no correction entry for null metric');
}

{
  const angles: GolfAngles = {
    spineAngle: null, leftElbowAngle: null, rightElbowAngle: null,
    leftKneeAngle: null, rightKneeAngle: null, hipRotation: null, shoulderTilt: null,
  };
  const camera = makeCameraResult(spreadForAngle(45));
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.applied, true, 'all-null: correction still runs');
  assertEq(result.debug.reason, 'corrected', 'all-null: reason = corrected');
}

group('NaN metric handling');

{
  const angles = makeAngles({ spineAngle: NaN, hipRotation: NaN });
  const camera = makeCameraResult(spreadForAngle(45));
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.applied, true, 'NaN metrics: correction still runs');
  // NaN metrics should be skipped (not produce NaN in corrections)
  assert(!('spineAngle' in (result.debug.corrections ?? {})), 'NaN spineAngle skipped in corrections');
  assert(!('hipRotation' in (result.debug.corrections ?? {})), 'NaN hipRotation skipped in corrections');
}

// =========================================================================
// Immutability
// =========================================================================

group('Immutability');

{
  const angles = makeAngles();
  const originalSpine = angles.spineAngle;
  const originalHip = angles.hipRotation;
  const camera = makeCameraResult(spreadForAngle(45));
  correctForeshortening(angles, camera);

  assertEq(angles.spineAngle, originalSpine, 'original spineAngle not mutated');
  assertEq(angles.hipRotation, originalHip, 'original hipRotation not mutated');
}

// =========================================================================
// Debug output shape
// =========================================================================

group('Debug output shape — when applied');

{
  const angles = makeAngles();
  const camera = makeCameraResult(spreadForAngle(45));
  const result = correctForeshortening(angles, camera);
  const d = result.debug;

  assert(typeof d.applied === 'boolean', 'applied is boolean');
  assert(typeof d.estimatedAngleDegrees === 'number', 'estimatedAngleDegrees is number');
  assert(typeof d.reason === 'string', 'reason is string');
  assertNotNull(d.corrections, 'corrections present when applied');

  const c = d.corrections!;
  assert('spineAngle' in c, 'corrections has spineAngle');
  assert('leftElbowAngle' in c, 'corrections has leftElbowAngle');
  assert('rightElbowAngle' in c, 'corrections has rightElbowAngle');
  assert('leftKneeAngle' in c, 'corrections has leftKneeAngle');
  assert('rightKneeAngle' in c, 'corrections has rightKneeAngle');
  assert('hipRotation' in c, 'corrections has hipRotation');
  assert(!('shoulderTilt' in c), 'corrections does NOT have shoulderTilt');
  assert(!('tempo' in c), 'corrections does NOT have tempo');

  // before values must match original input exactly
  assertEq(c.spineAngle!.before, 35, 'corrections.spineAngle.before matches input');
  assertEq(c.leftElbowAngle!.before, 165, 'corrections.leftElbowAngle.before matches input');
  assertEq(c.rightElbowAngle!.before, 160, 'corrections.rightElbowAngle.before matches input');
  assertEq(c.leftKneeAngle!.before, 155, 'corrections.leftKneeAngle.before matches input');
  assertEq(c.rightKneeAngle!.before, 155, 'corrections.rightKneeAngle.before matches input');
  assertEq(c.hipRotation!.before, 25, 'corrections.hipRotation.before matches input');
}

group('Debug output shape — when not applied');

{
  const angles = makeAngles();
  const camera = makeCameraResult(FACE_ON_REFERENCE_SPREAD, 'front');
  const result = correctForeshortening(angles, camera);

  assertEq(result.debug.corrections, undefined, 'no corrections object when not applied');
}

// =========================================================================
// ROADMAP VALIDATION: roundtrip accuracy at 45°
// =========================================================================

group('ROADMAP VALIDATION: 45° roundtrip — spine');

{
  // True spine = 40°. Compressed at 45° camera. Correct back. Must be within 5°.
  const trueSpine = 40;
  const camera45 = 45 * Math.PI / 180;

  const compressedRad = Math.atan(Math.tan(trueSpine * Math.PI / 180) * Math.cos(camera45));
  const compressed = Math.round(compressedRad * 180 / Math.PI);
  const corrected = correctAngleFromVertical(compressed, camera45);

  assertApprox(corrected, trueSpine, 5,
    `spine: true=${trueSpine}, compressed=${compressed}, corrected=${corrected}`);
}

{
  // Test with a different true spine angle (25°)
  const trueSpine = 25;
  const camera45 = 45 * Math.PI / 180;

  const compressedRad = Math.atan(Math.tan(trueSpine * Math.PI / 180) * Math.cos(camera45));
  const compressed = Math.round(compressedRad * 180 / Math.PI);
  const corrected = correctAngleFromVertical(compressed, camera45);

  assertApprox(corrected, trueSpine, 5,
    `spine: true=${trueSpine}, compressed=${compressed}, corrected=${corrected}`);
}

group('ROADMAP VALIDATION: 45° roundtrip — hip rotation');

{
  const trueHip = 30;
  const camera45 = 45 * Math.PI / 180;
  const compressed = Math.round(trueHip * Math.cos(camera45));
  const corrected = correctHipRotation(compressed, camera45);

  assertApprox(corrected, trueHip, 2,
    `hip: true=${trueHip}, compressed=${compressed}, corrected=${corrected}`);
}

group('ROADMAP VALIDATION: 45° roundtrip — elbow');

{
  // True elbow = 160°. Deviation from straight = 20°.
  // At 45° camera, horizontal component of deviation is compressed.
  // compress: deviation stays as deviation, but with sin/cos components
  const trueElbow = 160;
  const camera45 = 45 * Math.PI / 180;
  const trueDeviation = 180 - trueElbow; // 20°
  const devRad = trueDeviation * Math.PI / 180;

  // Compressed: the horizontal component of deviation is multiplied by cos(camera)
  const compressedDevRad = Math.atan2(Math.sin(devRad) * Math.cos(camera45), Math.cos(devRad));
  const compressedDev = compressedDevRad * 180 / Math.PI;
  const compressed = Math.round(180 - compressedDev);

  const corrected = correctJointAngle(compressed, camera45);
  assertApprox(corrected, trueElbow, 5,
    `elbow: true=${trueElbow}, compressed=${compressed}, corrected=${corrected}`);
}

group('ROADMAP VALIDATION: 45° roundtrip — knee');

{
  const trueKnee = 150;
  const camera45 = 45 * Math.PI / 180;
  const trueDeviation = 180 - trueKnee; // 30°
  const devRad = trueDeviation * Math.PI / 180;

  const compressedDevRad = Math.atan2(Math.sin(devRad) * Math.cos(camera45), Math.cos(devRad));
  const compressedDev = compressedDevRad * 180 / Math.PI;
  const compressed = Math.round(180 - compressedDev);

  const corrected = correctJointAngle(compressed, camera45);
  assertApprox(corrected, trueKnee, 5,
    `knee: true=${trueKnee}, compressed=${compressed}, corrected=${corrected}`);
}

// =========================================================================
// Monotonicity across spreads in full pipeline
// =========================================================================

group('Monotonicity: full pipeline — spine');

{
  const angles = makeAngles({ spineAngle: 35 });
  const spreads = [0.25, 0.20, 0.15, 0.12, 0.09];
  const results: { spread: number; spine: number; degrees: number }[] = [];

  for (const spread of spreads) {
    const camera = makeCameraResult(spread);
    const result = correctForeshortening(angles, camera);
    const deg = result.debug.estimatedAngleDegrees;
    if (result.debug.applied && deg != null) {
      results.push({ spread, spine: result.angles.spineAngle!, degrees: deg });
    }
  }

  assert(results.length >= 3, `enough data points for monotonicity check (got ${results.length})`);
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1];
    const curr = results[i];
    assert(curr.spine >= prev.spine,
      `spine: spread ${prev.spread}→${curr.spread}, angle ${prev.degrees}°→${curr.degrees}°, spine ${prev.spine}→${curr.spine}`);
  }
}

group('Monotonicity: full pipeline — hip rotation');

{
  const angles = makeAngles({ hipRotation: 25 });
  const spreads = [0.25, 0.20, 0.15, 0.12, 0.09];
  const results: { spread: number; hip: number }[] = [];

  for (const spread of spreads) {
    const camera = makeCameraResult(spread);
    const result = correctForeshortening(angles, camera);
    if (result.debug.applied) {
      results.push({ spread, hip: result.angles.hipRotation! });
    }
  }

  assert(results.length >= 3, `enough data points (got ${results.length})`);
  for (let i = 1; i < results.length; i++) {
    assert(results[i].hip >= results[i - 1].hip,
      `hip: spread ${results[i - 1].spread}→${results[i].spread}, hip ${results[i - 1].hip}→${results[i].hip}`);
  }
}

// =========================================================================
// Constants
// =========================================================================

group('Constants');

assertEq(MIN_CORRECTION_ANGLE, 10, 'MIN_CORRECTION_ANGLE = 10');
assertEq(MAX_CORRECTION_ANGLE, 75, 'MAX_CORRECTION_ANGLE = 75');
assertEq(FACE_ON_REFERENCE_SPREAD, 0.30, 'FACE_ON_REFERENCE_SPREAD = 0.30');
assert(MIN_CORRECTION_ANGLE < MAX_CORRECTION_ANGLE, 'MIN < MAX');

// =========================================================================
// Summary
// =========================================================================

console.log(`\n${'═'.repeat(55)}`);
console.log(`  ${passed + failed} assertions | ${passed} passed | ${failed} failed`);
console.log(`${'═'.repeat(55)}`);

if (failed > 0) {
  console.log('\n⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASSED — Task 5 validated');
  console.log('   Roadmap: 45° spine/hip/elbow/knee roundtrips within tolerance');
  console.log('   Guards: NaN, null, boundary, too-small, too-large all verified');
}
