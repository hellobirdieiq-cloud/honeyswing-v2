export type JointName =
  | "nose"
  | "leftEye"
  | "rightEye"
  | "leftEar"
  | "rightEar"
  | "leftShoulder"
  | "rightShoulder"
  | "leftElbow"
  | "rightElbow"
  | "leftWrist"
  | "rightWrist"
  | "leftHip"
  | "rightHip"
  | "leftKnee"
  | "rightKnee"
  | "leftAnkle"
  | "rightAnkle"
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