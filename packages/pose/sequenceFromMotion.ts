import {
  JointName,
  NormalizedJoint,
  PoseFrame,
  PoseSequence,
  V1MotionFrame,
  V1PoseLandmark,
} from "./PoseTypes";

const V1_TO_V2_JOINT_MAP: Partial<Record<string, JointName>> = {
  nose: "nose",
  leftEye: "leftEye",
  rightEye: "rightEye",
  leftEar: "leftEar",
  rightEar: "rightEar",
  leftShoulder: "leftShoulder",
  rightShoulder: "rightShoulder",
  leftElbow: "leftElbow",
  rightElbow: "rightElbow",
  leftWrist: "leftWrist",
  rightWrist: "rightWrist",
  leftHip: "leftHip",
  rightHip: "rightHip",
  leftKnee: "leftKnee",
  rightKnee: "rightKnee",
  leftAnkle: "leftAnkle",
  rightAnkle: "rightAnkle",
  leftHeel: "leftHeel",
  rightHeel: "rightHeel",
  leftFootIndex: "leftFootIndex",
  rightFootIndex: "rightFootIndex",
};

function createEmptyJoints(): Record<JointName, NormalizedJoint | undefined> {
  return {
    nose: undefined,
    leftEye: undefined,
    rightEye: undefined,
    leftEar: undefined,
    rightEar: undefined,
    leftShoulder: undefined,
    rightShoulder: undefined,
    leftElbow: undefined,
    rightElbow: undefined,
    leftWrist: undefined,
    rightWrist: undefined,
    leftHip: undefined,
    rightHip: undefined,
    leftKnee: undefined,
    rightKnee: undefined,
    leftAnkle: undefined,
    rightAnkle: undefined,
    leftHeel: undefined,
    rightHeel: undefined,
    leftFootIndex: undefined,
    rightFootIndex: undefined,
  };
}

function mapLandmarksToPoseFrame(
  landmarks: V1PoseLandmark[],
  timestampMs: number,
  frameWidth: number,
  frameHeight: number
): PoseFrame {
  const joints = createEmptyJoints();

  for (const landmark of landmarks) {
    const jointName = V1_TO_V2_JOINT_MAP[landmark.name];
    if (!jointName) continue;
    if (landmark.isPresent === false) continue;

    joints[jointName] = {
      name: jointName,
      x: landmark.x,
      y: landmark.y,
      z: Number.isFinite(landmark.z) ? landmark.z : undefined,
      confidence: Number.isFinite(landmark.inFrameLikelihood)
        ? landmark.inFrameLikelihood
        : undefined,
    };
  }

  return {
    timestampMs,
    joints,
    frameWidth,
    frameHeight,
  };
}

export function buildPoseSequenceFromV1Motion(params: {
  frames: V1MotionFrame[];
  frameWidth?: number;
  frameHeight?: number;
  fps?: number;
}): PoseSequence {
  const {
    frames,
    frameWidth = 1,
    frameHeight = 1,
    fps = 30,
  } = params;

  const poseFrames = frames.map((frame) =>
    mapLandmarksToPoseFrame(
      frame.landmarks,
      frame.timestamp,
      frameWidth,
      frameHeight
    )
  );

  return {
    frames: poseFrames,
    source: "recording",
    metadata: {
      fps,
      durationMs: poseFrames.length > 0 ? poseFrames[poseFrames.length - 1].timestampMs : 0,
    },
  };
}

export function buildPoseSequence(frames: PoseFrame[]): PoseSequence {
  return {
    frames,
    source: "recording",
    metadata: {
      fps: 30,
      durationMs: frames.length > 0 ? frames[frames.length - 1].timestampMs : 0,
    },
  };
}
