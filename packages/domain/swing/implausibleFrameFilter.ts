/**
 * implausibleFrameFilter.ts — Task 12: Implausible Frame Filter
 *
 * Detects frames with anatomically implausible limb proportions and assigns
 * a plausibility score (0 or 1) used to zero-weight those frames in the
 * visibility-weighted averaging (Task 11).
 *
 * Design:
 *   For each 3-joint angle metric (elbows, knees), compute the ratio of the
 *   distal segment to the proximal segment (e.g. forearm:upperArm). Compare
 *   against a reference ratio (global median from Step 0 diagnostic) with a
 *   25% deviation threshold. Frames outside that range are implausible —
 *   typically caused by foreshortening when a limb points toward/away from
 *   the camera, collapsing its projected 2D length.
 *
 * Pipeline position:
 *   Phase detection → computePhaseWindowedAngles (seed)
 *     → applyVisibilityWeighting → buildPipelineFrameData
 *       → THIS MODULE (per frame, per metric) → plausibility score
 *       → computeFrameWeight multiplies visibility × plausibility
 *     → foreshortening correction (Task 5) runs AFTER this
 *
 * Calibration source: scripts/step0-diagnostic.ts, scripts/step0-results.txt
 *   Global medians from 30-swing / 1610-sample dataset.
 *
 * Committed: TBD on v3-dev
 * Depends on: Task 11 (visibility weighting)
 */

import type { JointName, PoseFrame } from '../../pose/PoseTypes';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Module version for swing_debug traceability */
export const TABLE_VERSION = '12.1.0' as const;

/**
 * Deviation threshold: frames whose segment ratio deviates more than 25%
 * from the reference median are flagged implausible.
 * Matches Step 0 diagnostic (scripts/step0-diagnostic.ts:172).
 */
export const DEVIATION_THRESHOLD = 0.25;

/**
 * Minimum joint confidence to attempt ratio assessment.
 * Matches Step 0 diagnostic (scripts/step0-diagnostic.ts:84).
 * Lower than the 0.5 used for angle calculation — we want to assess
 * plausibility even for moderately confident joints; if confidence is
 * truly low (<0.3), visibility weighting already handles exclusion.
 */
export const SEGMENT_CONFIDENCE_THRESHOLD = 0.3;

/**
 * Minimum segment length in normalized coordinates. Below this the
 * segment has collapsed to a point — ratio is meaningless.
 */
export const MIN_SEGMENT_LENGTH = 0.01;

// ---------------------------------------------------------------------------
// Reference ratios — global medians from Step 0 (scripts/step0-results.txt)
// ---------------------------------------------------------------------------

/**
 * forearm/upperArm median = 0.94 (1610 samples, 30 swings).
 * Effective plausible range at ±25%: 0.705 – 1.175.
 */
export const FOREARM_UPPERARM_REFERENCE = 0.94;

/**
 * shin/thigh reference. Step 0 did not compute this ratio directly.
 * Human shin:thigh is anatomically ~0.8–1.0; we use 0.90 as reference
 * with the same ±25% deviation, giving effective range 0.675 – 1.125.
 */
export const SHIN_THIGH_REFERENCE = 0.90;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Defines which limb segments to check for a given angle metric. */
export interface LimbSegmentCheck {
  /** Joint name triplet: [proximal, middle, distal] e.g. [shoulder, elbow, wrist] */
  readonly joints: readonly [JointName, JointName, JointName];
  /** Global median ratio (distal/proximal segment) from Step 0 */
  readonly referenceRatio: number;
  /** Maximum allowed relative deviation from reference (0.25 = 25%) */
  readonly deviationThreshold: number;
}

/** Per-frame plausibility assessment result. */
export interface FramePlausibility {
  /** 1.0 = plausible, 0.0 = implausible */
  readonly score: number;
  /** Which check failed, if any */
  readonly failedCheck?: 'segment_collapsed' | 'ratio_out_of_range';
  /** The measured distal/proximal ratio that triggered failure */
  readonly measuredRatio?: number;
}

/** Per-metric plausibility summary for debug output. */
export interface PlausibilityDebugMetric {
  readonly framesChecked: number;
  readonly framesImplausible: number;
  readonly implausibleIndices: readonly number[];
  readonly worstRatio: number | null;
}

/** Full debug output for swing_debug. */
export interface ImplausibleFrameDebug {
  readonly version: string;
  readonly applied: boolean;
  readonly metrics: Readonly<Record<string, PlausibilityDebugMetric>>;
}

// ---------------------------------------------------------------------------
// Metric-to-limb-check mapping
// ---------------------------------------------------------------------------

/**
 * Only 3-joint angle metrics have limb segment ratios to check.
 * spineAngle, hipRotation, shoulderTilt use midpoints or spreads — no ratio.
 */
export const METRIC_LIMB_CHECKS: Readonly<Record<string, LimbSegmentCheck>> = {
  leftElbowAngle: {
    joints: ['leftShoulder', 'leftElbow', 'leftWrist'],
    referenceRatio: FOREARM_UPPERARM_REFERENCE,
    deviationThreshold: DEVIATION_THRESHOLD,
  },
  rightElbowAngle: {
    joints: ['rightShoulder', 'rightElbow', 'rightWrist'],
    referenceRatio: FOREARM_UPPERARM_REFERENCE,
    deviationThreshold: DEVIATION_THRESHOLD,
  },
  leftKneeAngle: {
    joints: ['leftHip', 'leftKnee', 'leftAnkle'],
    referenceRatio: SHIN_THIGH_REFERENCE,
    deviationThreshold: DEVIATION_THRESHOLD,
  },
  rightKneeAngle: {
    joints: ['rightHip', 'rightKnee', 'rightAnkle'],
    referenceRatio: SHIN_THIGH_REFERENCE,
    deviationThreshold: DEVIATION_THRESHOLD,
  },
};

// ---------------------------------------------------------------------------
// Core math — pure functions
// ---------------------------------------------------------------------------

/** Euclidean distance between two joints in 2D normalized coordinates. */
function segmentLength(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Score a single frame's plausibility for a specific metric.
 *
 * Returns 1.0 (plausible) or 0.0 (implausible). Binary because Step 0
 * diagnostic showed a bimodal distribution — frames are either clearly
 * good or clearly garbage. Downstream math (multiply) handles any [0,1]
 * value if this evolves to continuous scoring.
 */
export function scoreFramePlausibility(
  frame: PoseFrame,
  check: LimbSegmentCheck,
): FramePlausibility {
  const [proximalName, middleName, distalName] = check.joints;
  const proximalJoint = frame.joints[proximalName];
  const middleJoint = frame.joints[middleName];
  const distalJoint = frame.joints[distalName];

  // If any joint is missing or below confidence threshold, we cannot
  // assess plausibility. Return 1.0 to defer to visibility weighting
  // which already handles low-confidence joints.
  if (
    !proximalJoint || !middleJoint || !distalJoint ||
    (proximalJoint.confidence ?? 0) < SEGMENT_CONFIDENCE_THRESHOLD ||
    (middleJoint.confidence ?? 0) < SEGMENT_CONFIDENCE_THRESHOLD ||
    (distalJoint.confidence ?? 0) < SEGMENT_CONFIDENCE_THRESHOLD
  ) {
    return { score: 1.0 };
  }

  const proximalLength = segmentLength(proximalJoint, middleJoint);
  const distalLength = segmentLength(middleJoint, distalJoint);

  // Either segment collapsed to a point — implausible
  if (proximalLength < MIN_SEGMENT_LENGTH || distalLength < MIN_SEGMENT_LENGTH) {
    return { score: 0.0, failedCheck: 'segment_collapsed', measuredRatio: 0 };
  }

  const ratio = distalLength / proximalLength;
  const deviation = Math.abs(ratio - check.referenceRatio) / check.referenceRatio;

  if (deviation > check.deviationThreshold) {
    return { score: 0.0, failedCheck: 'ratio_out_of_range', measuredRatio: ratio };
  }

  return { score: 1.0 };
}
