/**
 * smoothShaftSeries.ts — smoothed shaft series from per-frame bar fits
 * (Putting spec §4.6 anchor/interp rule; Phase A2).
 *
 * Anchor frames = accepted fits (source cv/recovery) with lengthMatch ≥ 0.6
 * (equivalently tubeLen ≥ 0.6 × SHAFT_LEN). Weak frames get LINEAR
 * INTERPOLATION of angle AND pivot between the bracketing anchors; frames
 * before the first / after the last anchor hold that anchor flat. Predicted
 * head per frame: (hx,hy) = (px,py) + (sin ang, cos ang) × (shaftLen+headExt)
 * — canvas convention, y down, 0° = shaft straight down, + toward target.
 *
 * All coordinates ANALYSIS px @480w. Validated behavior locked by
 * smoothShaftSeries.test.ts against the v8 playground DATA blob (identity-flip
 * violations 54 → ~1 across 255 frames on clip 51b07a6b).
 */

import type { ShaftFitSample, SmoothedShaftFrame } from './types';

export const ANCHOR_LENGTH_MATCH_MIN = 0.6;

function isAnchor(fit: ShaftFitSample): fit is NonNullable<ShaftFitSample> {
  return (
    fit != null &&
    (fit.source === 'cv' || fit.source === 'recovery') &&
    fit.lengthMatch != null &&
    fit.lengthMatch >= ANCHOR_LENGTH_MATCH_MIN
  );
}

/**
 * Returns one smoothed frame per input frame, or null when no anchors exist
 * (caller skips fine takeaway with a warning — never throws).
 */
export function smoothShaftSeries(
  shaftFits: readonly ShaftFitSample[],
  shaftLenPx: number,
  headExtPx: number,
): SmoothedShaftFrame[] | null {
  const anchorIdx: number[] = [];
  for (let i = 0; i < shaftFits.length; i++) {
    if (isAnchor(shaftFits[i])) anchorIdx.push(i);
  }
  if (anchorIdx.length === 0) return null;

  const reach = shaftLenPx + headExtPx;
  const out: SmoothedShaftFrame[] = new Array(shaftFits.length);
  let k = 0; // index into anchorIdx of the last anchor at or before i

  for (let i = 0; i < shaftFits.length; i++) {
    while (k + 1 < anchorIdx.length && anchorIdx[k + 1] <= i) k++;
    const prev = anchorIdx[k] <= i ? anchorIdx[k] : null;
    const next =
      anchorIdx[k] >= i ? anchorIdx[k] : k + 1 < anchorIdx.length ? anchorIdx[k + 1] : null;

    let ang: number;
    let px: number;
    let py: number;
    if (prev != null && next != null && prev !== next) {
      const a = shaftFits[prev] as NonNullable<ShaftFitSample>;
      const b = shaftFits[next] as NonNullable<ShaftFitSample>;
      const t = (i - prev) / (next - prev);
      ang = a.angleDeg + (b.angleDeg - a.angleDeg) * t;
      px = a.gripX + (b.gripX - a.gripX) * t;
      py = a.gripY + (b.gripY - a.gripY) * t;
    } else {
      // Held flat from the single bracketing anchor (start/end of series, or i
      // is itself an anchor).
      const src = shaftFits[(prev ?? next) as number] as NonNullable<ShaftFitSample>;
      ang = src.angleDeg;
      px = src.gripX;
      py = src.gripY;
    }

    const r = (ang * Math.PI) / 180;
    out[i] = {
      ang,
      px,
      py,
      hx: px + Math.sin(r) * reach,
      hy: py + Math.cos(r) * reach,
      anchor: prev === i || next === i,
    };
  }
  return out;
}
