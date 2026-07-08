/**
 * sessionAccumulator.ts — Task 14: Historical Swing Averaging
 *
 * In-memory session accumulator that tracks per-metric running stats
 * across consecutive swings. After SESSION_INSIGHT_MIN_SWINGS, produces
 * session-level insights (focus suggestion, improvement notice, consistency praise).
 *
 * Session resets when app backgrounds >5 minutes or is killed.
 * NOT persisted to AsyncStorage or Supabase.
 */

import type { AnalysisResult } from '../packages/domain/swing/analysisPipeline';
import type { GolfAngles } from '../packages/domain/swing/angles';
import { generateFocusInsight, generateImprovementInsight, generateConsistencyInsight } from './sessionInsights';
import { getCachedAgeTier, type AgeTier } from './ageTier';
import { isMetricEligible } from '@/packages/domain/swing/tipFrequency';
import { METRIC_DEFINITIONS } from '@/packages/domain/swing/metricDefinitions';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_INSIGHT_MIN_SWINGS = 10;

/** Minimum confidence score to contribute metric values (not just count) */
const MIN_CONFIDENCE_FOR_METRICS = 0.50;

/** Flag rate threshold for focus suggestion */
const FOCUS_FLAG_RATE = 0.4;
const FOCUS_MIN_FLAGS = 4;

/** Coefficient of variation threshold for consistency */
const CONSISTENCY_CV_MAX = 0.15;

/** Slope threshold: >=3% of metric range per swing = improving/declining */
const TREND_SLOPE_THRESHOLD = 0.03;

/** Number of recent swings to use for trend calculation */
const TREND_WINDOW = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricStats {
  values: number[];
  flagCount: number;
  sum: number;
  sumSq: number;
}

export type InsightType = 'focus' | 'improvement' | 'consistency';

export interface SessionInsight {
  type: InsightType;
  metricKey: string;
  message: string;
}

export type TrendDirection = 'improving' | 'declining' | 'stable';

// ---------------------------------------------------------------------------
// Metric definitions — direction toward ideal
// ---------------------------------------------------------------------------

/** Metrics where lower deviation = better. Most angle metrics target a specific value,
 *  so we track the raw value and compute trend relative to ideal direction. */
const METRIC_KEYS = [
  'spineAngle',
  'leftElbowAngle',
  'rightElbowAngle',
  'leftKneeAngle',
  'rightKneeAngle',
  'hipSpreadDelta',
  'shoulderTilt',
  'tempo',
] as const;

export type AccumulatorMetricKey = (typeof METRIC_KEYS)[number];

/** Display names for metrics */
const METRIC_DISPLAY_NAMES: Record<AccumulatorMetricKey, string> = {
  spineAngle: 'spine angle',
  leftElbowAngle: 'lead arm',
  rightElbowAngle: 'trail arm',
  leftKneeAngle: 'lead knee',
  rightKneeAngle: 'trail knee',
  hipSpreadDelta: 'hip rotation',
  shoulderTilt: 'shoulder tilt',
  tempo: 'tempo',
};

/** Collapsed System-B tip keys (coachingTips METRIC_KEY_MAP) → accumulator keys.
 *  The live caller (result.tsx) fires the COLLAPSED keys; 'elbow'/'kneeFlex'
 *  mark both sides because the collapse kept only the worse-scoring side and
 *  side identity is unrecoverable here. Keys not in this map (spineAngle,
 *  shoulderTilt, tempo, and test-supplied lateralized names) fall through as-is. */
const FLAG_KEY_TRANSLATION: Record<string, readonly AccumulatorMetricKey[]> = {
  elbow: ['leftElbowAngle', 'rightElbowAngle'],
  kneeFlex: ['leftKneeAngle', 'rightKneeAngle'],
};

/** Ideal values for direction-aware trends. Angle ideals come from
 *  METRIC_DEFINITIONS; tempo's is the center of the 2.5–3.5 "good" ratio band
 *  (tempoAnalysis). hipSpreadDelta has no defined ideal anywhere — its trend
 *  keeps the raw-slope fallback in getTrend. */
const METRIC_IDEALS: Partial<Record<AccumulatorMetricKey, number>> = {
  spineAngle: METRIC_DEFINITIONS.spineAngle.ideal,
  leftElbowAngle: METRIC_DEFINITIONS.leftElbowAngle.ideal,
  rightElbowAngle: METRIC_DEFINITIONS.rightElbowAngle.ideal,
  leftKneeAngle: METRIC_DEFINITIONS.leftKneeAngle.ideal,
  rightKneeAngle: METRIC_DEFINITIONS.rightKneeAngle.ideal,
  shoulderTilt: METRIC_DEFINITIONS.shoulderTilt.ideal,
  tempo: 3.0,
};

/** Insight eligibility. isMetricEligible is a System-B CUE predicate — it
 *  hard-suppresses 'tempo' only because tempo has no cue() text, which is
 *  irrelevant here: session insights render their own generic templates
 *  (sessionInsights.ts). Age-tier limits still apply to everything else. */
function isInsightEligible(metricKey: AccumulatorMetricKey, ageTier: AgeTier): boolean {
  if (metricKey === 'tempo') return true;
  return isMetricEligible(metricKey, ageTier);
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

function mean(stats: MetricStats): number {
  return stats.values.length > 0 ? stats.sum / stats.values.length : 0;
}

function stddev(stats: MetricStats): number {
  const n = stats.values.length;
  if (n < 2) return 0;
  const avg = stats.sum / n;
  const variance = stats.sumSq / n - avg * avg;
  return Math.sqrt(Math.max(0, variance));
}

function coefficientOfVariation(stats: MetricStats): number {
  const m = mean(stats);
  if (m === 0) return 0;
  return stddev(stats) / Math.abs(m);
}

/**
 * Compute linear slope of the last N values.
 * Returns slope per swing (positive = increasing values over time).
 */
function linearSlope(values: number[], window: number): number {
  const recent = values.slice(-window);
  const n = recent.length;
  if (n < 2) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += recent[i];
    sumXY += i * recent[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Determine trend direction based on slope.
 * With a known ideal, the trend is computed on the DEVIATION |value − ideal|:
 * shrinking deviation = improving, growing = declining — a spine angle
 * drifting further past ideal must not read as "getting better". Metrics
 * without a defined ideal (hipSpreadDelta) fall back to raw slope direction.
 */
function getTrend(values: number[], ideal: number | null): TrendDirection {
  const series = ideal != null ? values.map((v) => Math.abs(v - ideal)) : values;
  const slope = linearSlope(series, TREND_WINDOW);
  const recent = series.slice(-TREND_WINDOW);
  if (recent.length < 2) return 'stable';

  // Normalize slope by the range of recent values
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  const range = max - min;
  if (range === 0) return 'stable';

  const normalizedSlope = Math.abs(slope) / range;
  if (normalizedSlope < TREND_SLOPE_THRESHOLD) return 'stable';
  if (ideal != null) return slope < 0 ? 'improving' : 'declining';
  return slope > 0 ? 'improving' : 'declining';
}

// ---------------------------------------------------------------------------
// Session Accumulator
// ---------------------------------------------------------------------------

class SessionAccumulatorImpl {
  private _swingCount = 0;
  private _metrics: Map<AccumulatorMetricKey, MetricStats> = new Map();

  get swingCount(): number {
    return this._swingCount;
  }

  /**
   * Record a swing's metrics. Always increments swing count.
   * Only contributes metric values if confidence score >= threshold.
   */
  addSwing(analysis: AnalysisResult, tipsFired: string[]): void {
    this._swingCount++;

    // Confidence gate: low-confidence swings count but don't pollute stats
    if ((analysis.swingConfidence?.overall ?? 0) < MIN_CONFIDENCE_FOR_METRICS) return;

    const angles = analysis.angles;
    if (angles) {
      this._addMetricValue('spineAngle', angles.spineAngle);
      this._addMetricValue('leftElbowAngle', angles.leftElbowAngle);
      this._addMetricValue('rightElbowAngle', angles.rightElbowAngle);
      this._addMetricValue('leftKneeAngle', angles.leftKneeAngle);
      this._addMetricValue('rightKneeAngle', angles.rightKneeAngle);
      this._addMetricValue('hipSpreadDelta', angles.hipSpreadDelta);
      this._addMetricValue('shoulderTilt', angles.shoulderTilt);
    }

    if (analysis.tempo?.tempoRatio != null) {
      this._addMetricValue('tempo', analysis.tempo.tempoRatio);
    }

    // Track which metrics were flagged (tip fired). Translate the caller's
    // collapsed System-B keys onto the lateralized accumulator keys — without
    // this, elbow/knee flagCounts stay 0 forever and the consistency insight
    // praises the exact metric being corrected every swing.
    for (const metricKey of tipsFired) {
      const targets = FLAG_KEY_TRANSLATION[metricKey] ?? [metricKey as AccumulatorMetricKey];
      for (const key of targets) {
        const stats = this._metrics.get(key);
        if (stats) {
          stats.flagCount++;
        }
      }
    }
  }

  /**
   * Get the highest-priority session insight, if any qualifies.
   */
  getInsight(): SessionInsight | null {
    if (this._swingCount < SESSION_INSIGHT_MIN_SWINGS) return null;

    const ageTier = getCachedAgeTier();

    // Priority 1: Focus suggestion
    const focus = this._getFocusInsight(ageTier);
    if (focus) return focus;

    // Priority 2: Improvement notice
    const improvement = this._getImprovementInsight(ageTier);
    if (improvement) return improvement;

    // Priority 3: Consistency praise
    const consistency = this._getConsistencyInsight(ageTier);
    if (consistency) return consistency;

    return null;
  }

  // Doc-comment at top of file claims reset happens "on AppState background
  // >5 min", but no such listener exists in the codebase today; the only
  // current callers are tests.
  reset(): void {
    this._swingCount = 0;
    this._metrics.clear();
  }

  /** Expose stats for testing */
  getMetricStats(key: AccumulatorMetricKey): MetricStats | undefined {
    return this._metrics.get(key);
  }

  // ---- Private helpers ----

  private _addMetricValue(key: AccumulatorMetricKey, value: number | null | undefined): void {
    if (value == null) return;

    let stats = this._metrics.get(key);
    if (!stats) {
      stats = { values: [], flagCount: 0, sum: 0, sumSq: 0 };
      this._metrics.set(key, stats);
    }
    stats.values.push(value);
    stats.sum += value;
    stats.sumSq += value * value;
  }

  private _getFocusInsight(ageTier: AgeTier): SessionInsight | null {
    let best: { key: AccumulatorMetricKey; flagCount: number } | null = null;

    for (const [key, stats] of this._metrics) {
      if (!isInsightEligible(key, ageTier)) continue;
      const flagRate = stats.flagCount / this._swingCount;
      if (flagRate >= FOCUS_FLAG_RATE && stats.flagCount >= FOCUS_MIN_FLAGS) {
        if (!best || stats.flagCount > best.flagCount) {
          best = { key, flagCount: stats.flagCount };
        }
      }
    }

    if (!best) return null;
    const displayName = METRIC_DISPLAY_NAMES[best.key];
    return {
      type: 'focus',
      metricKey: best.key,
      message: generateFocusInsight(displayName, best.flagCount),
    };
  }

  private _getImprovementInsight(ageTier: AgeTier): SessionInsight | null {
    let best: { key: AccumulatorMetricKey; slope: number } | null = null;

    for (const [key, stats] of this._metrics) {
      if (!isInsightEligible(key, ageTier)) continue;
      // Must have been flagged at least twice earlier in session
      if (stats.flagCount < 2) continue;
      if (stats.values.length < TREND_WINDOW) continue;

      const ideal = METRIC_IDEALS[key] ?? null;
      const trend = getTrend(stats.values, ideal);
      if (trend === 'improving') {
        // Rank on the same series the trend was judged on (deviation when an
        // ideal exists) so "most improving" means fastest approach to ideal.
        const series = ideal != null ? stats.values.map((v) => Math.abs(v - ideal)) : stats.values;
        const slope = Math.abs(linearSlope(series, TREND_WINDOW));
        if (!best || slope > best.slope) {
          best = { key, slope };
        }
      }
    }

    if (!best) return null;
    const displayName = METRIC_DISPLAY_NAMES[best.key];
    return {
      type: 'improvement',
      metricKey: best.key,
      message: generateImprovementInsight(displayName),
    };
  }

  private _getConsistencyInsight(ageTier: AgeTier): SessionInsight | null {
    let best: { key: AccumulatorMetricKey; cv: number } | null = null;

    for (const [key, stats] of this._metrics) {
      if (!isInsightEligible(key, ageTier)) continue;
      // Must never have been flagged
      if (stats.flagCount > 0) continue;
      if (stats.values.length < 3) continue;

      const cv = coefficientOfVariation(stats);
      if (cv < CONSISTENCY_CV_MAX) {
        if (!best || cv < best.cv) {
          best = { key, cv };
        }
      }
    }

    if (!best) return null;
    const displayName = METRIC_DISPLAY_NAMES[best.key];
    const count = this._metrics.get(best.key)!.values.length;
    return {
      type: 'consistency',
      metricKey: best.key,
      message: generateConsistencyInsight(displayName, count),
    };
  }
}

/** Singleton session accumulator — reset on AppState background >5min */
export const sessionAccumulator = new SessionAccumulatorImpl();
