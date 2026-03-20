import type { PoseFrame, JointName } from '../packages/pose/PoseTypes';

// ── Tunable thresholds (single source of truth) ──────────────────────
export const VALID_MIN_FRAMES = 30;
export const VALID_MIN_POSE_RATE = 0.70;
export const PARTIAL_MIN_FRAMES = 15;
export const PARTIAL_MIN_POSE_RATE = 0.40;

// ── "Good frame" definition — matches record.tsx quality gate exactly ─
const JOINT_CONFIDENCE_THRESHOLD = 0.3;
const KEY_JOINTS: JointName[] = [
  'leftShoulder', 'rightShoulder', 'leftHip', 'rightHip',
  'leftElbow', 'rightElbow', 'leftKnee', 'rightKnee',
];
const MIN_KEY_JOINTS_PER_FRAME = 4;

export function isGoodFrame(frame: PoseFrame): boolean {
  let confidentJoints = 0;
  for (const jointName of KEY_JOINTS) {
    const joint = frame.joints[jointName];
    if (joint && (joint.confidence ?? 0) >= JOINT_CONFIDENCE_THRESHOLD) {
      confidentJoints++;
    }
  }
  return confidentJoints >= MIN_KEY_JOINTS_PER_FRAME;
}

// ── Classification ───────────────────────────────────────────────────
export type CaptureValidity = 'valid' | 'partial' | 'invalid';

export interface CaptureClassification {
  validity: CaptureValidity;
  frameCount: number;
  goodFrameCount: number;
  poseSuccessRate: number;
  reason: string | null;
}

export function classifyCapture(frames: PoseFrame[]): CaptureClassification {
  const frameCount = frames.length;
  const goodFrameCount = frames.filter(isGoodFrame).length;
  const poseSuccessRate = frameCount > 0 ? goodFrameCount / frameCount : 0;

  if (frameCount >= VALID_MIN_FRAMES && poseSuccessRate >= VALID_MIN_POSE_RATE) {
    return { validity: 'valid', frameCount, goodFrameCount, poseSuccessRate, reason: null };
  }

  if (frameCount >= PARTIAL_MIN_FRAMES && poseSuccessRate >= PARTIAL_MIN_POSE_RATE) {
    const reason =
      frameCount < VALID_MIN_FRAMES
        ? 'Short capture — move slower through your swing.'
        : 'Some frames had weak pose detection.';
    return { validity: 'partial', frameCount, goodFrameCount, poseSuccessRate, reason };
  }

  const reason =
    frameCount < PARTIAL_MIN_FRAMES
      ? 'Too few frames captured.'
      : 'Couldn\u2019t detect your body clearly enough.';
  return { validity: 'invalid', frameCount, goodFrameCount, poseSuccessRate, reason };
}
