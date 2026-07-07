/**
 * Coaching tip domain logic extracted from result.tsx.
 * Pure data transformations — no React, no hooks, no store access.
 */

import type { ScoringBreakdownEntry } from '../packages/domain/swing/scoring';
import type { RawCoachingTip } from '@/packages/domain/swing/tipFrequency';

// ---------------------------------------------------------------------------
// Tip adapter: scoring breakdown → RawCoachingTip[]
// ---------------------------------------------------------------------------

export const TIP_SCORE_THRESHOLD = 80;

/** Mapping from scoring metric names to tipFrequency metricKeys */
const METRIC_KEY_MAP: Record<string, string> = {
  spineAngle: 'spineAngle',
  leftElbowAngle: 'elbow',
  rightElbowAngle: 'elbow',
  leftKneeAngle: 'kneeFlex',
  rightKneeAngle: 'kneeFlex',
  shoulderTilt: 'shoulderTilt',
  tempo: 'tempo',
};


/**
 * Convert scoring breakdown entries into RawCoachingTip[].
 * Pre-filters to score < TIP_SCORE_THRESHOLD. Deduplicates mapped keys
 * (e.g. leftElbowAngle + rightElbowAngle both map to 'elbow') by keeping
 * the worse-scoring entry.
 */
export function buildRawTips(breakdown: ScoringBreakdownEntry[]): RawCoachingTip[] {
  // Collect worst score per mapped metricKey
  const seen = new Map<string, number>();

  for (const entry of breakdown) {
    if (entry.dataQuality === 'missing') continue;
    if (entry.score >= TIP_SCORE_THRESHOLD) continue;
    const mappedKey = METRIC_KEY_MAP[entry.metric];
    if (!mappedKey) continue;

    const existing = seen.get(mappedKey);
    if (existing === undefined || entry.score < existing) {
      seen.set(mappedKey, entry.score);
    }
  }

  return Array.from(seen.keys()).map((metricKey) => ({ metricKey }));
}

/**
 * Deduped worst score per mapped metricKey — same METRIC_KEY_MAP mapping as
 * buildRawTips but WITHOUT the tip-score threshold (positive reinforcement
 * needs good scores too). ARRAY ORDER IS LOAD-BEARING: first-seen mapped-key
 * order (Map insertion) — positiveReinforcementEngine picks the first improved
 * metric by array order when several improve at once.
 */
export function dedupeWorstMetricScores(
  breakdown: ScoringBreakdownEntry[],
): { metricKey: string; score: number }[] {
  const worstByKey = new Map<string, number>();
  for (const entry of breakdown) {
    if (entry.dataQuality === 'missing') continue;  // SCR-0b-1: don't pull "0" worst from missing
    const mappedKey = METRIC_KEY_MAP[entry.metric];
    if (!mappedKey) continue;
    const existing = worstByKey.get(mappedKey);
    if (existing === undefined || entry.score < existing) {
      worstByKey.set(mappedKey, entry.score);
    }
  }
  return Array.from(worstByKey.entries()).map(([metricKey, score]) => ({ metricKey, score }));
}
