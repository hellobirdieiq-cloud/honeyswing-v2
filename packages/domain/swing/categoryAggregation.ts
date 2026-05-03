import type { ScoringResult, ScoringBreakdownEntry } from './scoring';
import { isMeasured } from './scoring';
import type { GatedMetricKey } from './visibilityWeighting';

/**
 * SCR-0b-2: Per-metric confidence map argument shape. Mirrors
 * AnalysisResult.metricConfidences verbatim (analysisPipeline.ts:65-69) but
 * declared locally to avoid a circular import (analysisPipeline imports
 * aggregateSwing from this module).
 */
type MetricConfidenceMap = Partial<Record<GatedMetricKey | 'tempo', {
  visibilityConfidence: number;
  cameraConfidence: number;
}>>;

/**
 * V85.3 Layer 2 canonical category names. HC14: do NOT add `swingPlane` or
 * any other name. The set is locked to exactly these 4.
 */
export type CategoryName = 'posture' | 'balance' | 'tempo' | 'rotationControl';

export type CategoryScore = {
  score: number;
  contributingMetrics: string[];
  totalWeight: number;
};

export type AggregateResult = {
  categories: Record<CategoryName, CategoryScore | null>;
};

/**
 * V85.3 Part 2 Layer 2 sub-metric mapping. HC13: posture v0 is `['spineAngle']`
 * only — knees / elbows / shoulderTilt are diagnostic-only per V85.3 PART 9
 * and never enter scoring categories. Balance + rotationControl are `[]` until
 * SCR-0b-3 (head stability), SCR-0b-4 (hip hinge), SCR-0b-5 (pelvis sway)
 * land their composite metrics.
 */
const CATEGORY_METRICS: Record<CategoryName, ReadonlyArray<string>> = {
  posture: ['spineAngle'],
  balance: [],
  tempo: ['tempo'],
  rotationControl: [],
};

/**
 * Aggregate a ScoringResult into V85.3 Layer 2 categories, weighting each
 * contributing metric by its per-metric confidence (OD-2A: `Math.min(vis,cam)`).
 *
 * Contract:
 * - HC6 phantom-signal filter: only entries with `dataQuality === 'measured'`
 *   contribute. State-3 missing entries are dropped before confidence lookup.
 * - HC13 diagnostic-vs-scoring boundary: only metrics in CATEGORY_METRICS
 *   contribute to a category; diagnostic metrics in breakdown are ignored.
 * - HC14 category-name lock: returns exactly 4 keys.
 * - Internal Trap 1: confidence map is looked up by `entry.metric`, never
 *   iterated directly. Missing key or `metricConfidences === undefined/{}`
 *   falls back to weight 1 per OD-2A.
 * - Zero-totalWeight degenerate case (e.g. single contributor with vis=0
 *   cam=0): returns `null` for that category rather than dividing by zero.
 *   Documented per Rule 45 compiler-is-oracle (operator-locked choice from
 *   plan F8).
 * - Pure function; no mutation, no memoization, no retry (Q11).
 */
export function aggregateSwing(
  scoring: ScoringResult,
  metricConfidences?: MetricConfidenceMap,
): AggregateResult {
  const measuredEntries = scoring.breakdown.filter(isMeasured);
  const categories = {} as Record<CategoryName, CategoryScore | null>;

  for (const categoryName of Object.keys(CATEGORY_METRICS) as CategoryName[]) {
    const subMetrics = CATEGORY_METRICS[categoryName];

    if (subMetrics.length === 0) {
      categories[categoryName] = null;
      continue;
    }

    const contributors: ScoringBreakdownEntry[] = measuredEntries.filter(
      (entry) => subMetrics.includes(entry.metric),
    );

    if (contributors.length === 0) {
      categories[categoryName] = null;
      continue;
    }

    let totalWeight = 0;
    let totalWeightedScore = 0;
    const contributingMetrics: string[] = [];

    for (const entry of contributors) {
      const c = metricConfidences?.[entry.metric as GatedMetricKey | 'tempo'];
      const weight = c ? Math.min(c.visibilityConfidence, c.cameraConfidence) : 1;
      totalWeight += weight;
      totalWeightedScore += entry.score * weight;
      contributingMetrics.push(entry.metric);
    }

    if (totalWeight === 0) {
      categories[categoryName] = null;
      continue;
    }

    categories[categoryName] = {
      score: totalWeightedScore / totalWeight,
      contributingMetrics,
      totalWeight,
    };
  }

  return { categories };
}
