export type JointName =
  // face
  | "nose"
  | "leftEyeInner"
  | "leftEye"
  | "leftEyeOuter"
  | "rightEyeInner"
  | "rightEye"
  | "rightEyeOuter"
  | "leftEar"
  | "rightEar"
  | "mouthLeft"
  | "mouthRight"
  // upper body
  | "leftShoulder"
  | "rightShoulder"
  | "leftElbow"
  | "rightElbow"
  | "leftWrist"
  | "rightWrist"
  // hands
  | "leftPinky"
  | "rightPinky"
  | "leftIndex"
  | "rightIndex"
  | "leftThumb"
  | "rightThumb"
  // lower body
  | "leftHip"
  | "rightHip"
  | "leftKnee"
  | "rightKnee"
  | "leftAnkle"
  | "rightAnkle"
  // feet
  | "leftHeel"
  | "rightHeel"
  | "leftFootIndex"
  | "rightFootIndex";

export type NormalizedJoint = {
  name: JointName;
  x: number;
  y: number;
  z?: number;
  confidence?: number;
};

export type PoseFrame = {
  timestampMs: number;
  joints: Record<JointName, NormalizedJoint | undefined>;
  frameWidth: number;
  frameHeight: number;
};

export type PoseSequence = {
  frames: PoseFrame[];
  source: string;
  metadata?: {
    fps?: number;
    durationMs?: number;
  };
};

export type V1PoseLandmark = {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  inFrameLikelihood: number;
  isPresent?: boolean;
};

export type V1MotionFrame = {
  landmarks: V1PoseLandmark[];
  timestamp: number;
  frameIndex: number;
};

export function createEmptyJoints(): Record<JointName, NormalizedJoint | undefined> {
  return {
    nose: undefined,
    leftEyeInner: undefined,
    leftEye: undefined,
    leftEyeOuter: undefined,
    rightEyeInner: undefined,
    rightEye: undefined,
    rightEyeOuter: undefined,
    leftEar: undefined,
    rightEar: undefined,
    mouthLeft: undefined,
    mouthRight: undefined,
    leftShoulder: undefined,
    rightShoulder: undefined,
    leftElbow: undefined,
    rightElbow: undefined,
    leftWrist: undefined,
    rightWrist: undefined,
    leftPinky: undefined,
    rightPinky: undefined,
    leftIndex: undefined,
    rightIndex: undefined,
    leftThumb: undefined,
    rightThumb: undefined,
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