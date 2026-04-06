/**
 * sessionInsights.ts — Task 14: Session Insight Text Generation
 *
 * Pure functions that produce friendly, age-neutral insight messages.
 * Task 15 will layer age-specific variants later.
 */

/**
 * Focus suggestion: a single metric keeps getting flagged.
 * Priority 1 — surfaces a pattern the player should address.
 */
export function generateFocusInsight(metricName: string, flagCount: number): string {
  return `Your ${metricName} came up ${flagCount} times — worth focusing on.`;
}

/**
 * Improvement notice: a previously-flagged metric is trending better.
 * Priority 2 — positive reinforcement for effort.
 */
export function generateImprovementInsight(metricName: string): string {
  return `Your ${metricName} is getting better!`;
}

/**
 * Consistency praise: a metric has been stable with low variance.
 * Priority 3 — the "all good" state.
 */
export function generateConsistencyInsight(metricName: string, swingCount: number): string {
  return `Your ${metricName} has been solid across ${swingCount} swings.`;
}
