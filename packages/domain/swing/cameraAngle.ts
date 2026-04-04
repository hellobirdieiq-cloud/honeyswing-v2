import { PoseFrame } from "../../pose/PoseTypes";

export type CameraAngle = "front" | "side" | "unknown";

export type MetricConfidenceWeights = {
  spineAngle: number;
  leftElbowAngle: number;
  rightElbowAngle: number;
  leftKneeAngle: number;
  rightKneeAngle: number;
  hipRotation: number;
  shoulderTilt: number;
  tempo: number;
};

export type CameraAngleResult = {
  angle: CameraAngle;
  shoulderSpread: number;
  hipSpread: number;
  avgSpread: number;
  weights: MetricConfidenceWeights;
};

const FRONT_THRESHOLD = 0.15;
const SIDE_THRESHOLD = 0.08;
const MIN_CONFIDENCE = 0.5;

const FRONT_WEIGHTS: MetricConfidenceWeights = {
  spineAngle: 0.4,
  leftElbowAngle: 0.9,
  rightElbowAngle: 0.9,
  leftKneeAngle: 0.6,
  rightKneeAngle: 0.6,
  hipRotation: 1.0,
  shoulderTilt: 0.7,
  tempo: 1.0,
};

const SIDE_WEIGHTS: MetricConfidenceWeights = {
  spineAngle: 1.0,
  leftElbowAngle: 0.6,
  rightElbowAngle: 0.6,
  leftKneeAngle: 1.0,
  rightKneeAngle: 1.0,
  hipRotation: 0.2,
  shoulderTilt: 1.0,
  tempo: 1.0,
};

const UNKNOWN_WEIGHTS: MetricConfidenceWeights = {
  spineAngle: Math.min(FRONT_WEIGHTS.spineAngle, SIDE_WEIGHTS.spineAngle),
  leftElbowAngle: Math.min(FRONT_WEIGHTS.leftElbowAngle, SIDE_WEIGHTS.leftElbowAngle),
  rightElbowAngle: Math.min(FRONT_WEIGHTS.rightElbowAngle, SIDE_WEIGHTS.rightElbowAngle),
  leftKneeAngle: Math.min(FRONT_WEIGHTS.leftKneeAngle, SIDE_WEIGHTS.leftKneeAngle),
  rightKneeAngle: Math.min(FRONT_WEIGHTS.rightKneeAngle, SIDE_WEIGHTS.rightKneeAngle),
  hipRotation: Math.min(FRONT_WEIGHTS.hipRotation, SIDE_WEIGHTS.hipRotation),
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

  let angle: CameraAngle;
  if (avgSpread >= FRONT_THRESHOLD) {
    angle = "front";
  } else if (avgSpread <= SIDE_THRESHOLD) {
    angle = "side";
  } else {
    angle = "unknown";
  }

  return {
    angle,
    shoulderSpread,
    hipSpread,
    avgSpread,
    weights: WEIGHT_TABLES[angle],
  };
}
