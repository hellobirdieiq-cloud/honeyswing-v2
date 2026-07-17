/**
 * computePuttingTempo.ts — tempo from the three putting events
 * (Putting spec §4.5).
 *
 * backswing = TOP − TAKEAWAY frames, downswing = IMPACT − TOP frames,
 * ratio = backswing/downswing (2dp). Emitted on the 120fps analysis grid
 * (step 8.333ms). Any missing event or non-positive segment → null — a
 * withheld tempo is null, never 0 (app-wide convention).
 */

import type { PuttingTempoResult } from './types';

export function computePuttingTempo(
  takeawayFrame: number | null,
  topFrame: number | null,
  impactFrame: number | null,
  stepMs: number,
): PuttingTempoResult | null {
  if (takeawayFrame == null || topFrame == null || impactFrame == null) return null;
  const backswingFrames = topFrame - takeawayFrame;
  const downswingFrames = impactFrame - topFrame;
  if (backswingFrames <= 0 || downswingFrames <= 0) return null;
  return {
    backswingFrames,
    downswingFrames,
    backswingMs: Math.round(backswingFrames * stepMs),
    downswingMs: Math.round(downswingFrames * stepMs),
    ratio: Math.round((backswingFrames / downswingFrames) * 100) / 100,
  };
}
