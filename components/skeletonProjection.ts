// Pure coordinate/projection math for the swing skeleton, extracted 1:1 from
// SwingSkeletonCanvas.tsx so it is importable in node tests (the component
// imports react-native-svg at module top level, which cannot load under tsx).
// Function bodies are identical to the originals; the transform factories'
// closed-over props (width/height/frames[0]) became explicit parameters.

import type { PoseFrame, JointName, NormalizedJoint } from '../packages/pose/PoseTypes';

const MIN_CONF = 0.2;

export function getJoint(frame: PoseFrame, name: JointName): NormalizedJoint | null {
  const j = frame.joints[name];
  return j && (j.confidence ?? 0) >= MIN_CONF ? j : null;
}

export function spatialMedian(frame: PoseFrame, names: JointName[]): { x: number; y: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of names) {
    const j = getJoint(frame, n);
    if (j) { xs.push(j.x); ys.push(j.y); }
  }
  if (xs.length === 0) return null;
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return { x: xs[mid], y: ys[mid] };
}

export function temporalMedianSmooth(
  pts: ({ x: number; y: number } | null)[],
  windowSize = 5,
): ({ x: number; y: number } | null)[] {
  const half = Math.floor(windowSize / 2);
  return pts.map((_, i) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(pts.length - 1, i + half); j++) {
      const p = pts[j];
      if (p) { xs.push(p.x); ys.push(p.y); }
    }
    if (xs.length === 0) return null;
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    const m = Math.floor(xs.length / 2);
    return { x: xs[m], y: ys[m] };
  });
}

export function buildPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
  }
  return d;
}

export type SkeletonTransform = {
  tx: (x: number) => number;
  ty: (y: number) => number;
};

/**
 * Driven mode: video & pose share the full 9:16 frame (no crop on either
 * side — pose extracted from the full frame, video contain-fit in a 9:16
 * box), so the identity mapping puts each joint on the golfer's pixel.
 * Keypoints are faithful-anatomical (decode conjugation fix) — no flip.
 */
export function makeDrivenTransform(width: number, height: number): SkeletonTransform {
  const tx = (x: number) => x * width;
  const ty = (y: number) => y * height;
  return { tx, ty };
}

/**
 * Uncontrolled mode: fit the skeleton into the canvas anchored on the given
 * frame's hip midpoint. Returns null when the frame lacks the anchor joints —
 * the caller scans forward to the first frame that has them (T4-97).
 */
export function makeAnchoredTransform(
  f0: PoseFrame,
  width: number,
  height: number,
): SkeletonTransform | null {
  const top = getJoint(f0, 'leftShoulder') ?? getJoint(f0, 'rightShoulder') ?? getJoint(f0, 'nose');
  const bot =
    getJoint(f0, 'leftAnkle') ??
    getJoint(f0, 'rightAnkle') ??
    getJoint(f0, 'leftFootIndex') ??
    getJoint(f0, 'rightFootIndex');
  const lh = getJoint(f0, 'leftHip');
  const rh = getJoint(f0, 'rightHip');
  if (!top || !bot || !lh || !rh) return null;
  const vertical = Math.max(0.01, bot.y - top.y);
  const scale = (height * 0.75) / vertical;
  const H_PAD = 0.70;
  const hScale = scale * H_PAD;
  const hipX0 = (lh.x + rh.x) / 2;
  const hipY0 = (lh.y + rh.y) / 2;
  const anchorX = width / 2;
  const anchorY = height * 0.40;
  const tx = (x: number) => anchorX + (x - hipX0) * hScale;
  const ty = (y: number) => anchorY + (y - hipY0) * scale;
  return { tx, ty };
}
