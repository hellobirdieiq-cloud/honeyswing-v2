/**
 * sessionAccumulator.test.ts — Task 14 Accumulator Validation
 *
 * Run with: npx tsx lib/sessionAccumulator.test.ts
 *
 * Covers:
 *   - Swing counting and metric accumulation
 *   - Confidence gate (swingConfidence.overall < 0.50 → count but no metric stats)
 *   - No insight below SESSION_INSIGHT_MIN_SWINGS
 *   - Focus suggestion fires on high flag rate
 *   - Improvement insight fires on trending metric
 *   - Consistency insight fires on low-variance metric
 *   - Reset clears all state
 *   - Priority ordering: focus > improvement > consistency
 */

import {
  sessionAccumulator,
  SESSION_INSIGHT_MIN_SWINGS,
  type AccumulatorMetricKey,
} from './sessionAccumulator';
import { _resetCacheForTesting } from './ageTier';

import type { AnalysisResult } from '../packages/domain/swing/analysisPipeline';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function group(name: string): void {
  console.log(`\n── ${name} ──`);
}

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(
    actual === expected,
    `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAnalysis(overrides: {
  score?: number;
  spineAngle?: number | null;
  leftElbowAngle?: number | null;
  shoulderTilt?: number | null;
  hipSpreadDelta?: number | null;
  tempoRatio?: number | null;
  swingConfidenceOverall?: number;
}): AnalysisResult {
  return {
    score: overrides.score ?? 75,
    honeyBoom: false,
    angles: {
      spineAngle: 'spineAngle' in overrides ? overrides.spineAngle! : 20,
      leftElbowAngle: 'leftElbowAngle' in overrides ? overrides.leftElbowAngle! : 170,
      rightElbowAngle: 160,
      leftKneeAngle: 155,
      rightKneeAngle: 155,
      hipSpreadDelta: 'hipSpreadDelta' in overrides ? overrides.hipSpreadDelta! : 40,
      shoulderTilt: 'shoulderTilt' in overrides ? overrides.shoulderTilt! : 10,
    },
    tempo: overrides.tempoRatio != null ? {
      backswingMs: 800,
      downswingMs: 270,
      tempoRatio: overrides.tempoRatio,
      totalSwingMs: 1070,
      tempoRating: 'good',
      phaseTimestamps: { address: 0, takeaway: 200, top: 800, downswing: 800, impact: 1070, follow_through: 1200 },
    } : null,
    swingConfidence: {
      overall: overrides.swingConfidenceOverall ?? 0.85,
      tier: (overrides.swingConfidenceOverall ?? 0.85) >= 0.7 ? 'high' : (overrides.swingConfidenceOverall ?? 0.85) >= 0.4 ? 'medium' : 'low',
      components: { jointVisibility: 0.9, phaseDetection: 0.8, frameCoverage: 0.85, cameraAngle: 0.9 },
    },
    cameraAngleResult: {
      angle: 'front',
      shoulderSpread: 0.25,
      hipSpread: 0.2,
      avgSpread: 0.225,
      weights: {
        spineAngle: 0.4, leftElbowAngle: 0.9, rightElbowAngle: 0.9,
        leftKneeAngle: 0.6, rightKneeAngle: 0.6, hipSpreadDelta: 1.0,
        shoulderTilt: 0.7, tempo: 1.0,
      },
    },
  } as AnalysisResult;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Always reset before each group
sessionAccumulator.reset();

group('Basic swing counting');
{
  sessionAccumulator.reset();
  assertEq(sessionAccumulator.swingCount, 0, 'starts at 0');
  sessionAccumulator.addSwing(makeAnalysis({}), []);
  assertEq(sessionAccumulator.swingCount, 1, 'increments to 1');
  sessionAccumulator.addSwing(makeAnalysis({}), []);
  assertEq(sessionAccumulator.swingCount, 2, 'increments to 2');
}

group('Confidence gate');
{
  sessionAccumulator.reset();
  // swingConfidence.overall < 0.50 → count but no metric values
  sessionAccumulator.addSwing(makeAnalysis({ score: 30, spineAngle: 999, swingConfidenceOverall: 0.3 }), []);
  assertEq(sessionAccumulator.swingCount, 1, 'swing counted');
  const stats = sessionAccumulator.getMetricStats('spineAngle');
  assert(!stats || stats.values.length === 0, 'no metric values added for low-confidence swing');

  // swingConfidence.overall >= 0.50 → count AND metric values
  sessionAccumulator.addSwing(makeAnalysis({ score: 75, spineAngle: 20, swingConfidenceOverall: 0.85 }), []);
  assertEq(sessionAccumulator.swingCount, 2, 'second swing counted');
  const stats2 = sessionAccumulator.getMetricStats('spineAngle');
  assert(stats2 !== undefined && stats2.values.length === 1, 'metric values added for high-confidence swing');
}

group('No insight below threshold');
{
  sessionAccumulator.reset();
  for (let i = 0; i < SESSION_INSIGHT_MIN_SWINGS - 1; i++) {
    sessionAccumulator.addSwing(makeAnalysis({}), []);
  }
  assertEq(sessionAccumulator.getInsight(), null, `no insight at ${SESSION_INSIGHT_MIN_SWINGS - 1} swings`);
}

group('Consistency insight');
{
  sessionAccumulator.reset();
  // Add consistent tempo values
  for (let i = 0; i < 12; i++) {
    sessionAccumulator.addSwing(makeAnalysis({ tempoRatio: 3.0 + (i % 2 === 0 ? 0.01 : -0.01) }), []);
  }
  const insight = sessionAccumulator.getInsight();
  assert(insight !== null, 'insight fires after 12 consistent swings');
  assertEq(insight?.type, 'consistency', 'type is consistency');
  assert(insight?.message.includes('solid') === true, 'message contains "solid"');
}

group('Focus suggestion');
{
  sessionAccumulator.reset();
  // 10 swings where shoulderTilt is flagged 5 times (50% flag rate)
  for (let i = 0; i < 10; i++) {
    const tips = i < 5 ? ['shoulderTilt'] : [];
    sessionAccumulator.addSwing(makeAnalysis({ shoulderTilt: 10 }), tips);
  }
  const insight = sessionAccumulator.getInsight();
  assert(insight !== null, 'focus insight fires');
  assertEq(insight?.type, 'focus', 'type is focus');
  assert(insight?.message.includes('shoulder tilt') === true, 'message references metric');
  assert(insight?.message.includes('5') === true, 'message includes flag count');
}

group('Focus takes priority over consistency');
{
  sessionAccumulator.reset();
  // Consistent tempo + heavily flagged shoulderTilt
  for (let i = 0; i < 12; i++) {
    sessionAccumulator.addSwing(
      makeAnalysis({ tempoRatio: 3.0, shoulderTilt: 10 }),
      i < 6 ? ['shoulderTilt'] : [],
    );
  }
  const insight = sessionAccumulator.getInsight();
  assertEq(insight?.type, 'focus', 'focus outprioritizes consistency');
}

group('Improvement insight');
{
  sessionAccumulator.reset();
  // 3 swings with flagged hip rotation (below focus threshold), then 9 swings with improving values
  for (let i = 0; i < 3; i++) {
    sessionAccumulator.addSwing(makeAnalysis({ hipSpreadDelta: 20 }), ['hipSpreadDelta']);
  }
  for (let i = 0; i < 9; i++) {
    sessionAccumulator.addSwing(makeAnalysis({ hipSpreadDelta: 25 + i * 3 }), []);
  }
  const insight = sessionAccumulator.getInsight();
  assert(insight !== null, 'improvement insight fires');
  assertEq(insight?.type, 'improvement', 'type is improvement');
  assert(insight?.message.includes('hip rotation') === true, 'references hip rotation');
  assert(insight?.message.includes('better') === true, 'positive language');
}

group('Reset clears state');
{
  sessionAccumulator.reset();
  for (let i = 0; i < 15; i++) {
    sessionAccumulator.addSwing(makeAnalysis({}), []);
  }
  assert(sessionAccumulator.swingCount === 15, 'has 15 swings');
  sessionAccumulator.reset();
  assertEq(sessionAccumulator.swingCount, 0, 'reset to 0');
  assertEq(sessionAccumulator.getInsight(), null, 'no insight after reset');
  assert(sessionAccumulator.getMetricStats('spineAngle') === undefined, 'metric stats cleared');
}

group('Null metric values are skipped');
{
  sessionAccumulator.reset();
  sessionAccumulator.addSwing(makeAnalysis({ spineAngle: null }), []);
  const stats = sessionAccumulator.getMetricStats('spineAngle');
  assert(stats === undefined, 'null spineAngle creates no stats entry');
}

group('Age-tier gate suppresses ineligible metrics');
{
  // spineAngle is ineligible at youth (METRIC_LIMITS.youth.spineAngle === 0)
  // and eligible at adult. Same flagged data, different tier → different outcome.
  _resetCacheForTesting('adult');
  sessionAccumulator.reset();
  for (let i = 0; i < 10; i++) {
    sessionAccumulator.addSwing(makeAnalysis({ spineAngle: 45 }), ['spineAngle']);
  }
  const adultInsight = sessionAccumulator.getInsight();
  assertEq(adultInsight?.type, 'focus', 'adult tier: spineAngle focus fires');
  assertEq(adultInsight?.metricKey, 'spineAngle', 'adult tier: focus keyed on spineAngle');

  _resetCacheForTesting('youth');
  sessionAccumulator.reset();
  for (let i = 0; i < 10; i++) {
    sessionAccumulator.addSwing(makeAnalysis({ spineAngle: 45 }), ['spineAngle']);
  }
  const youthInsight = sessionAccumulator.getInsight();
  assert(
    youthInsight?.metricKey !== 'spineAngle',
    'youth tier: spineAngle never selected by any insight helper',
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All tests passed — Task 14 session accumulator validated');
}
