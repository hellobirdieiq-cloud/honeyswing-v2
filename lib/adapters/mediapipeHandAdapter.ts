import type { HandResult } from '../handDetection';
import type {
  CanonicalHandFrame,
  CanonicalHandPoint,
  HandJointId,
  HandLabel,
} from '../canonicalHandFrame';

/**
 * Map MediaPipe HandLandmarker output to detector-neutral CanonicalHandFrame[].
 *
 * Identity mapping: MediaPipe landmark indices (0-20) ARE the canonical HandJoint
 * ids, so per-point translation is a field rename (visibility -> confidence).
 * The reverse trip lives in visionHandAdapter as canonicalToHandResult.
 */
export function mediapipeToCanonical(result: HandResult[]): CanonicalHandFrame[] {
  return result.map((hand) => {
    const points: CanonicalHandPoint[] = hand.landmarks.map((lm) => ({
      joint: lm.id as HandJointId,
      x: lm.x,
      y: lm.y,
      z: lm.z,
      confidence: lm.visibility,
    }));

    const handedness: HandLabel =
      hand.label === 'Left' || hand.label === 'Right' ? hand.label : 'Unknown';

    return {
      detectorType: 'mediapipe',
      handIndex: hand.handIndex,
      handedness,
      handScore: hand.score,
      points,
    };
  });
}
