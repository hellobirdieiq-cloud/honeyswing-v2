/**
 * sentinelFilter.ts — drop pose-fallback sentinel frames (Putting spec §4.1).
 *
 * The dev harness builds pose priors as leftWrist→rightThumbTip folded angle
 * minus a 3.0° calibration bias; frames where pose extraction fell back yield
 * angleDeg of EXACTLY -3.00 (0 folded − 3.0 bias). Those frames are not
 * measurements — their angle AND anchor are bogus — and unfiltered they poison
 * every median/plateau downstream (clip a347efc8 had a near-all-sentinel early
 * run). EXTERNAL ASSUMPTION at n=2 clips.
 */

import type { PosePriorSample } from './types';

/** Exact angleDeg emitted by the harness on pose fallback. */
export const POSE_FALLBACK_SENTINEL_DEG = -3;

/**
 * Returns an INDEX-STABLE copy with sentinel frames nulled (frame indices are
 * grid indices everywhere downstream — never compact the array).
 */
export function filterSentinelPriors(priors: readonly PosePriorSample[]): {
  filtered: PosePriorSample[];
  droppedCount: number;
} {
  let droppedCount = 0;
  const filtered = priors.map((p) => {
    if (p && p.angleDeg === POSE_FALLBACK_SENTINEL_DEG) {
      droppedCount++;
      return null;
    }
    return p;
  });
  return { filtered, droppedCount };
}
