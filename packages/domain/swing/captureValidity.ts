import type { PoseFrame, JointName } from '../../pose/PoseTypes';
import { msPerFrameFromFrames, msToFrames } from './phaseDetectionShared';

// ── Tunable thresholds (single source of truth) ──────────────────────
// 1c A3: the classification gates are physical capture coverage in ms,
// not frame counts — the old 30/15 frame values were 60fps-only.
// EXTERNAL ASSUMPTION — 1200ms minimum for 'valid' is uncalibrated: real kid
// swings observed at 2300-3300ms; a truncated 792ms fragment previously passed
// the old 500ms floor as 'valid'. 1200ms rejects fragments while leaving
// headroom below the shortest observed real swing. Revisit against corpus.
export const VALID_MIN_MS = 1200;
export const PARTIAL_MIN_MS = 250;
// 60fps frame-count fallbacks, used only when frame timestamps are
// degenerate (span 0 → msPerFrameFromFrames returns 0).
export const VALID_MIN_FRAMES = 30;
export const VALID_MIN_POSE_RATE = 0.70;
export const PARTIAL_MIN_FRAMES = 15;
export const PARTIAL_MIN_POSE_RATE = 0.40;

// ── "Good frame" definition — matches record.tsx quality gate exactly ─
export const JOINT_CONFIDENCE_THRESHOLD = 0.3;
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
  const msPerFrame = msPerFrameFromFrames(frames);
  const validMinFrames = msPerFrame > 0 ? msToFrames(VALID_MIN_MS, msPerFrame) : VALID_MIN_FRAMES;
  const partialMinFrames = msPerFrame > 0 ? msToFrames(PARTIAL_MIN_MS, msPerFrame) : PARTIAL_MIN_FRAMES;

  if (frameCount >= validMinFrames && poseSuccessRate >= VALID_MIN_POSE_RATE) {
    return { validity: 'valid', frameCount, goodFrameCount, poseSuccessRate, reason: null };
  }

  if (frameCount >= partialMinFrames && poseSuccessRate >= PARTIAL_MIN_POSE_RATE) {
    const reason =
      frameCount < validMinFrames
        ? 'Try a slower, fuller swing next time.'
        : 'Step back a bit so we can see you better.';
    return { validity: 'partial', frameCount, goodFrameCount, poseSuccessRate, reason };
  }

  const reason =
    frameCount < partialMinFrames
      ? 'The swing was too quick to catch.'
      : 'We couldn\u2019t see you clearly enough.';
  return { validity: 'invalid', frameCount, goodFrameCount, poseSuccessRate, reason };
}
