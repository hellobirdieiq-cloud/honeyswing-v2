/**
 * shaftDisplay.ts — the Putting spec §4.6 overlay draw rule (Phase B).
 *
 * Draw line pivot → pivot + unit(angle) × SHAFT_LEN — the TUBE END, i.e. the
 * same convention the v8 DATA golden series stores in hx/hy. Deliberately NOT
 * shaftLen + headExt: the +headExt reach is refine-only (the ellipse center
 * for refinePutterHead), never the drawn line.
 *
 * Output is ANALYSIS px @480w, same space as SmoothedShaftFrame; scaling to
 * display pixels is the renderer's job (uniform ×(displayWidth/analysisWidth)
 * — analysis height shares the video aspect ratio).
 */

import type { SmoothedShaftFrame } from './types';

export type ShaftSegment = { x0: number; y0: number; x1: number; y1: number };

export function shaftDisplaySegment(
  frame: SmoothedShaftFrame,
  shaftLenPx: number,
): ShaftSegment {
  const r = (frame.ang * Math.PI) / 180;
  return {
    x0: frame.px,
    y0: frame.py,
    x1: frame.px + Math.sin(r) * shaftLenPx,
    y1: frame.py + Math.cos(r) * shaftLenPx,
  };
}
