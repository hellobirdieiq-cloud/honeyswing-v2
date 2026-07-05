/**
 * positiveReinforcement.ts — Task 8 of accuracy roadmap
 *
 * Generates positive feedback cards when:
 *   1. Confidence is high (tier='high', score >= 75) AND no correction tips
 *      survived the frequency filter → general praise card
 *   2. A previously-flagged metric has improved (now scores >= 80)
 *      → improvement card (fires regardless of confidence or corrections)
 *
 * Priority: improvement cards beat general cards when both conditions are met.
 * Multiple simultaneous improvements: first detected metric wins (by array order).
 * All improved metrics are still exposed in the result for debug/logging.
 *
 * Card pool rotates randomly with no immediate repeats.
 * No frequency limit on positive cards — kids should hear praise often.
 *
 * Singleton pattern matches tipFrequencyLimiter (Task 7).
 *
 * TYPE DEBT: ConfidenceInput and MetricScore duplicate domain types.
 * Fix: import from packages/domain/swing/ (~5 min, same as Task 7 debt).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PositiveCardType = 'general' | 'improvement';

export interface PositiveCard {
  type: PositiveCardType;
  message: string;
  /** Which metric improved. Present only when type='improvement'. */
  metricKey?: string;
}

/** Full result from processSwing — gives caller everything needed for debug. */
export interface ProcessSwingResult {
  /** The positive card to display, or null if none. */
  card: PositiveCard | null;
  /** Metric keys that improved this swing (may be >1 even though only 1 card shows). */
  improvements: string[];
}

export interface PositiveReinforcementDebug {
  positiveCardShown: boolean;
  positiveCardType: PositiveCardType | null;
  positiveCardMessage: string | null;
  improvementDetected: string[];
  sessionPositiveCount: number;
  sessionImprovementCount: number;
}

/** Subset of confidence score (Task 6). */
export interface ConfidenceInput {
  tier: 'low' | 'medium' | 'high';
  overall: number;
}

/** A single metric's score from the analysis pipeline. */
export interface MetricScore {
  metricKey: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum confidence.overall to qualify for a general positive card. */
const CONFIDENCE_THRESHOLD = 75;

/** Metric must score >= this to count as "good" / clear a flag. Matches TIP_SCORE_THRESHOLD in result.tsx. */
const GOOD_SCORE_THRESHOLD = 80;

/**
 * General praise cards — rotate randomly, no immediate repeats.
 * Youth-friendly (8-12 year olds). Short, energetic, matches Dave's coaching style.
 */
const GENERAL_CARDS: readonly string[] = [
  'Great swing!',
  'Great tempo!',
  'Solid balance!',
  'Looking good!',
  'Nice and smooth!',
  "That's the swing!",
  'Keep it up!',
  'Really nice form!',
  'Love that swing!',
  'Nailed it!',
] as const;

/**
 * Improvement templates — {metric} gets replaced with friendly name.
 * Multiple templates to avoid repetition across a session.
 */
const IMPROVEMENT_TEMPLATES: readonly string[] = [
  'Your {metric} is looking much better!',
  'Nice improvement on {metric}!',
  '{metric} is really coming along!',
  'Great progress on {metric}!',
] as const;

/** Map metricKey → user-facing friendly name. Unknown keys fall back to raw key. */
const METRIC_FRIENDLY_NAMES: Record<string, string> = {
  tempo: 'tempo',
  spineAngle: 'posture',
  shoulderTilt: 'shoulder tilt',
  hipSpreadDelta: 'hip rotation',
  elbow: 'arm extension',
  kneeFlex: 'knee bend',
  armExtension: 'arm extension',
  balance: 'balance',
  posture: 'posture',
  grip: 'grip',
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

class PositiveReinforcementEngine {
  /** Recent general card indices — prevents immediate repeats. */
  private recentGeneralIndices: number[] = [];

  /** Recent improvement template indices — prevents immediate repeats. */
  private recentImprovementIndices: number[] = [];

  /** Metrics that scored below GOOD_SCORE_THRESHOLD on a previous swing this session. */
  private flaggedMetrics: Map<string, number> = new Map();

  /** Session counters for debug. */
  private sessionPositiveCount = 0;
  private sessionImprovementCount = 0;

  /** Last processSwing result — stored so buildDebugInfo() needs no args from caller. */
  private lastResult: ProcessSwingResult = { card: null, improvements: [] };

  /**
   * Process a swing and decide whether to show a positive card.
   *
   * Call AFTER processSwingTips (Task 7) so you know how many corrections survived.
   *
   * @param confidence         Confidence score from Task 6.
   * @param metricScores       All metric scores for this swing (already deduped by caller).
   * @param correctionsSurvived Number of correction tips that survived the frequency filter.
   * @returns ProcessSwingResult with card (nullable) and improvements list.
   */
  processSwing(
    confidence: ConfidenceInput,
    metricScores: MetricScore[],
    correctionsSurvived: number,
  ): ProcessSwingResult {
    // Sanitize: drop any NaN/undefined scores
    const cleanScores = metricScores.filter(
      (m) => typeof m.score === 'number' && !Number.isNaN(m.score),
    );

    // Step 1: Detect improvements from previously-flagged metrics
    const improvements = this.detectImprovements(cleanScores);

    // Step 2: Update flagged metrics for next swing (AFTER detection, so current swing doesn't self-trigger)
    this.updateFlaggedMetrics(cleanScores);

    // Step 3: Determine result
    let result: ProcessSwingResult;

    if (improvements.length > 0) {
      // Improvement card (first improved metric wins)
      const card = this.pickImprovementCard(improvements[0]);
      this.sessionImprovementCount++;
      this.sessionPositiveCount++;
      result = { card, improvements };
    } else if (
      confidence.overall >= CONFIDENCE_THRESHOLD &&
      confidence.tier === 'high' &&
      correctionsSurvived === 0
    ) {
      // General positive card
      const card = this.pickGeneralCard();
      this.sessionPositiveCount++;
      result = { card, improvements: [] };
    } else {
      result = { card: null, improvements: [] };
    }

    // Store for zero-arg buildDebugInfo()
    this.lastResult = result;
    return result;
  }

  /**
   * Build debug info for swing_debug JSONB.
   * Reads from the last processSwing result internally — no args needed.
   * Safe to call from persistSwing.ts without any data plumbing.
   */
  buildDebugInfo(): PositiveReinforcementDebug {
    const r = this.lastResult;
    return {
      positiveCardShown: r.card !== null,
      positiveCardType: r.card?.type ?? null,
      positiveCardMessage: r.card?.message ?? null,
      improvementDetected: r.improvements,
      sessionPositiveCount: this.sessionPositiveCount,
      sessionImprovementCount: this.sessionImprovementCount,
    };
  }

  /**
   * Reset session state. Called on app foreground by the AppState 'active'
   * listener in app/_layout.tsx, alongside tipFrequencyLimiter.reset().
   */
  // Note: reset() is NOT called on player switches, so praise/improvement
  // tracking can leak across kids within one app session.
  reset(): void {
    this.recentGeneralIndices = [];
    this.recentImprovementIndices = [];
    this.flaggedMetrics.clear();
    this.sessionPositiveCount = 0;
    this.sessionImprovementCount = 0;
    this.lastResult = { card: null, improvements: [] };
  }

  /** Expose flagged metrics for testing. */
  getFlaggedMetrics(): Map<string, number> {
    return new Map(this.flaggedMetrics);
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Check if any previously-flagged metric has improved to >= GOOD_SCORE_THRESHOLD.
   * Returns ALL improved metric keys (caller picks first for the card).
   */
  private detectImprovements(metricScores: MetricScore[]): string[] {
    const improved: string[] = [];
    for (const { metricKey, score } of metricScores) {
      const prevScore = this.flaggedMetrics.get(metricKey);
      if (
        prevScore !== undefined &&
        prevScore < GOOD_SCORE_THRESHOLD &&
        score >= GOOD_SCORE_THRESHOLD
      ) {
        improved.push(metricKey);
      }
    }
    return improved;
  }

  /**
   * Update flagged metrics with current scores.
   * < GOOD_SCORE_THRESHOLD → flag (or update flag score).
   * >= GOOD_SCORE_THRESHOLD → clear flag (metric is now good).
   */
  private updateFlaggedMetrics(metricScores: MetricScore[]): void {
    for (const { metricKey, score } of metricScores) {
      if (score < GOOD_SCORE_THRESHOLD) {
        this.flaggedMetrics.set(metricKey, score);
      } else {
        this.flaggedMetrics.delete(metricKey);
      }
    }
  }

  /** Pick a general card from the rotating pool. No immediate repeats. */
  private pickGeneralCard(): PositiveCard {
    const idx = this.pickFromPool(GENERAL_CARDS.length, this.recentGeneralIndices);
    this.recentGeneralIndices.push(idx);
    this.trimRecent(this.recentGeneralIndices, GENERAL_CARDS.length);
    return { type: 'general', message: GENERAL_CARDS[idx] };
  }

  /** Pick an improvement template and substitute the metric name. */
  private pickImprovementCard(metricKey: string): PositiveCard {
    const idx = this.pickFromPool(IMPROVEMENT_TEMPLATES.length, this.recentImprovementIndices);
    this.recentImprovementIndices.push(idx);
    this.trimRecent(this.recentImprovementIndices, IMPROVEMENT_TEMPLATES.length);

    const friendlyName = METRIC_FRIENDLY_NAMES[metricKey] ?? metricKey;
    const message = IMPROVEMENT_TEMPLATES[idx].replace('{metric}', friendlyName);
    return { type: 'improvement', message, metricKey };
  }

  /**
   * Pick a random index from [0..poolSize) that isn't in the recent list.
   * Resets recent list if all indices have been used.
   */
  private pickFromPool(poolSize: number, recent: number[]): number {
    let available: number[] = [];
    for (let i = 0; i < poolSize; i++) {
      if (!recent.includes(i)) available.push(i);
    }
    if (available.length === 0) {
      recent.length = 0;
      available = [];
      for (let i = 0; i < poolSize; i++) available.push(i);
    }
    return available[Math.floor(Math.random() * available.length)];
  }

  /** Keep recent list at max floor(poolSize/2) to ensure variety without exhausting pool too fast. */
  private trimRecent(recent: number[], poolSize: number): void {
    const maxRecent = Math.floor(poolSize / 2);
    while (recent.length > maxRecent) {
      recent.shift();
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton (matches tipFrequencyLimiter pattern)
// ---------------------------------------------------------------------------

export const positiveReinforcementEngine = new PositiveReinforcementEngine();

// Export class for testing with fresh instances
export { PositiveReinforcementEngine };

// Export constants for test assertions
export const _testExports = {
  GENERAL_CARDS,
  IMPROVEMENT_TEMPLATES,
  METRIC_FRIENDLY_NAMES,
  CONFIDENCE_THRESHOLD,
  GOOD_SCORE_THRESHOLD,
};
