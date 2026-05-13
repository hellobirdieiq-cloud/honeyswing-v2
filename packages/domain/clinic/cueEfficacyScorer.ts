import type { CueBlockRecord } from './CueBlock';
import type { SwingRecord } from './SwingRecord';
import type { ClinicMetricKey, CueFamily } from './enums';
import type { CueEfficacyScore } from './clinicTypes';
import { METRIC_DEFINITIONS } from '@/packages/domain/swing/metricDefinitions';

export type { CueEfficacyScore } from './clinicTypes';

// EXTERNAL_ASSUMPTION: cue→metric mapping locked 2026-05-13; revisit at SCR-CAL.
export const CUE_FAMILY_TO_METRIC: Record<CueFamily, ClinicMetricKey | null> = {
  tempo: 'tempoRatio',
  'spine-stability': 'spineDrift',
  'hip-rotation': 'hipSpreadDelta',
  'shoulder-turn': 'shoulderTilt',
  'wrist-set': null,
  'weight-shift': null,
  'follow-through': null,
  setup: null,
  other: null,
};

// EXTERNAL_ASSUMPTION: biomechanical-ideal fallback used when personal band lacks samples.
//   Angle ideals reuse METRIC_DEFINITIONS where present; tempoRatio mirrors scoring.ts:84;
//   spineDrift/hipSpreadDelta default to 0 (no drift / no width change).
export const CLINIC_METRIC_IDEALS: Record<ClinicMetricKey, number> = {
  spineAngle: METRIC_DEFINITIONS.spineAngle.ideal,
  spineDrift: 0,
  tempoRatio: 3.475,
  hipSpreadDelta: 0,
  leftElbowAngle: METRIC_DEFINITIONS.leftElbowAngle.ideal,
  rightElbowAngle: METRIC_DEFINITIONS.rightElbowAngle.ideal,
  leftKneeAngle: METRIC_DEFINITIONS.leftKneeAngle.ideal,
  rightKneeAngle: METRIC_DEFINITIONS.rightKneeAngle.ideal,
  shoulderTilt: METRIC_DEFINITIONS.shoulderTilt.ideal,
};

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function meanOfMetric(
  swings: SwingRecord[],
  metric: ClinicMetricKey,
): number {
  const values = swings
    .map((s) => s.metrics[metric])
    .filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

// Scores how strongly a cue shifted a metric toward the target across the 5 post-cue swings (0..1).
export function scoreAccommodation(
  baselineSwings: SwingRecord[],
  postCueSwings: SwingRecord[],
  metric: ClinicMetricKey,
  targetValue: number,
): number {
  const baselineMean = meanOfMetric(baselineSwings, metric);
  const postCueMean = meanOfMetric(postCueSwings, metric);
  const gap = targetValue - baselineMean;
  if (gap === 0) return 0;
  return clamp01((postCueMean - baselineMean) / gap);
}

// Scores how well the post-cue shift persisted into the retention probe swings (0..1, or null when retention absent).
export function scoreRetention(
  postCueSwings: SwingRecord[],
  retentionSwings: SwingRecord[],
  metric: ClinicMetricKey,
): number | null {
  if (retentionSwings.length === 0) return null;
  const postCueMean = meanOfMetric(postCueSwings, metric);
  const retentionMean = meanOfMetric(retentionSwings, metric);
  const denom = Math.max(Math.abs(postCueMean), 1e-6);
  return clamp01(1 - Math.abs(retentionMean - postCueMean) / denom);
}

// Combines accommodation + retention into a per-cue-block efficacy summary.
export function scoreCueBlock(
  block: CueBlockRecord,
  baselineSwings: SwingRecord[],
  postCueSwings: SwingRecord[],
  retentionSwings: SwingRecord[],
  metric: ClinicMetricKey,
  targetValue: number,
): CueEfficacyScore {
  const baselineAverage = meanOfMetric(baselineSwings, metric);
  const postCueAverage = meanOfMetric(postCueSwings, metric);
  const retentionAverage =
    retentionSwings.length === 0 ? null : meanOfMetric(retentionSwings, metric);
  const accommodation = scoreAccommodation(
    baselineSwings,
    postCueSwings,
    metric,
    targetValue,
  );
  const retention = scoreRetention(postCueSwings, retentionSwings, metric);
  const metricMovement = postCueAverage - baselineAverage;

  return {
    cueBlockId: block.id,
    metric,
    baselineAverage,
    postCueAverage,
    retentionAverage,
    accommodation,
    retention,
    metricMovement,
  };
}
