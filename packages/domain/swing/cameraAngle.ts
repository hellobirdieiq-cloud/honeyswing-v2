import { PoseFrame, PoseSequence } from "../../pose/PoseTypes";

export type CameraAngle = "face_on" | "dtl" | "unknown";

export type MetricConfidenceWeights = {
  spineAngle: number;
  leftElbowAngle: number;
  rightElbowAngle: number;
  leftKneeAngle: number;
  rightKneeAngle: number;
  hipSpreadDelta: number;
  shoulderTilt: number;
  tempo: number;
};

export type CameraAngleResult = {
  angle: CameraAngle;
  shoulderSpread: number;
  hipSpread: number;
  avgSpread: number;
  footIndexNorm: number | null;
  weights: MetricConfidenceWeights;
};

// [EXTERNAL ASSUMPTION] empirically derived from 6 swings (3 DTL, 3 face-on)
const FACE_ON_THRESHOLD = 0.40;
// [EXTERNAL ASSUMPTION] empirically derived from 6 swings (3 DTL, 3 face-on)
const DTL_THRESHOLD = 0.55;
// TODO(DTL launch path + face-on-only policy): recorder-selected capture mode + DTL rule set.
// STOPGAP (2026-06-07): forces face_on for all current (all-face-on) captures.
// All footIndexNorm >= 0.175 -> face_on; unknown unreachable. A real DTL swing
// WILL misclassify as face_on. REVERT by switching the >= comparison below back
// to DTL_THRESHOLD (0.55) and deleting this constant.
// NOTE name inversion: DTL_THRESHOLD bounds the face_on band (see comparison logic).
// Convergence: age-tier or shoulder/hip-spread discriminant pending kid DTL data.
const STOPGAP_FACE_ON_BOUNDARY = 0.175;
const MIN_CONFIDENCE = 0.5;

const FACE_ON_WEIGHTS: MetricConfidenceWeights = {
  spineAngle: 0,
  leftElbowAngle: 0.9,
  rightElbowAngle: 0.9,
  leftKneeAngle: 0.6,
  rightKneeAngle: 0.6,
  hipSpreadDelta: 1.0,
  shoulderTilt: 0.7,
  tempo: 1.0,
};

const DTL_WEIGHTS: MetricConfidenceWeights = {
  spineAngle: 1.0,
  leftElbowAngle: 0.6,
  rightElbowAngle: 0.6,
  leftKneeAngle: 1.0,
  rightKneeAngle: 1.0,
  hipSpreadDelta: 0.2,
  shoulderTilt: 1.0,
  tempo: 1.0,
};

const UNKNOWN_WEIGHTS: MetricConfidenceWeights = {
  spineAngle: Math.min(FACE_ON_WEIGHTS.spineAngle, DTL_WEIGHTS.spineAngle),
  leftElbowAngle: Math.min(FACE_ON_WEIGHTS.leftElbowAngle, DTL_WEIGHTS.leftElbowAngle),
  rightElbowAngle: Math.min(FACE_ON_WEIGHTS.rightElbowAngle, DTL_WEIGHTS.rightElbowAngle),
  leftKneeAngle: Math.min(FACE_ON_WEIGHTS.leftKneeAngle, DTL_WEIGHTS.leftKneeAngle),
  rightKneeAngle: Math.min(FACE_ON_WEIGHTS.rightKneeAngle, DTL_WEIGHTS.rightKneeAngle),
  hipSpreadDelta: Math.min(FACE_ON_WEIGHTS.hipSpreadDelta, DTL_WEIGHTS.hipSpreadDelta),
  shoulderTilt: Math.min(FACE_ON_WEIGHTS.shoulderTilt, DTL_WEIGHTS.shoulderTilt),
  tempo: 1.0,
};

const WEIGHT_TABLES: Record<CameraAngle, MetricConfidenceWeights> = {
  face_on: FACE_ON_WEIGHTS,
  dtl: DTL_WEIGHTS,
  unknown: UNKNOWN_WEIGHTS,
};

function unknownResult(): CameraAngleResult {
  return {
    angle: "unknown",
    shoulderSpread: 0,
    hipSpread: 0,
    avgSpread: 0,
    footIndexNorm: null,
    weights: UNKNOWN_WEIGHTS,
  };
}

export function detectCameraAngle(frame: PoseFrame): CameraAngleResult {
  const ls = frame.joints.leftShoulder;
  const rs = frame.joints.rightShoulder;
  const lh = frame.joints.leftHip;
  const rh = frame.joints.rightHip;

  if (
    !ls || !rs || !lh || !rh ||
    (ls.confidence ?? 0) < MIN_CONFIDENCE ||
    (rs.confidence ?? 0) < MIN_CONFIDENCE ||
    (lh.confidence ?? 0) < MIN_CONFIDENCE ||
    (rh.confidence ?? 0) < MIN_CONFIDENCE
  ) {
    return unknownResult();
  }

  const shoulderSpread = Math.abs(rs.x - ls.x);
  const hipSpread = Math.abs(rh.x - lh.x);
  const avgSpread = (shoulderSpread + hipSpread) / 2;

  const nose = frame.joints.nose;
  const lAnkle = frame.joints.leftAnkle;
  const rAnkle = frame.joints.rightAnkle;
  const bodyHeightValid =
    nose && lAnkle && rAnkle &&
    (nose.confidence ?? 0) >= MIN_CONFIDENCE &&
    (lAnkle.confidence ?? 0) >= MIN_CONFIDENCE &&
    (rAnkle.confidence ?? 0) >= MIN_CONFIDENCE;
  const bodyHeight = bodyHeightValid
    ? Math.abs(((lAnkle!.y + rAnkle!.y) / 2) - nose!.y)
    : 0;

  const lFoot = frame.joints.leftFootIndex;
  const rFoot = frame.joints.rightFootIndex;
  const footValid =
    lFoot && rFoot &&
    (lFoot.confidence ?? 0) >= MIN_CONFIDENCE &&
    (rFoot.confidence ?? 0) >= MIN_CONFIDENCE &&
    bodyHeight > 0;
  const footIndexNorm = footValid
    ? Math.abs(lFoot!.x - rFoot!.x) / bodyHeight
    : null;

  const ankleSpread =
    lAnkle && rAnkle &&
    (lAnkle.confidence ?? 0) >= MIN_CONFIDENCE &&
    (rAnkle.confidence ?? 0) >= MIN_CONFIDENCE
      ? Math.abs(lAnkle.x - rAnkle.x)
      : null;

  let angle: CameraAngle;
  if (footIndexNorm != null) {
    if (footIndexNorm >= STOPGAP_FACE_ON_BOUNDARY) {
      angle = "face_on";
    } else if (footIndexNorm <= FACE_ON_THRESHOLD) {
      angle = "dtl";
    } else {
      angle = "unknown";
    }
  } else if (ankleSpread != null) {
    // [EXTERNAL ASSUMPTION] ankle fallback thresholds — empirically derived from 6 swings (3 DTL, 3 face-on)
    if (ankleSpread >= 0.07) {
      angle = "face_on";
    } else if (ankleSpread <= 0.02) {
      angle = "dtl";
    } else {
      angle = "unknown";
    }
  } else {
    return unknownResult();
  }

  return {
    angle,
    shoulderSpread,
    hipSpread,
    avgSpread,
    footIndexNorm,
    weights: WEIGHT_TABLES[angle],
  };
}

/**
 * Camera angle pre-detection from the address-hold window (pre-swing).
 *
 * The phase-detection dispatcher needs an angle bucket BEFORE phase
 * detection runs (to pick DTL vs face-on rules), but the standard
 * detectCameraAngle() reads from the post-detection address frame.
 * This variant scans the first N frames (golfer holding address) and
 * runs detectCameraAngle on the median-confidence frame. Returns
 * `unknown` if no early frame meets confidence thresholds.
 */
const EARLY_WINDOW_FRAMES = 30;

export function detectCameraAngleEarly(sequence: PoseSequence): CameraAngleResult {
  const frames = sequence.frames;
  if (!frames || frames.length === 0) return unknownResult();

  const windowEnd = Math.min(frames.length, EARLY_WINDOW_FRAMES);
  type Scored = { frame: PoseFrame; conf: number };
  const scored: Scored[] = [];

  for (let i = 0; i < windowEnd; i++) {
    const f = frames[i];
    const ls = f.joints.leftShoulder;
    const rs = f.joints.rightShoulder;
    const lh = f.joints.leftHip;
    const rh = f.joints.rightHip;
    if (
      !ls || !rs || !lh || !rh ||
      (ls.confidence ?? 0) < MIN_CONFIDENCE ||
      (rs.confidence ?? 0) < MIN_CONFIDENCE ||
      (lh.confidence ?? 0) < MIN_CONFIDENCE ||
      (rh.confidence ?? 0) < MIN_CONFIDENCE
    ) {
      continue;
    }
    const conf =
      (ls.confidence ?? 0) +
      (rs.confidence ?? 0) +
      (lh.confidence ?? 0) +
      (rh.confidence ?? 0);
    scored.push({ frame: f, conf });
  }

  if (scored.length === 0) return unknownResult();

  scored.sort((a, b) => a.conf - b.conf);
  const median = scored[Math.floor(scored.length / 2)].frame;
  return detectCameraAngle(median);
}
