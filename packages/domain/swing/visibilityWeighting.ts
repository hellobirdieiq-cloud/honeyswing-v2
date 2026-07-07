/**
 * visibilityWeighting.ts — Task 11: Visibility-Weighted Angle Calculation
 *
 * Uses MediaPipe per-landmark visibility scores (0-1) to weight each frame's
 * contribution to multi-frame angle averaging. Occluded or low-confidence
 * joints have less influence on the final measurement.
 *
 * Design:
 *   Weight per frame = min(visibility of involved landmarks).
 *   Using min (not mean) is conservative — one bad landmark makes the whole
 *   frame suspect because angle computation uses ALL involved landmarks.
 *   Below MIN_VISIBILITY_THRESHOLD → frame excluded entirely.
 *   If ALL frames excluded → fallback to unweighted mean (no NaN).
 *
 * Pipeline position:
 *   Task 2 (multi-frame averaging) → THIS MODULE → angle calculation
 *   Foreshortening (Task 5) runs AFTER this.
 *   Confidence (Task 6) uses visibility at swing level; this uses it per-frame.
 *   Angle gating (Task 9) gates by camera angle; this gates by landmark quality.
 *
 * Committed: TBD on v3-dev
 * Depends on: Task 1 (Z coordinates), Task 2 (multi-frame averaging)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Module version for swing_debug traceability */
export const TABLE_VERSION = '11.1.0' as const;

/**
 * Frames with min landmark visibility below this are excluded entirely.
 * A landmark at 0.05 visibility is a pure guess — including it adds noise.
 */
export const MIN_VISIBILITY_THRESHOLD = 0.1;

/**
 * If total weight across all frames is below EPSILON, fall back to
 * unweighted mean to avoid division-by-near-zero instability.
 */
export const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// MediaPipe landmark index constants (33-joint model)
// ---------------------------------------------------------------------------

export const LANDMARK = Object.freeze({
  LEFT_SHOULDER:  11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW:     13,
  RIGHT_ELBOW:    14,
  LEFT_WRIST:     15,
  RIGHT_WRIST:    16,
  LEFT_HIP:       23,
  RIGHT_HIP:      24,
  LEFT_KNEE:      25,
  RIGHT_KNEE:     26,
  LEFT_ANKLE:     27,
  RIGHT_ANKLE:    28,
} as const);

// ---------------------------------------------------------------------------
// Metric → required landmark indices
// ---------------------------------------------------------------------------

export type GatedMetricKey =
  | 'spineAngle'
  | 'shoulderTilt'
  | 'hipSpreadDelta'
  | 'leftElbowAngle'
  | 'rightElbowAngle'
  | 'leftKneeAngle'
  | 'rightKneeAngle';

/**
 * Which landmarks are required for each metric's angle calculation.
 * A frame's weight = min(visibility of these landmarks).
 */
export const METRIC_LANDMARKS: Readonly<Record<GatedMetricKey, readonly number[]>> = Object.freeze({
  spineAngle:      Object.freeze([LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER, LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP]),
  shoulderTilt:    Object.freeze([LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER]),
  hipSpreadDelta:     Object.freeze([LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP]),
  leftElbowAngle:  Object.freeze([LANDMARK.LEFT_SHOULDER, LANDMARK.LEFT_ELBOW, LANDMARK.LEFT_WRIST]),
  rightElbowAngle: Object.freeze([LANDMARK.RIGHT_SHOULDER, LANDMARK.RIGHT_ELBOW, LANDMARK.RIGHT_WRIST]),
  leftKneeAngle:   Object.freeze([LANDMARK.LEFT_HIP, LANDMARK.LEFT_KNEE, LANDMARK.LEFT_ANKLE]),
  rightKneeAngle:  Object.freeze([LANDMARK.RIGHT_HIP, LANDMARK.RIGHT_KNEE, LANDMARK.RIGHT_ANKLE]),
});

export const ALL_METRIC_KEYS: readonly GatedMetricKey[] = Object.freeze(
  Object.keys(METRIC_LANDMARKS) as GatedMetricKey[]
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-frame data for a single metric: the computed angle value and the
 * visibility scores for each landmark involved in computing that angle.
 */
export interface FrameAngleData {
  /** Computed angle in degrees for this frame */
  readonly angle: number;
  /**
   * Visibility score (0-1) for each landmark used in this metric's calculation.
   * Array indices correspond to METRIC_LANDMARKS[metricKey] order.
   * Missing/undefined entries treated as 0 (excluded).
   */
  readonly landmarkVisibilities: readonly number[];
  /**
   * Plausibility score (0-1) from implausible frame filter (Task 12).
   * 0 = implausible limb proportions, 1 = plausible. Default: 1.0.
   */
  readonly plausibility?: number;
  /**
   * Measured distal/proximal segment ratio from the plausibility check —
   * present only on implausible frames (0 for a collapsed segment). Feeds
   * implausible-frame telemetry (worstRatio); never used in weighting math.
   */
  readonly measuredRatio?: number;
}

/** Per-metric result from visibility weighting */
export interface MetricWeightingResult {
  /** Final angle after visibility-weighted averaging */
  readonly weightedValue: number;
  /** Simple unweighted mean for comparison */
  readonly unweightedValue: number;
  /** weightedValue - unweightedValue */
  readonly delta: number;
  /** Number of frames that contributed (above threshold) */
  readonly framesUsed: number;
  /** Number of frames excluded (below threshold) */
  readonly framesExcluded: number;
  /** Mean weight across contributing frames */
  readonly avgWeight: number;
  /** Minimum weight across contributing frames (0 if none used) */
  readonly minWeight: number;
  /** Whether weighting was applied (false = fell back to unweighted) */
  readonly applied: boolean;
}

/** Full swing visibility weighting debug output for swing_debug */
export interface VisibilityWeightingResult {
  /** Whether any metric had weighting applied */
  readonly applied: boolean;
  /** Module version for traceability */
  readonly version: string;
  /** Per-metric results */
  readonly metrics: Readonly<Record<string, MetricWeightingResult>>;
}

// ---------------------------------------------------------------------------
// Core math — pure functions
// ---------------------------------------------------------------------------

/**
 * Sanitize a visibility value. NaN, undefined, negative → 0.
 * Clamps to [0, 1].
 */
export function sanitizeVisibility(v: number | undefined | null): number {
  if (v === undefined || v === null || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Compute the weight for a single frame given the visibility scores of
 * all landmarks involved in that metric. Weight = min(visibilities).
 * If any visibility is below MIN_VISIBILITY_THRESHOLD, the entire frame
 * is excluded (returns 0).
 */
export function computeFrameWeight(
  landmarkVisibilities: readonly number[],
  plausibility?: number,
): number {
  if (landmarkVisibilities.length === 0) return 0;

  const sanitized = landmarkVisibilities.map(sanitizeVisibility);
  const minVis = Math.min(...sanitized);

  if (minVis < MIN_VISIBILITY_THRESHOLD) return 0;

  // Task 12: Implausible frames get zero weight
  const p = plausibility ?? 1.0;
  if (p <= 0) return 0;

  return minVis * p;
}

/**
 * Simple arithmetic mean. Returns NaN for empty arrays.
 */
export function simpleMean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
  }
  return sum / values.length;
}

/**
 * Weighted mean of values with corresponding weights.
 * Falls back to simple mean if total weight < EPSILON.
 * Returns NaN for empty arrays.
 */
export function weightedMean(
  values: readonly number[],
  weights: readonly number[]
): { result: number; fellBack: boolean } {
  if (values.length === 0) return { result: NaN, fellBack: false };
  if (values.length !== weights.length) {
    throw new Error(
      `weightedMean: values.length (${values.length}) !== weights.length (${weights.length})`
    );
  }

  let totalWeight = 0;
  for (let i = 0; i < weights.length; i++) {
    totalWeight += weights[i];
  }

  if (totalWeight < EPSILON) {
    // All weights near zero → fall back to unweighted
    return { result: simpleMean(values), fellBack: true };
  }

  let weightedSum = 0;
  for (let i = 0; i < values.length; i++) {
    weightedSum += values[i] * weights[i];
  }

  return { result: weightedSum / totalWeight, fellBack: false };
}

// ---------------------------------------------------------------------------
// Per-metric computation
// ---------------------------------------------------------------------------

/**
 * Compute visibility-weighted angle for a single metric across multiple frames.
 *
 * @param frames - Per-frame angle + landmark visibility data
 * @returns MetricWeightingResult with weighted angle, debug stats, fallback flag
 */
export function computeMetricWeighting(
  frames: readonly FrameAngleData[]
): MetricWeightingResult {
  // Edge case: no frames
  if (frames.length === 0) {
    return {
      weightedValue: NaN,
      unweightedValue: NaN,
      delta: NaN,
      framesUsed: 0,
      framesExcluded: 0,
      avgWeight: 0,
      minWeight: 0,
      applied: false,
    };
  }

  // Edge case: single frame — return angle directly, no averaging possible
  if (frames.length === 1) {
    const angle = frames[0].angle;
    return {
      weightedValue: angle,
      unweightedValue: angle,
      delta: 0,
      framesUsed: 1,
      framesExcluded: 0,
      avgWeight: 1,
      minWeight: 1,
      applied: false, // No weighting applied — nothing to weight against
    };
  }

  // Compute weights for each frame
  const angles: number[] = [];
  const weights: number[] = [];
  let framesExcluded = 0;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const w = computeFrameWeight(frame.landmarkVisibilities, frame.plausibility);
    angles.push(frame.angle);
    weights.push(w);
    if (w === 0) framesExcluded++;
  }

  const framesUsed = frames.length - framesExcluded;
  const unweightedValue = simpleMean(angles);
  const { result: weightedValue, fellBack } = weightedMean(angles, weights);

  // Stats across contributing frames only
  const contributingWeights = weights.filter(w => w > 0);
  const avgWeight = contributingWeights.length > 0
    ? contributingWeights.reduce((a, b) => a + b, 0) / contributingWeights.length
    : 0;
  const minWeight = contributingWeights.length > 0
    ? Math.min(...contributingWeights)
    : 0;

  return {
    weightedValue,
    unweightedValue,
    delta: Number.isFinite(weightedValue) && Number.isFinite(unweightedValue)
      ? round4(weightedValue - unweightedValue)
      : NaN,
    framesUsed,
    framesExcluded,
    avgWeight: round4(avgWeight),
    minWeight: round4(minWeight),
    applied: !fellBack && framesUsed > 0,
  };
}

// ---------------------------------------------------------------------------
// Full swing computation
// ---------------------------------------------------------------------------

/**
 * Compute visibility weighting for all metrics in a swing.
 *
 * @param metricFrames - Map of metric key → array of per-frame angle data.
 *   Only metrics present in the map will be processed.
 *   Keys not matching GatedMetricKey are passed through unchanged.
 * @returns VisibilityWeightingResult for swing_debug
 */
export function computeVisibilityWeighting(
  metricFrames: Readonly<Record<string, readonly FrameAngleData[]>>
): VisibilityWeightingResult {
  const metrics: Record<string, MetricWeightingResult> = {};
  let anyApplied = false;

  for (const key of Object.keys(metricFrames)) {
    const frames = metricFrames[key];
    const result = computeMetricWeighting(frames);
    metrics[key] = result;
    if (result.applied) anyApplied = true;
  }

  return {
    applied: anyApplied,
    version: TABLE_VERSION,
    metrics: Object.freeze(metrics),
  };
}

// ---------------------------------------------------------------------------
// Helper to extract frame data from pipeline structures
// ---------------------------------------------------------------------------

/**
 * Build FrameAngleData[] for a given metric from raw pipeline data.
 *
 * This is the adapter between the pipeline's frame storage format and
 * the pure-function weighting module. The pipeline integration layer
 * calls this to prepare data for computeMetricWeighting().
 *
 * @param frameAngles - The computed angle for each frame in the window
 * @param frameLandmarkVisibilities - Per-frame array of visibility scores
 *   for each landmark. frameLandmarkVisibilities[frameIdx][landmarkIdx] = visibility.
 * @param metricKey - Which metric, used to look up required landmarks
 * @returns FrameAngleData[] ready for computeMetricWeighting()
 */
export function buildFrameAngleData(
  frameAngles: readonly number[],
  frameLandmarkVisibilities: readonly (readonly number[])[],
  metricKey: GatedMetricKey
): FrameAngleData[] {
  if (frameAngles.length !== frameLandmarkVisibilities.length) {
    throw new Error(
      `buildFrameAngleData: frameAngles.length (${frameAngles.length}) !== ` +
      `frameLandmarkVisibilities.length (${frameLandmarkVisibilities.length})`
    );
  }

  const requiredLandmarks = METRIC_LANDMARKS[metricKey];
  if (!requiredLandmarks) {
    throw new Error(`buildFrameAngleData: unknown metric key '${metricKey}'`);
  }

  const result: FrameAngleData[] = [];
  for (let i = 0; i < frameAngles.length; i++) {
    const allVis = frameLandmarkVisibilities[i];
    // Extract visibility for only the required landmarks
    const landmarkVisibilities = requiredLandmarks.map(idx => {
      if (idx >= 0 && idx < allVis.length) {
        return allVis[idx];
      }
      return 0; // Missing landmark → treat as invisible
    });

    result.push({
      angle: frameAngles[i],
      landmarkVisibilities,
    });
  }

  return result;
}

/**
 * Quick check: is a given key a recognized GatedMetricKey?
 */
export function isGatedMetricKey(key: string): key is GatedMetricKey {
  return key in METRIC_LANDMARKS;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Round to 4 decimal places to avoid floating-point noise in debug output */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
