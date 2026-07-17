/**
 * detectFineTakeaway.ts — TAKEAWAY fine stage: refined-head ramp foot
 * (Putting spec §4.4 FINE; Phase A2).
 *
 * Exact port of the v8 head-refinement playground `run` handler
 * (docs/putting-cv-test/playground/head-refinement-test-v8.html):
 *  - window = [coarse−22, min(top, coarse+18)]
 *  - LOCAL reference = median refined-head point over [coarse−20, coarse−6]
 *  - σ = n−1 stddev of ref displacements from the reference point
 *  - hard cross = first f ≥ coarse−15 with 3 consecutive disp > max(3σ, 1.2px)
 *  - ramp foot = walk back from the cross while disp > medRest + 2σ
 *    (and f ≥ coarse−15); onset = first frame of the sustained rise
 * Press-holds (step-then-flat) are excluded by design — a plateau is not a
 * ramp. Coast frames carry the predicted head, so the series is gap-free.
 *
 * Displacements are ANALYSIS px @480w (the 1.2px floor is literal in that
 * space). Refined-head rest noise measured σ 0.15–0.39px at n=2.
 *
 * Validated onsets: ~78-80 vs label 77 (clip 51b07a6b), ~57-59 vs eyes 56
 * (clip a347efc8) — device-run fixtures lock these post-batch (the v8 DATA
 * `disp` field is NOT a valid fixture: geometry-only vs a GLOBAL reference).
 * All constants EXTERNAL ASSUMPTION at n=2.
 */

import type { RefinedHeadPoint } from './types';

export const WINDOW_BACK = 22;
export const WINDOW_FWD = 18;
export const REF_BACK_START = 20;
export const REF_BACK_END = 6;
export const SCAN_FLOOR_OFFSET = 15;
export const HARD_CROSS_CONSEC = 3;
export const HARD_CROSS_MIN_PX = 1.2;
export const CROSS_SIGMA_MULT = 3;
export const RAMP_SIGMA_MULT = 2;

function median(a: number[]): number {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Window of frames the native refine pass must cover. */
export function computeRefineWindow(
  coarse: number,
  top: number,
): { lo: number; hi: number } {
  return { lo: coarse - WINDOW_BACK, hi: Math.min(top, coarse + WINDOW_FWD) };
}

export type DisplacementSeries = {
  rx: number;
  ry: number;
  /** n−1 stddev of ref-window displacements. */
  sigma: number;
  /** median of ref-window displacements. */
  medRest: number;
  dispByFrame: Map<number, number>;
};

/**
 * Reference point + per-frame displacement from refined-head points. Returns
 * null when the ref window has no points (fine stage skipped, coarse stands).
 */
export function buildDisplacement(
  points: readonly RefinedHeadPoint[],
  coarse: number,
): DisplacementSeries | null {
  const refLo = coarse - REF_BACK_START;
  const refHi = coarse - REF_BACK_END;
  const ref = points.filter((p) => p.gridIdx >= refLo && p.gridIdx <= refHi);
  if (ref.length === 0) return null;

  const rx = median(ref.map((p) => p.x));
  const ry = median(ref.map((p) => p.y));
  const ds = ref.map((p) => Math.hypot(p.x - rx, p.y - ry));
  const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
  const sigma = Math.sqrt(
    ds.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, ds.length - 1),
  );
  const medRest = median(ds);

  const dispByFrame = new Map<number, number>();
  for (const p of points) dispByFrame.set(p.gridIdx, Math.hypot(p.x - rx, p.y - ry));
  return { rx, ry, sigma, medRest, dispByFrame };
}

/**
 * Hard cross + ramp-foot walkback. onset null when no sustained cross exists
 * (no-stroke inside the window / all-quiet series).
 */
export function findOnset(
  series: DisplacementSeries,
  coarse: number,
): { onset: number | null; hardCross: number | null; thresholdPx: number; rampFloorPx: number } {
  const threshold = Math.max(CROSS_SIGMA_MULT * series.sigma, HARD_CROSS_MIN_PX);
  const rampFloor = series.medRest + RAMP_SIGMA_MULT * series.sigma;
  const scanFloor = coarse - SCAN_FLOOR_OFFSET;

  const ks = [...series.dispByFrame.keys()].sort((a, b) => a - b);
  let cross: number | null = null;
  for (let i = 0; i + HARD_CROSS_CONSEC - 1 < ks.length; i++) {
    if (ks[i] < scanFloor) continue;
    let all = true;
    for (let m = 0; m < HARD_CROSS_CONSEC; m++) {
      if ((series.dispByFrame.get(ks[i + m]) as number) <= threshold) {
        all = false;
        break;
      }
    }
    if (all) {
      cross = ks[i];
      break;
    }
  }
  if (cross === null) {
    return { onset: null, hardCross: null, thresholdPx: threshold, rampFloorPx: rampFloor };
  }

  let j = ks.indexOf(cross);
  while (
    j > 0 &&
    (series.dispByFrame.get(ks[j - 1]) as number) > rampFloor &&
    ks[j - 1] >= scanFloor
  ) {
    j--;
  }
  return { onset: ks[j], hardCross: cross, thresholdPx: threshold, rampFloorPx: rampFloor };
}
