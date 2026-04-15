/**
 * tipFrequency.ts — Task 7: Tip Frequency Limiter
 *
 * In-memory session tracker that prevents over-coaching kids.
 * Layers on top of Task 6's shouldShowMetric() confidence/angle gate.
 *
 * Architecture:
 *   ┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
 *   │ Analysis pipeline│ ──▶ │ shouldShowMetric  │ ──▶ │ tipFrequency    │
 *   │ (raw tips)       │     │ (Task 6 gate)     │     │ (this module)   │
 *   └─────────────────┘     └──────────────────┘     └─────────────────┘
 *         AnalysisResult       confidence + angle       frequency + tier
 *
 * Display tiers:
 *   - 'full'       First mention in window
 *   - 'shortened'  Repeat under limit
 *   - 'suppressed' At/beyond limit → not shown at all
 *
 * Session lifecycle:
 *   - Resets on AppState 'active' (return from background)
 *   - Uses sliding window (configurable, default 60min) for multi-hour sessions
 *   - State is intentionally NOT persisted — each practice session starts fresh
 *
 * swing_debug integration:
 *   - Call getFrequencyDebugInfo() → additive JSONB field 'tipFrequency'
 */

import { shouldShowMetric as angleGatingShouldShow } from '../packages/domain/swing/angleGating';
export type { SwingConfidence } from '../packages/domain/swing/confidenceScore';
export type { CameraAngleResult } from '../packages/domain/swing/cameraAngle';

import type { SwingConfidence } from '../packages/domain/swing/confidenceScore';
import type { CameraAngleResult } from '../packages/domain/swing/cameraAngle';

/**
 * Task 6 gate function signature.
 * Returns true if a metric is reliable enough to show at this confidence/angle.
 */
export type ShouldShowMetricFn = (
  metric: string,
  swingConfidence: SwingConfidence,
  cameraAngleResult: CameraAngleResult,
) => boolean;

// ---------------------------------------------------------------------------
// Display + age tier types
// ---------------------------------------------------------------------------

export type TipDisplayTier = 'full' | 'shortened' | 'suppressed';

/** Age tier determines which limit table and language variant to use */
export type AgeTier = 'junior' | 'youth' | 'teen' | 'adult';

// ---------------------------------------------------------------------------
// Internal tracking types
// ---------------------------------------------------------------------------

interface MetricTrackingEntry {
  /** Timestamps (ms) of each time this metric's tip was shown */
  shownTimestamps: number[];
}

export interface TipDecision {
  metricKey: string;
  tier: TipDisplayTier;
  /** Times shown within the current sliding window */
  shownInWindow: number;
  /** Effective limit for this metric at current age tier */
  limit: number;
  /** Human-readable reason (for swing_debug / Metro logs) */
  reason: string;
}

export interface SessionStats {
  sessionStartedAt: number;
  windowMinutes: number;
  ageTier: AgeTier;
  swingsProcessed: number;
  tipsShown: number;
  tipsSuppressed: number;
  tipsBlockedByConfidence: number;
  metricCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Coaching tip types
// ---------------------------------------------------------------------------

/**
 * A raw coaching tip from the analysis pipeline.
 * Each tip identifies a metric that passed score filtering + deduplication.
 * Text responsibility belongs to metricDefinitions.ts cue functions.
 */
export interface RawCoachingTip {
  metricKey: string;
}

/**
 * A tip that passed confidence gate, angle gating, and frequency limiter.
 * Carries only the metric key and gating decision — no text.
 * Text responsibility belongs to metricDefinitions.ts cue functions.
 */
export interface ProcessedCoachingTip {
  metricKey: string;
  decision: TipDecision;
}

// ---------------------------------------------------------------------------
// Per-metric limits by age tier (from over-coaching research)
// ---------------------------------------------------------------------------

/**
 * Maximum times each metric's coaching tip can fire per sliding window.
 *
 * Youth (8-12): Most conservative. Complex mechanics suppressed entirely.
 * Teen (13-17): Moderate. More technical feedback allowed.
 * Adult (18+):  Most liberal. Full technical vocabulary.
 *
 * Zero = never show for this age tier.
 */
const METRIC_LIMITS: Record<AgeTier, Record<string, number>> = {
  junior: {
    grip: 15,
    posture: 10,
    tempo: 8,
    balance: 8,
    armExtension: 3,
    shoulderTilt: 2,
    hipRotation: 1,
    kneeFlex: 3,
    elbow: 1,
    spineAngle: 0,
    wristAngle: 0,
    clubfaceAngle: 0,
  },
  youth: {
    grip: 20,
    posture: 15,
    tempo: 12,
    balance: 12,
    armExtension: 5,
    shoulderTilt: 3,
    hipRotation: 2,
    kneeFlex: 4,
    elbow: 2,
    spineAngle: 0,
    wristAngle: 0,
    clubfaceAngle: 0,
  },
  teen: {
    grip: 20,
    posture: 15,
    tempo: 15,
    balance: 15,
    armExtension: 8,
    shoulderTilt: 5,
    hipRotation: 4,
    kneeFlex: 6,
    elbow: 4,
    spineAngle: 3,
    wristAngle: 2,
    clubfaceAngle: 2,
  },
  adult: {
    grip: 20,
    posture: 20,
    tempo: 20,
    balance: 20,
    armExtension: 12,
    shoulderTilt: 8,
    hipRotation: 8,
    kneeFlex: 8,
    elbow: 8,
    spineAngle: 6,
    wristAngle: 4,
    clubfaceAngle: 4,
  },
};

const DEFAULT_LIMIT = 5;

// ---------------------------------------------------------------------------
// Metric eligibility predicate
// ---------------------------------------------------------------------------

/**
 * Single source of truth for whether a metric is eligible to be shown.
 * Returns false for metrics that should never surface at a given age tier.
 */
export function isMetricEligible(metricKey: string, ageTier: AgeTier): boolean {
  // tempo has no System B representation (no cue()), must be suppressed
  if (metricKey === 'tempo') return false;

  const limit = METRIC_LIMITS[ageTier]?.[metricKey];
  // undefined = key not in METRIC_LIMITS (e.g. lateralized names like leftElbowAngle);
  // default eligible to avoid blocking valid metrics with no explicit limit entry.
  if (limit === undefined) return true;
  return limit !== 0;
}

// ---------------------------------------------------------------------------
// Short body fallback map
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// TipFrequencyLimiter class
// ---------------------------------------------------------------------------

class TipFrequencyLimiter {
  private tracker: Map<string, MetricTrackingEntry> = new Map();
  private _sessionStartedAt: number = Date.now();
  private _windowMs: number = 60 * 60 * 1000; // 60 minutes
  private _ageTier: AgeTier = 'youth';
  private _swingsProcessed: number = 0;
  private _tipsShown: number = 0;
  private _tipsSuppressed: number = 0;
  private _tipsBlockedByConfidence: number = 0;

  // ---- Configuration ----

  /** Sliding window size in minutes. Default: 60. */
  setWindowMinutes(minutes: number): void {
    this._windowMs = Math.max(60_000, minutes * 60 * 1000); // minimum 1 min
  }

  /** Age tier for limit table selection. Default: 'youth'. */
  setAgeTier(tier: AgeTier): void {
    this._ageTier = tier;
  }

  get ageTier(): AgeTier {
    return this._ageTier;
  }

  get windowMinutes(): number {
    return this._windowMs / 60_000;
  }

  // ---- Core API (pure read — no side effects) ----

  /**
   * Determine how a tip should be displayed.
   *
   * PURE READ — does not mutate state. Call recordShown() separately
   * after actually rendering the tip.
   *
   * Precondition: shouldShowMetric() already returned true for this metric.
   */
  getTipDecision(metricKey: string): TipDecision {
    const limit = this.getLimitForMetric(metricKey);
    const countInWindow = this.countInCurrentWindow(metricKey);

    if (limit === 0) {
      return {
        metricKey,
        tier: 'suppressed',
        shownInWindow: countInWindow,
        limit,
        reason: `limit=0 for "${metricKey}" at age=${this._ageTier}`,
      };
    }

    if (countInWindow >= limit) {
      return {
        metricKey,
        tier: 'suppressed',
        shownInWindow: countInWindow,
        limit,
        reason: `shown ${countInWindow}x >= limit ${limit} in ${this.windowMinutes}min window`,
      };
    }

    if (countInWindow === 0) {
      return {
        metricKey,
        tier: 'full',
        shownInWindow: 0,
        limit,
        reason: 'first mention this window',
      };
    }

    return {
      metricKey,
      tier: 'shortened',
      shownInWindow: countInWindow,
      limit,
      reason: `repeat #${countInWindow + 1} (limit=${limit})`,
    };
  }

  /** Convenience: just the tier string. */
  getTipDisplayTier(metricKey: string): TipDisplayTier {
    return this.getTipDecision(metricKey).tier;
  }

  // ---- State mutation ----

  /** Record that a tip was shown. Call AFTER rendering it. */
  recordShown(metricKey: string): void {
    let entry = this.tracker.get(metricKey);
    if (!entry) {
      entry = { shownTimestamps: [] };
      this.tracker.set(metricKey, entry);
    }
    entry.shownTimestamps.push(Date.now());
    this._tipsShown++;
  }

  /** Record a frequency suppression (stats only). */
  recordSuppressed(): void {
    this._tipsSuppressed++;
  }

  /** Record a confidence/angle gate block (stats only). */
  recordBlockedByConfidence(): void {
    this._tipsBlockedByConfidence++;
  }

  /** Record a swing was processed (stats only). */
  recordSwingProcessed(): void {
    this._swingsProcessed++;
  }

  // ---- Session management ----

  /**
   * Reset all tracking. Call on:
   * - AppState 'active' (return from background)
   * - Explicit new session start
   */
  reset(): void {
    this.tracker.clear();
    this._sessionStartedAt = Date.now();
    this._swingsProcessed = 0;
    this._tipsShown = 0;
    this._tipsSuppressed = 0;
    this._tipsBlockedByConfidence = 0;
  }

  /** Session statistics for debugging. */
  getSessionStats(): SessionStats {
    const metricCounts: Record<string, number> = {};
    for (const [key] of this.tracker) {
      metricCounts[key] = this.countInCurrentWindow(key);
    }
    return {
      sessionStartedAt: this._sessionStartedAt,
      windowMinutes: this.windowMinutes,
      ageTier: this._ageTier,
      swingsProcessed: this._swingsProcessed,
      tipsShown: this._tipsShown,
      tipsSuppressed: this._tipsSuppressed,
      tipsBlockedByConfidence: this._tipsBlockedByConfidence,
      metricCounts,
    };
  }

  // ---- Internals ----

  private getLimitForMetric(metricKey: string): number {
    const tierLimits = METRIC_LIMITS[this._ageTier];
    return tierLimits[metricKey] ?? DEFAULT_LIMIT;
  }

  /**
   * Count how many times a metric was shown within the sliding window.
   * Prunes expired timestamps as a side effect (GC).
   */
  private countInCurrentWindow(metricKey: string): number {
    const entry = this.tracker.get(metricKey);
    if (!entry) return 0;
    const windowStart = Date.now() - this._windowMs;
    entry.shownTimestamps = entry.shownTimestamps.filter((t) => t >= windowStart);
    return entry.shownTimestamps.length;
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

export const tipFrequencyLimiter = new TipFrequencyLimiter();

// ---------------------------------------------------------------------------
// Integration: process all tips for a single swing
// ---------------------------------------------------------------------------

/**
 * Filter and tier-tag coaching tips for one swing.
 *
 * Primary integration point — call from result.tsx:
 *
 *   import { processSwingTips } from '../lib/tipFrequency';
 *   import { shouldShowMetric } from '../lib/swingConfidence';
 *
 *   const tips = processSwingTips(
 *     analysis.coachingTips,
 *     shouldShowMetric,
 *     analysis.swingConfidence,
 *     analysis.cameraAngleResult,
 *   );
 *   // Each tip has .metricKey and .decision (gating metadata)
 *
 * ⚠️ BYPASS PATH: "Record Again" may skip checkSwingLimit() but still
 * reaches the result screen. This function is independent of swing limits,
 * so frequency gating still applies. However, verify in record.tsx that
 * shouldShowMetric is called on every path — not just the first-swing path.
 *
 * @param tips - Raw tips from analysis. Treated as readonly.
 * @param shouldShowMetricFn - Task 6 gate. Must match ShouldShowMetricFn signature.
 * @param swingConfidence - From analysis.swingConfidence.
 * @param cameraAngleResult - From analysis.cameraAngleResult.
 * @param estimatedAngleDeg - Camera angle in degrees (0-90) from foreshortening, for Task 9 angle gating.
 * @returns Only non-suppressed tips with metric key and gating decision.
 */
export function processSwingTips(
  tips: readonly RawCoachingTip[],
  shouldShowMetricFn: ShouldShowMetricFn,
  swingConfidence: SwingConfidence,
  cameraAngleResult: CameraAngleResult,
  estimatedAngleDeg?: number | null,
): ProcessedCoachingTip[] {
  tipFrequencyLimiter.recordSwingProcessed();
  const result: ProcessedCoachingTip[] = [];

  for (const tip of tips) {
    // Gate 1: Task 6 confidence + camera angle reliability
    if (!shouldShowMetricFn(tip.metricKey, swingConfidence, cameraAngleResult)) {
      tipFrequencyLimiter.recordBlockedByConfidence();
      continue;
    }

    // Gate 1.5: Task 9 angle gating — suppress metrics unreliable at this camera angle
    if (estimatedAngleDeg != null && !angleGatingShouldShow(tip.metricKey, estimatedAngleDeg)) {
      tipFrequencyLimiter.recordBlockedByConfidence();
      continue;
    }

    // Gate 1.75: Metric eligibility — suppress metrics ineligible for this age tier
    if (!isMetricEligible(tip.metricKey, tipFrequencyLimiter.ageTier)) continue;

    // Gate 2: Frequency limit (pure read)
    const decision = tipFrequencyLimiter.getTipDecision(tip.metricKey);
    if (decision.tier === 'suppressed') {
      tipFrequencyLimiter.recordSuppressed();
      continue;
    }

    // Commit: record show
    tipFrequencyLimiter.recordShown(tip.metricKey);

    result.push({
      metricKey: tip.metricKey,
      decision,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// swing_debug integration (additive JSONB — no new top-level columns)
// ---------------------------------------------------------------------------

/**
 * Compact debug object for swing_debug.tipFrequency.
 * Call after processSwingTips for the current swing.
 */
export function getFrequencyDebugInfo(): { tipFrequency: Record<string, unknown> } {
  const stats = tipFrequencyLimiter.getSessionStats();
  return {
    tipFrequency: {
      windowMin: stats.windowMinutes,
      ageTier: stats.ageTier,
      swings: stats.swingsProcessed,
      shown: stats.tipsShown,
      suppressed: stats.tipsSuppressed,
      blockedByConfidence: stats.tipsBlockedByConfidence,
      sessionMs: Date.now() - stats.sessionStartedAt,
      counts: stats.metricCounts,
    },
  };
}

// ---------------------------------------------------------------------------
// Exports for testing internals
// ---------------------------------------------------------------------------

export { METRIC_LIMITS, DEFAULT_LIMIT };
