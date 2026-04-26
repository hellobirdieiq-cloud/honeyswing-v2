/**
 * angleGating.ts — Angle-Aware Tip Gating (Task 9)
 *
 * Suppresses coaching tips for metrics that are unreliable at the
 * detected camera angle. Uses a lookup table of (metric × angle range)
 * → accuracy percentage with linear interpolation between bucket
 * midpoints for smooth transitions.
 *
 * Core idea: "The system knows what it doesn't know."
 *   - DTL swings suppress shoulder tilt (accuracy < 85% threshold)
 *   - Face-on swings show everything (all above thresholds)
 *   - 45° swings suppress shoulder tilt but show the rest
 *
 * Works alongside Task 7 frequency limiter — a tip must pass BOTH
 * the frequency check AND the angle-aware check.
 *
 * Depends on: Task 4 (camera angle detection), Task 6 (confidence score)
 *
 * @module packages/domain/swing/angleGating
 */

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Bump when accuracy values or thresholds change.
 * Stored in swing_debug so we can trace which table produced a result.
 */
export const TABLE_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Camera angle bucket derived from estimatedAngleDeg (0-90°). */
export type AngleBucket = 'face_on' | 'oblique' | 'dtl';

/** Metric keys that can be angle-gated. */
export type GatedMetric =
  | 'spineAngle'
  | 'shoulderTilt'
  | 'hipSpreadDelta'
  | 'leftElbowAngle'
  | 'rightElbowAngle'
  | 'leftKneeAngle'
  | 'rightKneeAngle';

/** Result for a single metric's angle gating check. */
export interface MetricGateResult {
  readonly metric: string;
  readonly accuracy: number;       // 0-1, interpolated from table
  readonly threshold: number;      // 0-1, metric-specific
  readonly suppressed: boolean;    // accuracy < threshold
  readonly bucket: AngleBucket;    // for debug labeling
}

/** Full gating result for a swing, suitable for swing_debug. */
export interface AngleGatingResult {
  readonly tableVersion: number;
  readonly cameraAngleDeg: number;
  readonly bucket: AngleBucket;
  readonly suppressed: readonly string[];
  readonly passed: readonly string[];
  readonly details: Readonly<Record<string, MetricGateResult>>;
}

// ---------------------------------------------------------------------------
// Type Guard
// ---------------------------------------------------------------------------

/** Type guard: is this string a key in our accuracy table? */
export function isGatedMetric(key: string): key is GatedMetric {
  return key in ACCURACY_TABLE;
}

// ---------------------------------------------------------------------------
// Constants — Accuracy Lookup Table
// ---------------------------------------------------------------------------

/**
 * Per-metric accuracy at each camera angle bucket.
 *
 * Values are heuristic estimates encoding the physics of 2D projection:
 *   - Horizontal measurements (shoulder tilt, hip rotation) degrade from DTL
 *     because the camera can't see horizontal separation.
 *   - Vertical measurements (spine) are more robust across angles.
 *   - Joint angles (elbows, knees) are 3-joint angles and degrade less.
 *
 * These are reference points for interpolation at bucket midpoints,
 * not hard gates. See `interpolateAccuracy()` for the smooth lookup.
 *
 * All values 0-1 (not percentages). Table is frozen — do not mutate.
 */
export const ACCURACY_TABLE: Readonly<Record<GatedMetric, Readonly<Record<AngleBucket, number>>>> = Object.freeze({
  spineAngle:      Object.freeze({ face_on: 0.95, oblique: 0.85, dtl: 0.70 }),
  shoulderTilt:    Object.freeze({ face_on: 0.90, oblique: 0.75, dtl: 0.58 }),
  hipSpreadDelta:     Object.freeze({ face_on: 0.85, oblique: 0.80, dtl: 0.65 }),
  leftElbowAngle:  Object.freeze({ face_on: 0.90, oblique: 0.85, dtl: 0.80 }),
  rightElbowAngle: Object.freeze({ face_on: 0.90, oblique: 0.85, dtl: 0.80 }),
  leftKneeAngle:   Object.freeze({ face_on: 0.85, oblique: 0.80, dtl: 0.75 }),
  rightKneeAngle:  Object.freeze({ face_on: 0.85, oblique: 0.80, dtl: 0.75 }),
});

/**
 * Per-metric suppression thresholds.
 * If interpolated accuracy at the detected angle < threshold → suppress.
 *
 * Shoulder tilt has the highest threshold (0.85) because showing
 * an incorrect shoulder tilt tip is worse than showing nothing.
 * Spine angle has the lowest (0.60) because it's still useful
 * even from oblique angles.
 *
 * Frozen — do not mutate.
 */
export const THRESHOLDS: Readonly<Record<GatedMetric, number>> = Object.freeze({
  spineAngle:      0.60,
  shoulderTilt:    0.85,
  hipSpreadDelta:     0.60,
  leftElbowAngle:  0.70,
  rightElbowAngle: 0.70,
  leftKneeAngle:   0.70,
  rightKneeAngle:  0.70,
});

/**
 * Angle bucket boundaries (degrees) for classification labels.
 * [0, 20) = face_on, [20, 55) = oblique, [55, 90] = dtl.
 */
export const BUCKET_BOUNDARIES = Object.freeze({
  FACE_ON_MAX: 20,
  OBLIQUE_MAX: 55,
} as const);

/**
 * Bucket midpoints (degrees) — interpolation anchors.
 *
 * The accuracy table gives values at these representative angles.
 * Between midpoints, accuracy is linearly interpolated to avoid
 * hard cliffs at bucket boundaries.
 *
 *   face_on midpoint: 10° (middle of 0-20)
 *   oblique midpoint: 37.5° (middle of 20-55)
 *   dtl midpoint:     72.5° (middle of 55-90)
 *
 * Below 10° → clamp to face_on value.
 * Above 72.5° → clamp to dtl value.
 */
export const BUCKET_MIDPOINTS = Object.freeze({
  face_on: 10,
  oblique: 37.5,
  dtl:     72.5,
} as const);

/**
 * Metrics that are EXEMPT from angle gating.
 * Timing-based metrics are accurate from any camera angle.
 */
export const EXEMPT_METRICS: ReadonlySet<string> = new Set([
  'tempo',
  'tempoRatio',
  'backswingTime',
  'downswingTime',
]);

/** All gatable metric keys, derived from ACCURACY_TABLE for guaranteed sync. */
export const ALL_GATED_METRICS: readonly GatedMetric[] = Object.freeze(
  Object.keys(ACCURACY_TABLE) as GatedMetric[]
);

// ---------------------------------------------------------------------------
// Pure Functions
// ---------------------------------------------------------------------------

/**
 * Classify camera angle (degrees) into a bucket for labeling/debug.
 *
 * Boundaries: [0, 20) = face_on, [20, 55) = oblique, [55, 90] = dtl.
 * Out-of-range values are clamped: <0 → face_on, >90 → dtl.
 * NaN / ±Infinity → face_on (safe default — shows everything).
 */
export function classifyAngle(angleDeg: number): AngleBucket {
  if (!Number.isFinite(angleDeg)) return 'face_on';
  if (angleDeg < BUCKET_BOUNDARIES.FACE_ON_MAX) return 'face_on';
  if (angleDeg < BUCKET_BOUNDARIES.OBLIQUE_MAX) return 'oblique';
  return 'dtl';
}

/**
 * Linearly interpolate between two values.
 * t is clamped to [0, 1] for safety.
 */
function lerp(a: number, b: number, t: number): number {
  const tc = Math.max(0, Math.min(1, t));
  return a + (b - a) * tc;
}

/**
 * Interpolate accuracy for a metric at an exact camera angle.
 *
 * Instead of hard bucket boundaries (which create accuracy cliffs),
 * this linearly interpolates between the bucket midpoint values:
 *
 *   ≤10°        → face_on value (clamped)
 *   10°–37.5°   → interpolate face_on → oblique
 *   37.5°–72.5° → interpolate oblique → dtl
 *   ≥72.5°      → dtl value (clamped)
 *
 * Example: shoulderTilt at 20°
 *   Bucket approach: cliff from 0.90 → 0.75
 *   Interpolated:    0.845 (smooth transition, still passes 0.85 threshold)
 *
 * Returns null for metrics not in the accuracy table.
 */
export function interpolateAccuracy(metric: string, angleDeg: number): number | null {
  if (!isGatedMetric(metric)) return null;

  const row = ACCURACY_TABLE[metric];
  const fo = row.face_on;
  const ob = row.oblique;
  const dt = row.dtl;

  // Clamp non-finite to face_on (safe default)
  if (!Number.isFinite(angleDeg)) return fo;

  const midFO = BUCKET_MIDPOINTS.face_on;   // 10
  const midOB = BUCKET_MIDPOINTS.oblique;    // 37.5
  const midDT = BUCKET_MIDPOINTS.dtl;        // 72.5

  if (angleDeg <= midFO) return fo;
  if (angleDeg >= midDT) return dt;

  if (angleDeg <= midOB) {
    const t = (angleDeg - midFO) / (midOB - midFO);
    return lerp(fo, ob, t);
  }

  const t = (angleDeg - midOB) / (midDT - midOB);
  return lerp(ob, dt, t);
}

/**
 * Look up the bucket-based accuracy for a metric (no interpolation).
 * Returns null if the metric is not in the accuracy table.
 *
 * Prefer `interpolateAccuracy()` for gating decisions.
 * This exists for direct table inspection and testing.
 */
export function getBucketAccuracy(metric: string, bucket: AngleBucket): number | null {
  if (!isGatedMetric(metric)) return null;
  return ACCURACY_TABLE[metric][bucket];
}

/**
 * Get the suppression threshold for a metric.
 * Returns null if the metric is not gated.
 */
export function getThreshold(metric: string): number | null {
  if (!isGatedMetric(metric)) return null;
  return THRESHOLDS[metric];
}

/**
 * Check whether a single metric should be suppressed at a given camera angle.
 *
 * Uses interpolated accuracy for smooth transitions at bucket boundaries.
 * Returns null for exempt or unknown metrics (they always pass).
 */
export function checkMetric(metric: string, angleDeg: number): MetricGateResult | null {
  if (EXEMPT_METRICS.has(metric)) return null;

  const accuracy = interpolateAccuracy(metric, angleDeg);
  const threshold = getThreshold(metric);

  if (accuracy === null || threshold === null) return null;

  return {
    metric,
    accuracy,
    threshold,
    suppressed: accuracy < threshold,
    bucket: classifyAngle(angleDeg),
  };
}

/**
 * Check whether a metric should be shown (not suppressed) at a given angle.
 *
 * Convenience wrapper: returns true if the metric passes angle gating
 * (or is exempt/unknown). Returns false if suppressed.
 *
 * Integration point in the tip generation layer:
 *   if (!shouldShowMetric(metricKey, cameraAngleDeg)) continue;
 */
export function shouldShowMetric(metric: string, angleDeg: number): boolean {
  const result = checkMetric(metric, angleDeg);
  if (result === null) return true;
  return !result.suppressed;
}

/**
 * Run angle gating across metrics for a swing.
 *
 * Main entry point. Call once per swing with the estimatedAngleDeg
 * from Task 4's camera angle detection.
 *
 * Returns an AngleGatingResult suitable for swing_debug.
 *
 * @param cameraAngleDeg - Estimated camera angle from detectCameraAngle() (0-90°)
 * @param metricKeys - Optional subset of metrics to gate. Defaults to ALL_GATED_METRICS.
 */
export function computeAngleGating(
  cameraAngleDeg: number,
  metricKeys?: readonly string[],
): AngleGatingResult {
  const keys = metricKeys ?? ALL_GATED_METRICS;
  const bucket = classifyAngle(cameraAngleDeg);

  const suppressed: string[] = [];
  const passed: string[] = [];
  const details: Record<string, MetricGateResult> = {};

  for (const key of keys) {
    const result = checkMetric(key, cameraAngleDeg);
    if (result === null) {
      passed.push(key);
      continue;
    }
    details[key] = result;
    if (result.suppressed) {
      suppressed.push(key);
    } else {
      passed.push(key);
    }
  }

  return {
    tableVersion: TABLE_VERSION,
    cameraAngleDeg,
    bucket,
    suppressed,
    passed,
    details,
  };
}

/**
 * Filter an array of metric keys, removing those suppressed at the given angle.
 *
 * Preserves input order. Useful for filtering tip keys before display:
 *   const visibleMetrics = filterMetricsByAngle(tipMetrics, cameraAngleDeg);
 */
export function filterMetricsByAngle(
  metricKeys: readonly string[],
  cameraAngleDeg: number,
): string[] {
  return metricKeys.filter(key => shouldShowMetric(key, cameraAngleDeg));
}
