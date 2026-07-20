/**
 * scrubberBands.ts — pure band math for the label-mode precision scrubber
 * (FIX 6c). Extracted from LabelScrubber so the continuity-critical pieces
 * (hysteresis band resolution, relative whole-frame mapping, re-anchor
 * zero-jump) are testable without a gesture runtime.
 *
 * Precision model: a horizontal drag moves the playhead RELATIVE to the frame
 * displayed at touch-down (anchorFrame/anchorX); raising the finger switches
 * sensitivity bands. Every band switch re-anchors at the currently displayed
 * frame + the finger's current X, which is what guarantees a ZERO-frame jump
 * on band entry/exit (targetFrame(anchor, x, x, …) === anchor by identity).
 *
 * All numbers are EXTERNAL-ASSUMPTION tunables (device feel pass owed).
 */

export type ScrubBand = 0 | 1 | 2;

/** Horizontal pt of finger travel per FRAME, by band (higher = finer). */
export const BAND_PT_PER_FRAME: Record<ScrubBand, number> = { 0: 1, 1: 4, 2: 8 };

/**
 * Upward-distance thresholds (pt): enter band N+1 at/above BAND_ENTER_PT[N],
 * fall back below BAND_LEAVE_PT[N]. The enter/leave gap is the ~4pt
 * hysteresis around the nominal 24/64pt edges — it kills haptic + re-anchor
 * chatter when the finger hovers at a boundary.
 */
export const BAND_ENTER_PT: readonly [number, number] = [28, 68];
export const BAND_LEAVE_PT: readonly [number, number] = [20, 60];

export function resolveBand(current: ScrubBand, upPt: number): ScrubBand {
  let band: number = current;
  while (band < 2 && upPt >= BAND_ENTER_PT[band]) band++;
  while (band > 0 && upPt < BAND_LEAVE_PT[band - 1]) band--;
  return band as ScrubBand;
}

export function clampFrame(frame: number, frameCount: number): number {
  return Math.min(Math.max(0, frame), Math.max(0, frameCount - 1));
}

/** Whole-frame target for the current finger X relative to the gesture's
 *  anchor. round() (not trunc) so ±half-sensitivity snaps symmetrically. */
export function targetFrame(
  anchorFrame: number,
  anchorX: number,
  x: number,
  band: ScrubBand,
  frameCount: number,
): number {
  return clampFrame(
    anchorFrame + Math.round((x - anchorX) / BAND_PT_PER_FRAME[band]),
    frameCount,
  );
}

/** Absolute mapping for a TAP on the track (fraction of track width). */
export function frameAtFraction(fraction: number, frameCount: number): number {
  const f = Math.min(Math.max(0, fraction), 1);
  return clampFrame(Math.round(f * (frameCount - 1)), frameCount);
}
