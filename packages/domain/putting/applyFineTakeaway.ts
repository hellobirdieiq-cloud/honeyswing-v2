/**
 * applyFineTakeaway.ts — Phase A2 stage-2 combiner.
 *
 * Takes the coarse A1 detector result plus the refined-head points from the
 * native refinePutterHead pass; when the ramp-foot fine stage finds an onset,
 * it REPLACES takeawayFrame (coarse preserved in intermediates.fine) and tempo
 * is recomputed. Any fine failure leaves the coarse result standing with a
 * specific warning — never a crash, never a 0.
 */

import type {
  FineTakeawayIntermediates,
  PuttingDetectorsResult,
  RefinedHeadPoint,
} from './types';
import { buildDisplacement, computeRefineWindow, findOnset } from './detectFineTakeaway';
import { computePuttingTempo } from './computePuttingTempo';

export function applyFineTakeaway(input: {
  base: PuttingDetectorsResult;
  /** null = refine pass skipped (no shaftLen / no anchors / no window). */
  refinedPoints: readonly RefinedHeadPoint[] | null;
  headExtPx: number | null;
  anchorCount: number | null;
  stepMs: number;
  /** Warning explaining WHY refinedPoints is null (e.g. 'no_shaft_len'). */
  skipReason?: string;
}): PuttingDetectorsResult {
  const { base, refinedPoints, headExtPx, anchorCount, stepMs, skipReason } = input;
  const coarse = base.takeawayFrame;
  const top = base.topFrame;

  const warnings = [...base.intermediates.warnings];
  const fineBase = {
    coarse_takeaway: coarse,
    head_ext_px: headExtPx,
    anchor_count: anchorCount,
  };

  const fail = (
    warning: string,
    extra?: Partial<FineTakeawayIntermediates>,
  ): PuttingDetectorsResult => {
    warnings.push(warning);
    return {
      ...base,
      intermediates: {
        ...base.intermediates,
        warnings,
        fine: {
          ...fineBase,
          onset: null,
          hard_cross: null,
          sigma_px: null,
          med_rest_px: null,
          threshold_px: null,
          ramp_floor_px: null,
          refine_window: null,
          ref_window: null,
          disp_by_frame: null,
          coasted_count: refinedPoints ? refinedPoints.filter((p) => p.coasted).length : null,
          ...extra,
        },
      },
    };
  };

  if (coarse == null || top == null) return fail('fine_skipped_no_coarse');
  if (refinedPoints == null) return fail(skipReason ?? 'fine_skipped_no_points');
  if (refinedPoints.length === 0) return fail('fine_skipped_empty_window');

  const window = computeRefineWindow(coarse, top);
  const refWindow = { lo: coarse - 20, hi: coarse - 6 };
  const series = buildDisplacement(refinedPoints, coarse);
  if (series == null) {
    return fail('fine_no_ref_points', { refine_window: window, ref_window: refWindow });
  }

  const { onset, hardCross, thresholdPx, rampFloorPx } = findOnset(series, coarse);
  const dispByFrame: Record<string, number> = {};
  for (const [f, d] of series.dispByFrame) dispByFrame[String(f)] = Math.round(d * 100) / 100;

  const fine = {
    ...fineBase,
    onset,
    hard_cross: hardCross,
    sigma_px: Math.round(series.sigma * 1000) / 1000,
    med_rest_px: Math.round(series.medRest * 1000) / 1000,
    threshold_px: Math.round(thresholdPx * 1000) / 1000,
    ramp_floor_px: Math.round(rampFloorPx * 1000) / 1000,
    refine_window: window,
    ref_window: refWindow,
    disp_by_frame: dispByFrame,
    coasted_count: refinedPoints.filter((p) => p.coasted).length,
  };

  if (onset == null) {
    warnings.push('fine_no_hard_cross');
    return { ...base, intermediates: { ...base.intermediates, warnings, fine } };
  }

  const tempo = computePuttingTempo(onset, top, base.impactFrame, stepMs);
  if (tempo == null && base.tempo != null) warnings.push('fine_tempo_withheld');
  return {
    ...base,
    takeawayFrame: onset,
    tempo,
    intermediates: { ...base.intermediates, warnings, fine },
  };
}
