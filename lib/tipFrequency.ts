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
 *   - 'full'       First mention → full coaching card with body text
 *   - 'shortened'  Repeat under limit → abbreviated card with shortBody
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

// ---------------------------------------------------------------------------
// Task 6 types (match swingConfidence.ts / cameraAngle.ts exports)
// ---------------------------------------------------------------------------

/** Confidence tier from Task 6's composite confidence score */
export type ConfidenceTier = 'low' | 'medium' | 'high';

/** Per-swing confidence breakdown from Task 6 */
export interface SwingConfidence {
  overall: number; // 0-1
  tier: ConfidenceTier;
  components: {
    jointVisibility: number;
    phaseDetection: number;
    frameCoverage: number;
    cameraAngle: number;
  };
}

/** Camera angle detection result from Task 6 */
export interface CameraAngleResult {
  estimatedAngle: number | null; // degrees 0-90, null = unknown
  category: 'face_on' | 'three_quarter' | 'dtl' | 'unknown';
  confidence: number; // 0-1
  perMetricWeights: Record<string, number>; // metric → 0-1 reliability
}

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

/** Age tier determines which limit table to use */
export type AgeTier = 'youth' | 'teen' | 'adult';

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
 * Each tip targets one metric and carries full + short text.
 */
export interface RawCoachingTip {
  metricKey: string;
  title: string;
  body: string;
  shortBody: string;
}

/**
 * A tip that passed both the confidence gate and frequency limiter.
 * Ready for rendering in the result screen.
 */
export interface ProcessedCoachingTip {
  metricKey: string;
  title: string;
  /** Text to display — automatically chosen based on displayTier */
  displayBody: string;
  /** Original full body (available if UI wants to offer "Show more") */
  fullBody: string;
  displayTier: 'full' | 'shortened';
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
// Short body fallback map
// ---------------------------------------------------------------------------

/**
 * Fallback short coaching text when the analysis pipeline's shortBody is empty.
 * Cross-referenced with Dave's real coaching language (April 3, 2026).
 */
const SHORT_BODY_FALLBACKS: Record<string, string> = {
  grip: 'Check your grip.',
  posture: 'Watch your posture.',
  tempo: 'Smooth that tempo.',
  balance: 'Stay balanced.',
  armExtension: 'Extend those arms.',
  shoulderTilt: 'Watch shoulder tilt.',
  hipRotation: 'Rotate those hips.',
  kneeFlex: 'Check your knees.',
  elbow: 'Watch the elbow.',
  spineAngle: 'Check spine angle.',
  wristAngle: 'Watch your wrists.',
  clubfaceAngle: 'Check clubface.',
};

/**
 * Resolve short body text with fallback chain:
 *   1. tip.shortBody (from analysis pipeline — preferred)
 *   2. SHORT_BODY_FALLBACKS[metricKey]
 *   3. First sentence of tip.body
 */
export function resolveShortBody(tip: RawCoachingTip): string {
  if (tip.shortBody) return tip.shortBody;
  const fallback = SHORT_BODY_FALLBACKS[tip.metricKey];
  if (fallback) return fallback;
  const firstSentence = tip.body.split(/[.!]\s/)[0];
  return firstSentence.length < tip.body.length
    ? firstSentence + '.'
    : tip.body;
}

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
 *   // Render tips — each has .displayBody and .displayTier
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
 * @returns Only non-suppressed tips with displayBody set by tier.
 */
export function processSwingTips(
  tips: readonly RawCoachingTip[],
  shouldShowMetricFn: ShouldShowMetricFn,
  swingConfidence: SwingConfidence,
  cameraAngleResult: CameraAngleResult,
): ProcessedCoachingTip[] {
  tipFrequencyLimiter.recordSwingProcessed();
  const result: ProcessedCoachingTip[] = [];

  for (const tip of tips) {
    // Gate 1: Task 6 confidence + camera angle reliability
    if (!shouldShowMetricFn(tip.metricKey, swingConfidence, cameraAngleResult)) {
      tipFrequencyLimiter.recordBlockedByConfidence();
      continue;
    }

    // Gate 2: Frequency limit (pure read)
    const decision = tipFrequencyLimiter.getTipDecision(tip.metricKey);
    if (decision.tier === 'suppressed') {
      tipFrequencyLimiter.recordSuppressed();
      continue;
    }

    // Commit: record show + build processed tip
    tipFrequencyLimiter.recordShown(tip.metricKey);

    const displayBody =
      decision.tier === 'full' ? tip.body : resolveShortBody(tip);

    result.push({
      metricKey: tip.metricKey,
      title: tip.title,
      displayBody,
      fullBody: tip.body,
      displayTier: decision.tier,
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

export { METRIC_LIMITS, DEFAULT_LIMIT, SHORT_BODY_FALLBACKS };
