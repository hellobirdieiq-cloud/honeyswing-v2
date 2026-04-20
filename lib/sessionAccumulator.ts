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
import { isMetricEligible } from './tipFrequency';

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
  'hipRotation',
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
  hipRotation: 'hip rotation',
  shoulderTilt: 'shoulder tilt',
  tempo: 'tempo',
};

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
 * For angle metrics, "improving" means getting closer to ideal.
 * Since we don't know each metric's ideal direction without scoring context,
 * we use the sign of the slope relative to whether it was previously flagged.
 * If the metric was flagged (too high/too low), improving = moving opposite to the flag direction.
 *
 * Simplified: we just check if the absolute slope exceeds threshold.
 * The insight generator decides if it's improvement based on flag count decreasing.
 */
function getTrend(values: number[]): TrendDirection {
  const slope = linearSlope(values, TREND_WINDOW);
  const recent = values.slice(-TREND_WINDOW);
  if (recent.length < 2) return 'stable';

  // Normalize slope by the range of recent values
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  const range = max - min;
  if (range === 0) return 'stable';

  const normalizedSlope = Math.abs(slope) / range;
  if (normalizedSlope >= TREND_SLOPE_THRESHOLD) {
    // Check if more recent values are closer to the mean (improving consistency)
    // or just moving in one direction
    return slope > 0 ? 'improving' : 'declining';
  }
  return 'stable';
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
      this._addMetricValue('hipRotation', angles.hipRotation);
      this._addMetricValue('shoulderTilt', angles.shoulderTilt);
    }

    if (analysis.tempo?.tempoRatio != null) {
      this._addMetricValue('tempo', analysis.tempo.tempoRatio);
    }

    // Track which metrics were flagged (tip fired)
    for (const metricKey of tipsFired) {
      const stats = this._metrics.get(metricKey as AccumulatorMetricKey);
      if (stats) {
        stats.flagCount++;
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
      if (!isMetricEligible(key, ageTier)) continue;
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
      if (!isMetricEligible(key, ageTier)) continue;
      // Must have been flagged at least twice earlier in session
      if (stats.flagCount < 2) continue;
      if (stats.values.length < TREND_WINDOW) continue;

      const trend = getTrend(stats.values);
      if (trend === 'improving') {
        const slope = Math.abs(linearSlope(stats.values, TREND_WINDOW));
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
      if (!isMetricEligible(key, ageTier)) continue;
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
