/**
 * handVelocity.ts — med3-smoothed hand-x velocity from pose anchors.
 *
 * Shared by detectTop (zero-crossing) and detectCoarseTakeaway (hand-still
 * qualifier). anchorX MUST be normalized 0–1 (as exported by the harness):
 * detectTop only uses signs, but the hand-still threshold in
 * detectCoarseTakeaway is calibrated in normalized units.
 */

import type { PosePriorSample } from './types';

export function med3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** med3-smoothed anchorX; a lone-frame anchor jump is voted out by its neighbors. */
export function smoothedAnchorX(priors: readonly PosePriorSample[]): (number | null)[] {
  return priors.map((p, i) => {
    if (!p) return null;
    const m = priors[i - 1];
    const n = priors[i + 1];
    if (m && n) return med3(m.anchorX, p.anchorX, n.anchorX);
    return p.anchorX;
  });
}

/** handVx(f) = (ax[f+2] − ax[f−2]) / 4, fallback ±1 stencil; null when neighbors missing. */
export function handVx(ax: readonly (number | null)[], f: number): number | null {
  const p2 = ax[f + 2];
  const m2 = ax[f - 2];
  if (p2 != null && m2 != null) return (p2 - m2) / 4;
  const p1 = ax[f + 1];
  const m1 = ax[f - 1];
  if (p1 != null && m1 != null) return (p1 - m1) / 2;
  return null;
}
