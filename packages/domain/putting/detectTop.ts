/**
 * detectTop.ts — TOP via hand-x velocity zero-crossing + club lag
 * (Putting spec §4.3).
 *
 * handVx(f) = (ax[f+2] − ax[f−2]) / 4 on med3-smoothed pose anchorX
 * (fallback ±1 stencil). Backswing sign = dominant sign in
 * [impact−70, impact−25]. Crossing = first f in [impact−60, impact] with
 * 2 consecutive opposite-sign velocities. TOP = crossing + 3 (club lags
 * hands; +3 measured identical on both validation clips).
 *
 * anchorX may be in any consistent unit (normalized 0–1 as exported) — only
 * velocity SIGNS matter. All constants EXTERNAL ASSUMPTION at n=2:
 * top 121 vs revised label 120 (clip 51b07a6b), 118 exact (clip a347efc8).
 */

import type { PosePriorSample } from './types';
import { handVx, smoothedAnchorX } from './handVelocity';

export const CLUB_LAG_FRAMES = 3;
/** Backswing-sign window: [impact−70, impact−25]. */
export const SIGN_WINDOW_START_OFFSET = 70;
export const SIGN_WINDOW_END_OFFSET = 25;
/** Crossing search window: [impact−60, impact]. */
export const CROSS_WINDOW_OFFSET = 60;

export function detectTop(
  priors: readonly PosePriorSample[],
  impactFrame: number | null,
): {
  topFrame: number | null;
  crossingFrame: number | null;
  backswingSign: 1 | -1 | null;
} {
  if (impactFrame == null) return { topFrame: null, crossingFrame: null, backswingSign: null };

  const ax = smoothedAnchorX(priors);

  // Dominant hand-x velocity sign during the backswing window.
  let pos = 0;
  let neg = 0;
  const signStart = Math.max(0, impactFrame - SIGN_WINDOW_START_OFFSET);
  const signEnd = Math.max(0, impactFrame - SIGN_WINDOW_END_OFFSET);
  for (let f = signStart; f <= signEnd; f++) {
    const v = handVx(ax, f);
    if (v == null || v === 0) continue;
    if (v > 0) pos++;
    else neg++;
  }
  if (pos === neg) return { topFrame: null, crossingFrame: null, backswingSign: null };
  const backswingSign: 1 | -1 = pos > neg ? 1 : -1;

  // First frame with 2 consecutive velocities opposing the backswing sign.
  const crossStart = Math.max(0, impactFrame - CROSS_WINDOW_OFFSET);
  for (let f = crossStart; f <= impactFrame; f++) {
    const v0 = handVx(ax, f);
    const v1 = handVx(ax, f + 1);
    if (v0 == null || v1 == null) continue;
    if (Math.sign(v0) === -backswingSign && Math.sign(v1) === -backswingSign) {
      return { topFrame: f + CLUB_LAG_FRAMES, crossingFrame: f, backswingSign };
    }
  }
  return { topFrame: null, crossingFrame: null, backswingSign };
}
