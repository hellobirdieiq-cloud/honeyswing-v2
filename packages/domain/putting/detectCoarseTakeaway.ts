/**
 * detectCoarseTakeaway.ts — TAKEAWAY, coarse stage (Putting spec §4.4 COARSE).
 *
 * On sentinel-filtered pose angleDeg, walking backward from TOP: the first
 * stable plateau encountered (range ≤ 0.5° over ≥ 4 real frames) is the LAST
 * stable plateau in forward time — the address hold. Takeaway = last frame of
 * that plateau (the frame just before sustained motion).
 *
 * "Real frames" = non-null after sentinel filtering; null gaps between real
 * frames do not break a plateau (only real frames count toward its size, and
 * only real frames can violate its range).
 *
 * THREE qualifiers beyond the frozen prose, jointly formalizing "LAST STABLE
 * plateau" on real pose data (angles are quantized/held across frames, so
 * mid-backswing runs of identical values form fake ≥4-frame plateaus):
 *  - DEPARTURE: between plateau end and TOP the angle must leave the plateau
 *    midpoint by > 3.0° — the backswing must actually happen after the
 *    takeaway. Kills the top-adjacent hold (clip a347efc8 f110–117 departs
 *    only 0.66° before top; true plateaus depart 16–17°).
 *  - NO RE-ENTRY: no later real frame before TOP returns inside the plateau
 *    range ± the 0.5° tolerance — the club leaves address for good. Kills
 *    mid-backswing held-value plateaus (clip 51b07a6b f89–93 re-entered at
 *    f98; clip a347efc8 f72–75 at f77).
 *  - HANDS STILL: max |handVx| over the plateau ≤ 8e-4 normalized-x/frame —
 *    at address the hands are at rest; a held ANGLE mid-backswing still has
 *    moving hands. Kills clip a347efc8 f93–97 (21.5e-4 vs ≤5.2e-4 on both
 *    true plateaus). Threshold ≈ the playground's 0.5px@480w velocity
 *    deadband, sat between 5.2 (worst true) and 11.7 (least-moving false).
 * With these, both clips reproduce the session-validated outputs (77 / 59).
 *
 * All constants EXTERNAL ASSUMPTION at n=2: coarse 77 exact (clip 51b07a6b),
 * 59 vs eyes 56 (clip a347efc8). Press-holds are the known miss of the coarse
 * stage; the fine geometry-head stage (Phase A2) exists to refine this.
 */

import type { PosePriorSample } from './types';
import { handVx, smoothedAnchorX } from './handVelocity';

export const PLATEAU_MAX_RANGE_DEG = 0.5;
export const PLATEAU_MIN_REAL_FRAMES = 4;
export const DEPART_MIN_DEG = 3.0;
/** Normalized-x per frame; anchorX must be normalized 0–1 (see handVelocity.ts). */
export const HAND_STILL_MAX_VX = 8e-4;

export function detectCoarseTakeaway(
  filteredPriors: readonly PosePriorSample[],
  topFrame: number | null,
): {
  takeawayFrame: number | null;
  plateau: { start: number; end: number } | null;
} {
  if (topFrame == null) return { takeawayFrame: null, plateau: null };

  const ax = smoothedAnchorX(filteredPriors);
  const last = Math.min(topFrame - 1, filteredPriors.length - 1);
  for (let end = last; end >= 0; end--) {
    const pEnd = filteredPriors[end];
    if (!pEnd) continue;

    // Extend backward from `end` while the angle range stays within bounds.
    let min = pEnd.angleDeg;
    let max = pEnd.angleDeg;
    let realCount = 1;
    let start = end;
    for (let j = end - 1; j >= 0; j--) {
      const p = filteredPriors[j];
      if (!p) continue;
      const nMin = Math.min(min, p.angleDeg);
      const nMax = Math.max(max, p.angleDeg);
      if (nMax - nMin > PLATEAU_MAX_RANGE_DEG) break;
      min = nMin;
      max = nMax;
      realCount++;
      start = j;
    }
    if (realCount < PLATEAU_MIN_REAL_FRAMES) continue;

    // Departure + no-re-entry qualifiers (see header): after the plateau the
    // angle must swing away by > DEPART_MIN_DEG and never come back inside
    // the plateau band before TOP.
    const plateauMid = (min + max) / 2;
    let maxDeparture = 0;
    let reEntered = false;
    for (let j = end + 1; j <= topFrame; j++) {
      const p = filteredPriors[j];
      if (!p) continue;
      maxDeparture = Math.max(maxDeparture, Math.abs(p.angleDeg - plateauMid));
      if (
        p.angleDeg >= min - PLATEAU_MAX_RANGE_DEG &&
        p.angleDeg <= max + PLATEAU_MAX_RANGE_DEG
      ) {
        reEntered = true;
        break;
      }
    }
    if (reEntered || maxDeparture <= DEPART_MIN_DEG) continue;

    // Hands-still qualifier: the hands must be at rest across the plateau.
    let handsMoving = false;
    for (let j = start; j <= end; j++) {
      if (!filteredPriors[j]) continue;
      const v = handVx(ax, j);
      if (v != null && Math.abs(v) > HAND_STILL_MAX_VX) {
        handsMoving = true;
        break;
      }
    }
    if (handsMoving) continue;

    return { takeawayFrame: end, plateau: { start, end } };
  }
  return { takeawayFrame: null, plateau: null };
}
