import type { HandLandmark, HandResult } from '../handDetection';
import {
  HAND_JOINT_NAMES,
  HandJoint,
  type CanonicalHandFrame,
  type CanonicalHandPoint,
  type HandJointId,
  type HandLabel,
} from '../canonicalHandFrame';

/**
 * Wire format emitted by HoneyVisionAppleHandPlugin (file 11, Phase 2B).
 * The Swift side enumerates VNHumanHandPoseObservationJointName cases and ships
 * each detected joint keyed by Apple's joint-name string (kept as-is). We
 * deliberately do NOT pre-map to MediaPipe ids in Swift so the mapping is
 * unit-testable via npx tsx — see Risk Flag #5 in the Phase 2 plan.
 */
export type AppleVisionJointName =
  | 'wrist'
  | 'thumbCMC'
  | 'thumbMP'
  | 'thumbIP'
  | 'thumbTip'
  | 'indexMCP'
  | 'indexPIP'
  | 'indexDIP'
  | 'indexTip'
  | 'middleMCP'
  | 'middlePIP'
  | 'middleDIP'
  | 'middleTip'
  | 'ringMCP'
  | 'ringPIP'
  | 'ringDIP'
  | 'ringTip'
  | 'littleMCP'
  | 'littlePIP'
  | 'littleDIP'
  | 'littleTip';

export type AppleVisionPoint = {
  x: number;
  y: number;
  confidence: number;
};

export type AppleVisionHand = {
  chirality: 'left' | 'right' | 'unknown';
  score: number;
  joints: Partial<Record<AppleVisionJointName, AppleVisionPoint>>;
};

export type AppleVisionHandResult = AppleVisionHand[];

/**
 * Apple Vision joint name → MediaPipe HandLandmarker id (0-20).
 * Anatomically 1:1. The only naming gotchas are Apple's "MP" vs MP's "Mcp"
 * (thumb second joint) and Apple's "little*" vs MP's "pinky*" (5th finger).
 * Tested exhaustively in visionHandAdapter.test.ts.
 */
export const APPLE_VISION_JOINT_TO_MP_ID: Record<AppleVisionJointName, HandJointId> = {
  wrist: HandJoint.WRIST,
  thumbCMC: HandJoint.THUMB_CMC,
  thumbMP: HandJoint.THUMB_MCP,
  thumbIP: HandJoint.THUMB_IP,
  thumbTip: HandJoint.THUMB_TIP,
  indexMCP: HandJoint.INDEX_MCP,
  indexPIP: HandJoint.INDEX_PIP,
  indexDIP: HandJoint.INDEX_DIP,
  indexTip: HandJoint.INDEX_TIP,
  middleMCP: HandJoint.MIDDLE_MCP,
  middlePIP: HandJoint.MIDDLE_PIP,
  middleDIP: HandJoint.MIDDLE_DIP,
  middleTip: HandJoint.MIDDLE_TIP,
  ringMCP: HandJoint.RING_MCP,
  ringPIP: HandJoint.RING_PIP,
  ringDIP: HandJoint.RING_DIP,
  ringTip: HandJoint.RING_TIP,
  littleMCP: HandJoint.PINKY_MCP,
  littlePIP: HandJoint.PINKY_PIP,
  littleDIP: HandJoint.PINKY_DIP,
  littleTip: HandJoint.PINKY_TIP,
};

const APPLE_CHIRALITY_TO_HAND_LABEL: Record<AppleVisionHand['chirality'], HandLabel> = {
  left: 'Left',
  right: 'Right',
  unknown: 'Unknown',
};

/**
 * Map Apple Vision hand pose output → detector-neutral CanonicalHandFrame[].
 *
 * Each detected hand becomes one CanonicalHandFrame with up to 21 points; joints
 * Apple's classifier failed to locate are simply omitted. The server's
 * `lms.length < 21` gate at supabase/functions/classify-grip/index.ts:205 will
 * reject incomplete hands before geometry math runs.
 */
export function visionToCanonical(result: AppleVisionHandResult): CanonicalHandFrame[] {
  return result.map((hand, handIndex) => {
    const points: CanonicalHandPoint[] = [];
    for (const [rawName, point] of Object.entries(hand.joints)) {
      if (!point) continue;
      const joint = APPLE_VISION_JOINT_TO_MP_ID[rawName as AppleVisionJointName];
      if (joint === undefined) continue;
      points.push({
        joint,
        x: point.x,
        y: point.y,
        confidence: point.confidence,
      });
    }
    points.sort((a, b) => a.joint - b.joint);

    return {
      detectorType: 'apple_vision',
      handIndex,
      handedness: APPLE_CHIRALITY_TO_HAND_LABEL[hand.chirality],
      handScore: hand.score,
      points,
    };
  });
}

/**
 * Inverse projection: CanonicalHandFrame[] → HandResult[]. Used by
 * capture-vision.tsx in Phase 2C to route Apple Vision results through the
 * existing /grip/result screen (which still expects the MediaPipe-shaped JSON
 * payload). Phase 2E refactors /grip/result to consume CanonicalHandFrame
 * directly and this function is removed.
 *
 * Round-trip identity holds for MediaPipe frames: visibility ↔ confidence and
 * z preserved 1:1. For Apple Vision frames, z defaults to 0 (Apple Vision is
 * 2D) and `name` is resolved from HAND_JOINT_NAMES by joint id.
 */
export function canonicalToHandResult(frames: CanonicalHandFrame[]): HandResult[] {
  return frames.map((frame) => {
    const landmarks: HandLandmark[] = frame.points.map((pt) => ({
      id: pt.joint,
      name: HAND_JOINT_NAMES[pt.joint] ?? `landmark_${pt.joint}`,
      x: pt.x,
      y: pt.y,
      z: pt.z ?? 0,
      visibility: pt.confidence,
    }));
    return {
      handIndex: frame.handIndex,
      label: frame.handedness,
      score: frame.handScore,
      landmarks,
    };
  });
}
