import { PoseFrame } from "../../pose/PoseTypes";

export type CameraAngle = "front" | "side" | "unknown";

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
const FRONT_THRESHOLD = 0.40;
// [EXTERNAL ASSUMPTION] empirically derived from 6 swings (3 DTL, 3 face-on)
const SIDE_THRESHOLD = 0.55;
const MIN_CONFIDENCE = 0.5;

const FRONT_WEIGHTS: MetricConfidenceWeights = {
  spineAngle: 0.4,
  leftElbowAngle: 0.9,
  rightElbowAngle: 0.9,
  leftKneeAngle: 0.6,
  rightKneeAngle: 0.6,
  hipSpreadDelta: 1.0,
  shoulderTilt: 0.7,
  tempo: 1.0,
};

const SIDE_WEIGHTS: MetricConfidenceWeights = {
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
  spineAngle: Math.min(FRONT_WEIGHTS.spineAngle, SIDE_WEIGHTS.spineAngle),
  leftElbowAngle: Math.min(FRONT_WEIGHTS.leftElbowAngle, SIDE_WEIGHTS.leftElbowAngle),
  rightElbowAngle: Math.min(FRONT_WEIGHTS.rightElbowAngle, SIDE_WEIGHTS.rightElbowAngle),
  leftKneeAngle: Math.min(FRONT_WEIGHTS.leftKneeAngle, SIDE_WEIGHTS.leftKneeAngle),
  rightKneeAngle: Math.min(FRONT_WEIGHTS.rightKneeAngle, SIDE_WEIGHTS.rightKneeAngle),
  hipSpreadDelta: Math.min(FRONT_WEIGHTS.hipSpreadDelta, SIDE_WEIGHTS.hipSpreadDelta),
  shoulderTilt: Math.min(FRONT_WEIGHTS.shoulderTilt, SIDE_WEIGHTS.shoulderTilt),
  tempo: 1.0,
};

const WEIGHT_TABLES: Record<CameraAngle, MetricConfidenceWeights> = {
  front: FRONT_WEIGHTS,
  side: SIDE_WEIGHTS,
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
    if (footIndexNorm >= SIDE_THRESHOLD) {
      angle = "side";
    } else if (footIndexNorm <= FRONT_THRESHOLD) {
      angle = "front";
    } else {
      angle = "unknown";
    }
  } else if (ankleSpread != null) {
    // [EXTERNAL ASSUMPTION] ankle fallback thresholds — empirically derived from 6 swings (3 DTL, 3 face-on)
    if (ankleSpread >= 0.07) {
      angle = "side";
    } else if (ankleSpread <= 0.02) {
      angle = "front";
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
