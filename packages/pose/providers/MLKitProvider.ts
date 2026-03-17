import { PoseProvider } from "../PoseProvider";
import {
  JointName,
  PoseFrame,
  PoseSequence,
  V1PoseLandmark,
  createEmptyJoints,
} from "../PoseTypes";

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

function mapLandmarksToPoseFrame(params: {
  landmarks: V1PoseLandmark[];
  timestampMs: number;
  frameWidth: number;
  frameHeight: number;
}): PoseFrame {
  const { landmarks, timestampMs, frameWidth, frameHeight } = params;
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
      confidence: Number.isFinite((landmark as any).confidence)
        ? (landmark as any).confidence
        : Number.isFinite(landmark.inFrameLikelihood)
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

export class MLKitProvider implements PoseProvider {
  name = "mlkit";

  async detectFromVideo({ videoUri }: { videoUri: string }): Promise<PoseSequence> {
    void videoUri;
    throw new Error("MLKitProvider.detectFromVideo not implemented yet");
  }

  async detectFromFrame(params: {
    frame: unknown;
    timestampMs: number;
    frameWidth: number;
    frameHeight: number;
  }): Promise<PoseFrame> {
    const { frame, timestampMs, frameWidth, frameHeight } = params;
    const landmarks = frame as V1PoseLandmark[];

    return mapLandmarksToPoseFrame({
      landmarks,
      timestampMs,
      frameWidth,
      frameHeight,
    });
  }
}