/**
 * runPuttingDetectors.ts — Phase A1 orchestrator (Putting spec §4.1–4.5).
 *
 * Sentinel filter → IMPACT (ball launch) → TOP (hand-x zero-crossing + lag)
 * → coarse TAKEAWAY (pose plateau) → tempo. Pure series math over data the
 * native putting tracker already exports; the return object is embedded
 * verbatim in the dev-harness export JSON as `putting_detectors`.
 *
 * All detector constants are EXTERNAL ASSUMPTIONS at n=2 clips — the fine
 * (geometry-head) takeaway stage is Phase A2, triggered by the device gate.
 */

import type { BallPoint, PosePriorSample, PuttingDetectorsResult } from './types';
import { filterSentinelPriors } from './sentinelFilter';
import { detectImpact } from './detectImpact';
import { detectTop } from './detectTop';
import { detectCoarseTakeaway } from './detectCoarseTakeaway';
import { computePuttingTempo } from './computePuttingTempo';

export function runPuttingDetectors(input: {
  posePriors: readonly PosePriorSample[];
  balls: readonly BallPoint[];
  stepMs: number;
}): PuttingDetectorsResult {
  const warnings: string[] = [];
  const { filtered, droppedCount } = filterSentinelPriors(input.posePriors);

  const { impactFrame, restPos } = detectImpact(input.balls);
  if (impactFrame == null) warnings.push('no_impact_launch');

  const { topFrame, crossingFrame, backswingSign } = detectTop(filtered, impactFrame);
  if (impactFrame != null && backswingSign == null) warnings.push('no_backswing_sign');
  if (impactFrame != null && backswingSign != null && topFrame == null)
    warnings.push('no_velocity_crossing');

  const { takeawayFrame, plateau } = detectCoarseTakeaway(filtered, topFrame);
  if (topFrame != null && takeawayFrame == null) warnings.push('no_address_plateau');

  const tempo = computePuttingTempo(takeawayFrame, topFrame, impactFrame, input.stepMs);
  if (tempo == null) warnings.push('tempo_withheld');

  return {
    impactFrame,
    topFrame,
    takeawayFrame,
    tempo,
    intermediates: {
      sentinel_filtered_count: droppedCount,
      rest_pos: restPos,
      backswing_sign: backswingSign,
      crossing_frame: crossingFrame,
      plateau,
      warnings,
    },
  };
}
