/**
 * foreshorteningCorrection.ts — Task 5: Foreshortening Correction
 *
 * When a parent films from an angle (not perfectly face-on), horizontal
 * distances between joints get compressed by cos(cameraAngle). This makes
 * measured angles WRONG in a predictable, geometric way.
 *
 * This module reverses that compression using the camera angle detected
 * by Task 4 (cameraAngle.ts). Pure functions — no state, no side effects.
 *
 * Corrected metrics (horizontal component matters):
 *   - spineAngle: angle from vertical → atan(tan(measured) / cos(camera))
 *   - leftElbowAngle / rightElbowAngle: 3-joint bend → deviation stretch
 *   - leftKneeAngle / rightKneeAngle: 3-joint bend → deviation stretch
 *   - hipRotation: pure horizontal → divide by cos(camera)
 *
 * NOT corrected (unaffected or unreliable under correction):
 *   - shoulderTilt: primarily vertical (dy between shoulders)
 *   - tempo: timing-based, not spatial
 *
 * Safety guards:
 *   - No correction when avgSpread is 0, negative, or NaN
 *   - No correction below 10° (negligible compression, <1.5% error)
 *   - No correction above 75° (cos→0, correction amplifies noise)
 *   - NaN/null metric inputs pass through unchanged
 *   - Original angles object is never mutated
 *
 * Math derivation (spine angle as example):
 *   Spine vector has components (dx, dy). Foreshortening compresses dx:
 *     measured_dx = true_dx × cos(cameraAngle)
 *   Spine angle from vertical = atan(dx / dy), so:
 *     measured_angle = atan(true_dx × cos(camera) / dy)
 *                    = atan(tan(true_angle) × cos(camera))
 *   Inverting: true_angle = atan(tan(measured_angle) / cos(camera))
 *
 * TYPE DEBT: GolfAngles imported from angles.ts. No new types needed.
 */

import type { GolfAngles } from './angles';
import type { CameraAngleResult } from './cameraAngle';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Below this angle (degrees), foreshortening is negligible (<1.5% error). */
const MIN_CORRECTION_ANGLE = 10;

/** Above this angle (degrees), cos() is too small and correction amplifies noise. */
const MAX_CORRECTION_ANGLE = 75;

/**
 * Reference face-on shoulder+hip spread in normalized coordinates.
 * Used to convert avgSpread → estimatedAngleDegrees.
 *
 * Derivation: typical face-on avgSpread is 0.25–0.35 across youth golfers.
 * 0.30 is a conservative midpoint. Body proportion calibration (Task 12)
 * would replace this with a per-golfer value.
 */
const FACE_ON_REFERENCE_SPREAD = 0.30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the value is a finite number (not NaN, not Infinity, not null/undefined). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---------------------------------------------------------------------------
// Camera angle estimation (degrees)
// ---------------------------------------------------------------------------

/**
 * Convert avgSpread from cameraAngle.ts into a numeric 0–90° estimate.
 *
 * The relationship: face-on gives maximum separation. As the golfer
 * rotates away from camera, separation decreases by cos(angle).
 *   spread = maxSpread × cos(angle)
 *   angle = acos(spread / maxSpread)
 *
 * Returns null if avgSpread is 0, negative, or NaN.
 */
export function estimateAngleDegrees(avgSpread: number): number | null {
  if (!isFiniteNumber(avgSpread) || avgSpread <= 0) return null;

  const ratio = Math.min(avgSpread / FACE_ON_REFERENCE_SPREAD, 1.0);
  const radians = Math.acos(ratio);
  const degrees = radians * (180 / Math.PI);

  return Math.round(degrees * 10) / 10;
}

// ---------------------------------------------------------------------------
// Angle correction functions
// ---------------------------------------------------------------------------

/**
 * Correct a spine-type angle (measured from vertical) for foreshortening.
 *
 * Formula: corrected = atan(tan(measured) / cos(cameraAngle))
 *
 * Edge cases:
 *   - measured = 0° → tan(0) = 0 → atan(0/cos) = 0 → unchanged (correct)
 *   - measured = 90° → tan(90) = Infinity → atan(Inf/cos) = 90 → unchanged (correct)
 *   - NaN input → returns original value unchanged
 */
function correctAngleFromVertical(
  measuredDegrees: number,
  cameraAngleRadians: number,
): number {
  if (!isFiniteNumber(measuredDegrees)) return measuredDegrees;

  const measuredRad = measuredDegrees * (Math.PI / 180);
  const tanMeasured = Math.tan(measuredRad);
  const cosCamera = Math.cos(cameraAngleRadians);

  if (cosCamera === 0) return measuredDegrees;

  const correctedRad = Math.atan(tanMeasured / cosCamera);
  return Math.round((correctedRad * 180) / Math.PI);
}

/**
 * Correct a 3-joint angle (elbow, knee) for foreshortening.
 *
 * Foreshortening compresses the horizontal component of the bend,
 * making the angle appear more closed (smaller) than reality.
 *
 * Approach: model the deviation from 180° (straight) as a vector with
 * horizontal and vertical components. Un-compress the horizontal component
 * by dividing by cos(cameraAngle), then recompute the deviation angle.
 *
 * Edge cases:
 *   - measured = 180° → deviation = 0 → no correction needed
 *   - measured > 180° → clamped (shouldn't happen in practice)
 *   - NaN input → returns original value unchanged
 *   - Result clamped to [0, 180]
 */
function correctJointAngle(
  measuredDegrees: number,
  cameraAngleRadians: number,
): number {
  if (!isFiniteNumber(measuredDegrees)) return measuredDegrees;

  const deviation = 180 - measuredDegrees;
  if (deviation <= 0) return measuredDegrees;

  const cosCamera = Math.cos(cameraAngleRadians);
  if (cosCamera === 0) return measuredDegrees;

  const deviationRad = deviation * (Math.PI / 180);
  const sinDev = Math.sin(deviationRad);
  const cosDev = Math.cos(deviationRad);

  const correctedRad = Math.atan2(sinDev / cosCamera, cosDev);
  const correctedDeviation = (correctedRad * 180) / Math.PI;

  const result = 180 - correctedDeviation;
  return Math.round(Math.max(0, Math.min(180, result)));
}

/**
 * Correct hip rotation for foreshortening.
 *
 * Hip rotation is measured as abs(rightHip.x - leftHip.x) × 100 — a pure
 * horizontal measurement directly compressed by cos(cameraAngle).
 *
 * Also correct when hipRotation is a delta (impact - address) since:
 *   true_delta = (measured_impact - measured_address) / cos(camera)
 *
 * Edge cases:
 *   - measured = 0 → stays 0 (no hip spread to correct)
 *   - NaN input → returns original value unchanged
 */
function correctHipRotation(
  measured: number,
  cameraAngleRadians: number,
): number {
  if (!isFiniteNumber(measured)) return measured;

  const cosCamera = Math.cos(cameraAngleRadians);
  if (cosCamera === 0) return measured;

  return Math.round(measured / cosCamera);
}

// ---------------------------------------------------------------------------
// Main correction function
// ---------------------------------------------------------------------------

/** Reason codes for debug output — explains why correction was or wasn't applied. */
type CorrectionReason = 'corrected' | 'no_spread_data' | 'angle_too_small' | 'angle_too_large';

export interface ForeshorteningDebug {
  applied: boolean;
  estimatedAngleDegrees: number | null;
  reason: CorrectionReason;
  corrections?: {
    spineAngle?: { before: number; after: number };
    leftElbowAngle?: { before: number; after: number };
    rightElbowAngle?: { before: number; after: number };
    leftKneeAngle?: { before: number; after: number };
    rightKneeAngle?: { before: number; after: number };
    hipRotation?: { before: number; after: number };
  };
}

export interface CorrectionResult {
  angles: GolfAngles;
  debug: ForeshorteningDebug;
}

/**
 * Apply foreshortening correction to golf angles.
 *
 * Returns corrected angles + debug info for swing_debug.
 * Original angles are NOT mutated — returns a new object.
 *
 * @param angles - Raw angles from calculateGolfAngles() or computePhaseWindowedAngles()
 * @param cameraAngle - From detectCameraAngle() (Task 4)
 */
export function correctForeshortening(
  angles: GolfAngles,
  cameraAngle: CameraAngleResult,
): CorrectionResult {
  const angleDegrees = estimateAngleDegrees(cameraAngle.avgSpread);

  if (angleDegrees === null) {
    return {
      angles: { ...angles },
      debug: { applied: false, estimatedAngleDegrees: null, reason: 'no_spread_data' },
    };
  }

  if (angleDegrees < MIN_CORRECTION_ANGLE) {
    return {
      angles: { ...angles },
      debug: { applied: false, estimatedAngleDegrees: angleDegrees, reason: 'angle_too_small' },
    };
  }

  if (angleDegrees > MAX_CORRECTION_ANGLE) {
    return {
      angles: { ...angles },
      debug: { applied: false, estimatedAngleDegrees: angleDegrees, reason: 'angle_too_large' },
    };
  }

  const cameraRad = angleDegrees * (Math.PI / 180);
  const corrections: ForeshorteningDebug['corrections'] = {};
  const corrected: GolfAngles = { ...angles };

  if (angles.spineAngle != null && isFiniteNumber(angles.spineAngle)) {
    const before = angles.spineAngle;
    corrected.spineAngle = correctAngleFromVertical(before, cameraRad);
    corrections.spineAngle = { before, after: corrected.spineAngle };
  }

  if (angles.leftElbowAngle != null && isFiniteNumber(angles.leftElbowAngle)) {
    const before = angles.leftElbowAngle;
    corrected.leftElbowAngle = correctJointAngle(before, cameraRad);
    corrections.leftElbowAngle = { before, after: corrected.leftElbowAngle };
  }

  if (angles.rightElbowAngle != null && isFiniteNumber(angles.rightElbowAngle)) {
    const before = angles.rightElbowAngle;
    corrected.rightElbowAngle = correctJointAngle(before, cameraRad);
    corrections.rightElbowAngle = { before, after: corrected.rightElbowAngle };
  }

  if (angles.leftKneeAngle != null && isFiniteNumber(angles.leftKneeAngle)) {
    const before = angles.leftKneeAngle;
    corrected.leftKneeAngle = correctJointAngle(before, cameraRad);
    corrections.leftKneeAngle = { before, after: corrected.leftKneeAngle };
  }

  if (angles.rightKneeAngle != null && isFiniteNumber(angles.rightKneeAngle)) {
    const before = angles.rightKneeAngle;
    corrected.rightKneeAngle = correctJointAngle(before, cameraRad);
    corrections.rightKneeAngle = { before, after: corrected.rightKneeAngle };
  }

  if (angles.hipRotation != null && isFiniteNumber(angles.hipRotation)) {
    const before = angles.hipRotation;
    corrected.hipRotation = correctHipRotation(before, cameraRad);
    corrections.hipRotation = { before, after: corrected.hipRotation };
  }

  // shoulderTilt: NOT corrected (primarily vertical measurement)

  return {
    angles: corrected,
    debug: {
      applied: true,
      estimatedAngleDegrees: angleDegrees,
      reason: 'corrected',
      corrections,
    },
  };
}

// ---------------------------------------------------------------------------
// Exports for testing internals
// ---------------------------------------------------------------------------

export const _testExports = {
  MIN_CORRECTION_ANGLE,
  MAX_CORRECTION_ANGLE,
  FACE_ON_REFERENCE_SPREAD,
  correctAngleFromVertical,
  correctJointAngle,
  correctHipRotation,
};
