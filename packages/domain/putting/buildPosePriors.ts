/**
 * buildPosePriors.ts — pose-guided shaft priors from motion frames
 * (moved VERBATIM from app/dev/putting-tracker-test.tsx in Phase C so the
 * live putt pipeline and the dev harness share one implementation).
 *
 * One prior per motion-frame entry — indices align 1:1 with the video grid
 * (verified in docs/putting-cv-test/poseAngleScan.ts). angleDeg = folded
 * leftWrist→rightThumbTip PIXEL-space angle minus the calibration bias;
 * anchor = mean of the confident hand joints, normalized 0-1.
 *
 * ⚠️ LOAD-BEARING SENTINEL: frames where the wrist→thumb pair is missing or
 * low-confidence return null; frames where pose produced a zero folded angle
 * emit angleDeg of EXACTLY −3.00 (0 − POSE_SHAFT_CAL_OFFSET_DEG) — the A1
 * sentinel filter (sentinelFilter.ts) depends on that exact value. Do not
 * change the bias without updating the filter.
 *
 * EXTERNAL ASSUMPTION — calibration: LeadWrist→TrailThumbTip runs +3.0° hot
 * vs the human-measured shaft on fixture 1d8722b8 (+1.85°/+4.22° at
 * f55/f114); subtract the bias before use. Pair joints below
 * POSE_PRIOR_MIN_CONF → null prior for that frame (pure-CV gates natively).
 */

export const POSE_SHAFT_CAL_OFFSET_DEG = 3.0;
export const POSE_PRIOR_MIN_CONF = 0.3;

/** The 10 hand/wrist joints that survive to motion_frames. */
export const POSE_HAND_JOINTS = [
  'leftWrist',
  'leftThumb',
  'leftThumbTip',
  'leftIndex',
  'leftPinky',
  'rightWrist',
  'rightThumb',
  'rightThumbTip',
  'rightIndex',
  'rightPinky',
] as const;

export type MotionFrameLite = {
  timestampMs?: number;
  frameWidth?: number;
  frameHeight?: number;
  joints?: Record<string, { x: number; y: number; confidence: number } | undefined>;
};

/** Concrete prior shape — assignable to both the native wrapper's
 * PuttingPosePrior and the domain's PosePriorSample. */
export type BuiltPosePrior = {
  angleDeg: number;
  anchorX: number;
  anchorY: number;
  confidence: number;
} | null;

export function foldDeg(a: number): number {
  let v = a;
  while (v > 90) v -= 180;
  while (v <= -90) v += 180;
  return v;
}

export function buildPosePriors(motionFrames: readonly MotionFrameLite[]): BuiltPosePrior[] {
  return motionFrames.map((f) => {
    const lw = f.joints?.leftWrist;
    const rt = f.joints?.rightThumbTip;
    const w = f.frameWidth;
    const h = f.frameHeight;
    if (!lw || !rt || !w || !h) return null;
    if (!(lw.confidence > POSE_PRIOR_MIN_CONF) || !(rt.confidence > POSE_PRIOR_MIN_CONF)) {
      return null;
    }
    const rawAngle = (Math.atan2(rt.x * w - lw.x * w, rt.y * h - lw.y * h) * 180) / Math.PI;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const name of POSE_HAND_JOINTS) {
      const j = f.joints?.[name];
      if (j && j.confidence > POSE_PRIOR_MIN_CONF) {
        sx += j.x;
        sy += j.y;
        n += 1;
      }
    }
    if (n === 0) return null;
    return {
      angleDeg: foldDeg(foldDeg(rawAngle) - POSE_SHAFT_CAL_OFFSET_DEG),
      anchorX: sx / n,
      anchorY: sy / n,
      confidence: Math.min(lw.confidence, rt.confidence),
    };
  });
}
