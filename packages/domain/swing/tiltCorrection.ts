/**
 * tiltCorrection.ts — Phone Gyroscope Tilt Correction (Task 10)
 *
 * Problem: Parents often hold the phone tilted ~15° down when recording their
 * kid's swing. angleToVertical() in angles.ts uses the camera frame's Y-axis
 * as "vertical," so every degree of phone tilt shifts vertical-referenced
 * measurements by the same amount. A 15° forward tilt makes a perfectly
 * upright spine read as 15° tilted.
 *
 * Solution: Read the phone's accelerometer gravity vector during recording,
 * compute the pitch angle (forward/backward tilt), and subtract it from
 * metrics measured against vertical.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ CORRECTED (measured via angleToVertical — directly shifted by tilt)  │
 * ├───────────────────────────────────────────────────────────────────────┤
 * │ spineAngle     subtract pitchDeg, clamp ≥ 0                         │
 * │ shoulderTilt   subtract pitchDeg, can go negative  [ASSUMPTION ¹]   │
 * ├───────────────────────────────────────────────────────────────────────┤
 * │ NOT CORRECTED (tilt-invariant or non-vertical)                       │
 * ├───────────────────────────────────────────────────────────────────────┤
 * │ elbowAngles    3-joint angle via angleBetween(), camera-invariant    │
 * │ kneeAngles     3-joint angle via angleBetween(), camera-invariant    │
 * │ hipSpreadDelta    horizontal delta between phases, pitch doesn't shift  │
 * │ tempo          timing-based, no spatial reference                    │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * ¹ ASSUMPTION: shoulderTilt is measured via angleToVertical of the shoulder
 *   line at top-of-backswing. If it's measured differently (e.g. angle from
 *   horizontal, or relative to spine), the correction direction may differ.
 *   VERIFY by grepping: `grep -n shoulderTilt packages/domain/swing/angles.ts`
 *   If shoulderTilt is angle-from-horizontal: correction = ADD pitchDeg, not
 *   subtract. This is the single most likely silent-failure point in Task 10.
 *
 * Guards (ordered by processing stage):
 *   Invalid readings (NaN/Infinity)  → filtered before any math
 *   Gravity magnitude outside 0.8–1.2 G → rejected (phone accelerating)
 *   < MIN_SAMPLE_COUNT valid readings → null (insufficient data)
 *   pitchStdDev > MAX_PITCH_STDDEV   → skip (phone was moving, avg unreliable)
 *   |pitch| < MIN_TILT_DEG (2°)      → skip (correction < measurement noise)
 *   |pitch| > MAX_TILT_DEG (30°)     → skip (extreme tilt, all data suspect)
 *   All metrics null/undefined        → skip (nothing to correct)
 *
 * Relationship to foreshortening correction (Task 5):
 *   Foreshortening fixes horizontal compression from camera viewing angle.
 *   Tilt correction fixes vertical reference shift from phone orientation.
 *   They are mathematically independent and stack.
 *
 * Why linear subtraction is exact (not an approximation):
 *   Phone tilt rotates the camera's reference frame by exactly pitchDeg.
 *   angleToVertical measures the angle between a body segment and the frame's
 *   Y-axis. Rotating the reference frame by P° shifts the measured angle by
 *   exactly P°. This is a reference frame rotation, not a projection
 *   correction (that's what foreshortening handles). No cos() needed.
 *
 * Accelerometer sign convention (VERIFY ON DEVICE — see INTEGRATION.md):
 *   expo-sensors returns values as multiples of G. computePhoneTilt also
 *   works with m/s² — it uses atan2 ratios so scale cancels out.
 *   Phone portrait-vertical, screen facing user:
 *     Y points up (gravity → y ≈ -1G), Z points toward user (z ≈ 0)
 *   Phone tilted forward θ° (top away from user):
 *     y ≈ -cos(θ), z ≈ sin(θ)
 *   Pitch = atan2(z, -y) → 0° vertical, +θ° forward.
 *   ⚠ If device test shows inverted sign, flip SIGN_NEGATE_Z in
 *   useTiltCapture.ts. Pure-function tests are unaffected.
 *
 * @module tiltCorrection
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Raw accelerometer reading.
 * Scale-independent: works with G-multiples (expo-sensors) or m/s².
 */
export interface GravityReading {
  x: number;
  y: number;
  z: number;
}

/** Computed phone tilt from gravity readings, with quality metrics */
export interface PhoneTilt {
  /** Pitch in degrees. Positive = tilted forward (top away from user). */
  pitchDeg: number;
  /** Roll in degrees. Positive = tilted right. Informational only. */
  rollDeg: number;
  /** Samples that survived all validation filters */
  sampleCount: number;
  /** Std dev of per-sample pitch (degrees). High → phone was moving. */
  pitchStdDev: number;
  /** Readings rejected for anomalous gravity magnitude */
  rejectedCount: number;
}

/** Metrics that may be corrected — mirrors the pipeline's metric shape */
export interface TiltCorrectionInput {
  spineAngle?: number | null;
  shoulderTilt?: number | null;
  // Passed through unchanged:
  leftElbowAngle?: number | null;
  rightElbowAngle?: number | null;
  leftKneeAngle?: number | null;
  rightKneeAngle?: number | null;
  hipSpreadDelta?: number | null;
  tempo?: number | null;
}

/** Why correction was skipped */
export type TiltSkipReason =
  | 'no_tilt_data'
  | 'insufficient_samples'
  | 'high_variance'
  | 'below_min_threshold'
  | 'above_max_threshold'
  | 'no_correctable_metrics';

/** Debug output for swing_debug (additive only) */
export interface TiltCorrectionDebug {
  phonePitchDeg: number;
  phoneRollDeg: number;
  pitchStdDev: number;
  sampleCount: number;
  rejectedCount: number;
  correctionApplied: boolean;
  reason: 'corrected' | TiltSkipReason;
  corrections: {
    spineAngle?: { before: number; after: number };
    shoulderTilt?: { before: number; after: number };
  };
}

/** Result of tilt correction */
export interface TiltCorrectionResult {
  corrected: TiltCorrectionInput;
  debug: TiltCorrectionDebug;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Below this tilt (degrees), correction is within measurement noise */
export const MIN_TILT_DEG = 2;

/** Above this tilt (degrees), phone held too extremely — all data suspect */
export const MAX_TILT_DEG = 30;

/**
 * Valid gravity magnitude range (as a ratio of expected ~1.0 G).
 * A stationary phone reads ~1.0 G. During movement the magnitude shifts.
 * Readings outside this window are rejected as "phone accelerating."
 */
export const MIN_GRAVITY_G = 0.8;
export const MAX_GRAVITY_G = 1.2;

/**
 * Fraction trimmed from EACH end of the sorted pitch array.
 * 0.10 = drop bottom 10% and top 10% before averaging.
 * Protects against transient jolts without losing too much signal.
 */
export const TRIM_FRACTION = 0.10;

/**
 * Minimum valid readings required for a tilt estimate.
 * 1-2 readings can be flukes. 3+ gives a defensible average.
 */
export const MIN_SAMPLE_COUNT = 3;

/**
 * Maximum pitch standard deviation (degrees) to trust the tilt estimate.
 * If readings vary by more than this, the phone was being moved during
 * capture — the average pitch is unreliable and we should skip correction.
 * 8° chosen because: typical hand-held jitter is 1-3°, deliberate
 * repositioning during a 2-3s swing is 5-8°, and anything beyond
 * that means the phone wasn't stationary enough to measure tilt.
 */
export const MAX_PITCH_STDDEV = 8;

/**
 * Number of readings sampled for scale auto-detection.
 * Using median of first N readings instead of just the first reading
 * protects against a single anomalous first sample.
 */
const SCALE_DETECT_SAMPLE_COUNT = 5;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns true only for finite, non-NaN numbers */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Radians → degrees */
function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Round to N decimal places (default 2). Keeps swing_debug clean. */
function round(value: number, decimals: number = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Euclidean magnitude of a 3D vector */
function magnitude(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/** Median of a number array. Returns 0 for empty array. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Sample standard deviation (Bessel-corrected) */
function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sumSq = values.reduce((s, v) => s + (v - mean) ** 2, 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

/**
 * Trimmed mean: sort values, discard the bottom and top `frac` fraction,
 * average the remaining middle. Falls back to full mean when the array is
 * too small for the requested trim.
 */
function trimmedMean(values: number[], frac: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];

  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * frac);
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);

  if (trimmed.length === 0) {
    // Trim removed everything (tiny array) — use full mean
    return sorted.reduce((s, v) => s + v, 0) / sorted.length;
  }
  return trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
}

// ─── Core Functions ──────────────────────────────────────────────────────────

/**
 * Compute phone tilt from an array of accelerometer readings.
 *
 * Processing pipeline:
 *   1. Reject non-finite readings (NaN, Infinity).
 *   2. Auto-detect scale (G's vs m/s²) using median magnitude of first
 *      N readings. Robust to a single anomalous first sample.
 *   3. Reject readings where gravity magnitude deviates from expected
 *      (phone was accelerating, not just tilted).
 *   4. Require MIN_SAMPLE_COUNT valid readings (below → null).
 *   5. Compute per-reading pitch via atan2(z, -y).
 *   6. Trimmed mean (drop top/bottom 10%) for outlier rejection.
 *   7. Standard deviation of per-reading pitch for confidence tracking.
 *
 * @param readings - Accelerometer data captured during recording
 * @returns Phone tilt with quality metrics, or null if insufficient valid data
 */
export function computePhoneTilt(readings: GravityReading[]): PhoneTilt | null {
  if (!readings || readings.length === 0) return null;

  // Step 1: Filter non-finite
  const finite = readings.filter(
    (r) => isFiniteNumber(r.x) && isFiniteNumber(r.y) && isFiniteNumber(r.z)
  );
  if (finite.length === 0) return null;

  // Step 2: Auto-detect scale using median magnitude of first N readings.
  // expo-sensors → magnitude ≈ 1.0 (G's). Raw m/s² → magnitude ≈ 9.81.
  // Using median of first N (not just first reading) protects against a
  // single anomalous first sample from phone pickup/placement.
  const sampleN = Math.min(SCALE_DETECT_SAMPLE_COUNT, finite.length);
  const sampleMags = finite.slice(0, sampleN).map((r) => magnitude(r.x, r.y, r.z));
  const medianMag = median(sampleMags);
  const scale = medianMag > 5 ? 9.81 : 1.0;

  // Step 3: Reject readings with anomalous gravity magnitude
  const valid: GravityReading[] = [];
  let rejectedCount = 0;
  for (const r of finite) {
    const magG = magnitude(r.x, r.y, r.z) / scale;
    if (magG >= MIN_GRAVITY_G && magG <= MAX_GRAVITY_G) {
      valid.push(r);
    } else {
      rejectedCount++;
    }
  }

  // Step 4: Minimum sample count
  if (valid.length < MIN_SAMPLE_COUNT) return null;

  // Step 5: Per-reading pitch and roll
  const pitchValues: number[] = [];
  const rollValues: number[] = [];
  for (const r of valid) {
    pitchValues.push(toDeg(Math.atan2(r.z, -r.y)));
    rollValues.push(toDeg(Math.atan2(r.x, -r.y)));
  }

  // Step 6: Trimmed mean
  const pitchDeg = trimmedMean(pitchValues, TRIM_FRACTION);
  const rollDeg = trimmedMean(rollValues, TRIM_FRACTION);

  // Step 7: Std dev (computed on ALL valid readings, not just trimmed)
  const pitchSD = stdDev(pitchValues);

  return {
    pitchDeg: round(pitchDeg),
    rollDeg: round(rollDeg),
    sampleCount: valid.length,
    pitchStdDev: round(pitchSD),
    rejectedCount,
  };
}

/**
 * Apply tilt correction to swing metrics.
 *
 * For metrics measured via angleToVertical():
 *   measured = trueAngle + phoneTilt
 *   corrected = measured − phoneTilt
 *
 * Spine angle clamped ≥ 0 (spine can't lean past vertical and still be golf).
 * Shoulder tilt NOT clamped (shoulders can tilt either direction at backswing).
 *
 * Guard order: no data → insufficient samples → high variance → below min →
 * above max → apply correction → check if any metric was actually corrected.
 *
 * @param metrics - Current metric values (may already have foreshortening correction)
 * @param tilt - Phone tilt from computePhoneTilt, or null if unavailable
 * @returns Corrected metrics + debug for swing_debug
 */
export function correctForPhoneTilt(
  metrics: TiltCorrectionInput,
  tilt: PhoneTilt | null
): TiltCorrectionResult {
  const corrected: TiltCorrectionInput = { ...metrics };

  const makeDebug = (
    reason: TiltSkipReason,
    t?: PhoneTilt | null
  ): TiltCorrectionDebug => ({
    phonePitchDeg: t ? round(t.pitchDeg) : 0,
    phoneRollDeg: t ? round(t.rollDeg) : 0,
    pitchStdDev: t ? round(t.pitchStdDev) : 0,
    sampleCount: t ? t.sampleCount : 0,
    rejectedCount: t ? t.rejectedCount : 0,
    correctionApplied: false,
    reason,
    corrections: {},
  });

  // ── No tilt data ──
  if (!tilt || !isFiniteNumber(tilt.pitchDeg)) {
    return { corrected, debug: makeDebug('no_tilt_data') };
  }

  // ── Insufficient samples (computePhoneTilt already gates this, but
  //    a manually-constructed PhoneTilt could have low sampleCount) ──
  if (tilt.sampleCount < MIN_SAMPLE_COUNT) {
    return { corrected, debug: makeDebug('insufficient_samples', tilt) };
  }

  // ── High variance — phone was moving, average is unreliable ──
  if (isFiniteNumber(tilt.pitchStdDev) && tilt.pitchStdDev > MAX_PITCH_STDDEV) {
    return { corrected, debug: makeDebug('high_variance', tilt) };
  }

  const absPitch = Math.abs(tilt.pitchDeg);

  // ── Below minimum ──
  if (absPitch < MIN_TILT_DEG) {
    return { corrected, debug: makeDebug('below_min_threshold', tilt) };
  }

  // ── Above maximum ──
  if (absPitch > MAX_TILT_DEG) {
    return { corrected, debug: makeDebug('above_max_threshold', tilt) };
  }

  // ── Correct eligible metrics ──
  const corrections: TiltCorrectionDebug['corrections'] = {};

  // spineAngle: deviation from vertical via angleToVertical(hip, shoulder).
  // Phone tilt inflates this reading by exactly pitchDeg.
  if (isFiniteNumber(metrics.spineAngle)) {
    const before = metrics.spineAngle!;
    corrected.spineAngle = Math.max(0, round(before - tilt.pitchDeg));
    corrections.spineAngle = { before: round(before), after: corrected.spineAngle };
  }

  // shoulderTilt: ASSUMED to be measured via angleToVertical of the shoulder
  // line at top-of-backswing. Same reference-frame shift as spine.
  // ⚠ If shoulderTilt is actually angle-from-HORIZONTAL in angles.ts,
  // change the sign: corrected = before + tilt.pitchDeg instead.
  // Verify: grep -n shoulderTilt packages/domain/swing/angles.ts
  if (isFiniteNumber(metrics.shoulderTilt)) {
    const before = metrics.shoulderTilt!;
    corrected.shoulderTilt = round(before - tilt.pitchDeg);
    corrections.shoulderTilt = { before: round(before), after: corrected.shoulderTilt };
  }

  const didCorrect = Object.keys(corrections).length > 0;

  return {
    corrected,
    debug: {
      phonePitchDeg: round(tilt.pitchDeg),
      phoneRollDeg: round(tilt.rollDeg),
      pitchStdDev: round(tilt.pitchStdDev),
      sampleCount: tilt.sampleCount,
      rejectedCount: tilt.rejectedCount,
      correctionApplied: didCorrect,
      reason: didCorrect ? 'corrected' : 'no_correctable_metrics',
      corrections,
    },
  };
}

/**
 * Convenience: compute tilt from raw readings and correct metrics in one call.
 * This is the function the analysis pipeline should call.
 */
export function applyTiltCorrection(
  metrics: TiltCorrectionInput,
  gravityReadings: GravityReading[]
): TiltCorrectionResult {
  const tilt = computePhoneTilt(gravityReadings);
  return correctForPhoneTilt(metrics, tilt);
}
