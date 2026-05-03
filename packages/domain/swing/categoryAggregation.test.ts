/**
 * categoryAggregation.test.ts — SCR-0b-2 tests for aggregateSwing
 *
 * Run with: npx --yes tsx packages/domain/swing/categoryAggregation.test.ts
 */

import { aggregateSwing, type CategoryName } from './categoryAggregation';
import type { ScoringResult, ScoringBreakdownEntry } from './scoring';
import type { GatedMetricKey } from './visibilityWeighting';

// ---------------------------------------------------------------------------
// Test harness (custom-assert per F18)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let currentGroup = '';

function group(name: string): void {
  currentGroup = name;
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

function assertDeepEq(actual: unknown, expected: unknown, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );
}

function assertClose(actual: number, expected: number, label: string, tol = Number.EPSILON * 8): void {
  assert(
    Math.abs(actual - expected) <= tol,
    `${label} (got ${actual}, expected ${expected}, tol ${tol})`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ConfidencePair = { visibilityConfidence: number; cameraConfidence: number };
type MetricConfidenceMap = Partial<Record<GatedMetricKey | 'tempo', ConfidencePair>>;

function makeBreakdownEntry(
  metric: string,
  score: number,
  dataQuality: 'measured' | 'missing' = 'measured',
  weight = 1,
): ScoringBreakdownEntry {
  return {
    metric,
    score: dataQuality === 'measured' ? score : 0,
    weight,
    weighted: dataQuality === 'measured' ? score * weight : 0,
    dataQuality,
  };
}

function makeConfidence(vis: number, cam: number): ConfidencePair {
  return { visibilityConfidence: vis, cameraConfidence: cam };
}

function makeScoring(breakdown: ScoringBreakdownEntry[]): ScoringResult {
  return { score: 0, honeyBoom: false, breakdown };
}

console.log('\n=== categoryAggregation Tests ===');

// ---------------------------------------------------------------------------
// F1 — FEASIBILITY CANARY (Rule 10): HC13 + HC14 + canonical map
// ---------------------------------------------------------------------------

group('F1. FEASIBILITY CANARY: canonical map + HC13 + HC14');
{
  const breakdown: ScoringBreakdownEntry[] = [
    makeBreakdownEntry('spineAngle', 80),
    makeBreakdownEntry('leftElbowAngle', 90),
    makeBreakdownEntry('rightElbowAngle', 90),
    makeBreakdownEntry('leftKneeAngle', 70),
    makeBreakdownEntry('rightKneeAngle', 70),
    makeBreakdownEntry('shoulderTilt', 85),
    makeBreakdownEntry('tempo', 75),
  ];
  const mc: MetricConfidenceMap = {
    spineAngle: makeConfidence(1, 1),
    leftElbowAngle: makeConfidence(1, 1),
    rightElbowAngle: makeConfidence(1, 1),
    leftKneeAngle: makeConfidence(1, 1),
    rightKneeAngle: makeConfidence(1, 1),
    shoulderTilt: makeConfidence(1, 1),
    tempo: makeConfidence(1, 1),
  };
  const result = aggregateSwing(makeScoring(breakdown), mc);

  // HC14: exactly 4 category keys
  const keys = Object.keys(result.categories).sort();
  assertDeepEq(keys, ['balance', 'posture', 'rotationControl', 'tempo'], 'F1a: exactly 4 category keys');

  // HC13: posture contributingMetrics is ['spineAngle'] only (no diagnostics)
  assertDeepEq(
    result.categories.posture?.contributingMetrics,
    ['spineAngle'],
    'F1b: posture.contributingMetrics === [spineAngle] only',
  );

  // tempo: contributingMetrics is ['tempo'] only
  assertDeepEq(
    result.categories.tempo?.contributingMetrics,
    ['tempo'],
    'F1c: tempo.contributingMetrics === [tempo] only',
  );

  // OD-2B: balance + rotationControl null
  assertEq(result.categories.balance, null, 'F1d: balance === null (sub-metrics empty)');
  assertEq(result.categories.rotationControl, null, 'F1e: rotationControl === null (sub-metrics empty)');
}

// ---------------------------------------------------------------------------
// F2-F3 — HC6 dataQuality filter (phantom-signal trap)
// ---------------------------------------------------------------------------

group('F2. HC6 phantom-signal: posture null when spineAngle dataQuality=missing');
{
  const breakdown = [
    makeBreakdownEntry('spineAngle', 80, 'missing'),
    makeBreakdownEntry('tempo', 90, 'measured'),
  ];
  const mc: MetricConfidenceMap = {
    spineAngle: makeConfidence(1, 1),
    tempo: makeConfidence(1, 1),
  };
  const result = aggregateSwing(makeScoring(breakdown), mc);
  assertEq(result.categories.posture, null, 'F2: HC6 filter blocks State-3 phantom signal before confidence lookup');
}

group('F3. HC6 phantom-signal: tempo null when tempo dataQuality=missing');
{
  const breakdown = [
    makeBreakdownEntry('spineAngle', 80, 'measured'),
    makeBreakdownEntry('tempo', 90, 'missing'),
  ];
  const mc: MetricConfidenceMap = {
    spineAngle: makeConfidence(1, 1),
    tempo: makeConfidence(1, 1),
  };
  const result = aggregateSwing(makeScoring(breakdown), mc);
  assertEq(result.categories.tempo, null, 'F3: tempo missing → tempo category null');
}

// ---------------------------------------------------------------------------
// F4-F5 — State-2 fallback (metricConfidences === {} or undefined)
// ---------------------------------------------------------------------------

group('F4. State-2 mid_frame_fallback: metricConfidences === {} → weight 1 fallback');
{
  const breakdown = [makeBreakdownEntry('spineAngle', 80, 'measured')];
  const result = aggregateSwing(makeScoring(breakdown), {});
  assertEq(result.categories.posture?.score, 80, 'F4a: posture.score === spineAngle.score (no down-weighting)');
  assertEq(result.categories.posture?.totalWeight, 1, 'F4b: posture.totalWeight === 1 (?? 1 fallback)');
}

group('F5. metricConfidences undefined → weight 1 fallback (same as F4)');
{
  const breakdown = [makeBreakdownEntry('spineAngle', 80, 'measured')];
  const result = aggregateSwing(makeScoring(breakdown));
  assertEq(result.categories.posture?.score, 80, 'F5a: posture.score === 80');
  assertEq(result.categories.posture?.totalWeight, 1, 'F5b: posture.totalWeight === 1');
}

// ---------------------------------------------------------------------------
// F6-F8 — OD-2A min combination (NOT product, NOT average)
// ---------------------------------------------------------------------------

group('F6. OD-2A min: vis=0.3 cam=0.8 → weight=0.3 (min, not 0.55, not 0.24)');
{
  const breakdown = [makeBreakdownEntry('spineAngle', 80, 'measured')];
  const mc: MetricConfidenceMap = { spineAngle: makeConfidence(0.3, 0.8) };
  const result = aggregateSwing(makeScoring(breakdown), mc);
  assertClose(result.categories.posture!.totalWeight, 0.3, 'F6a: totalWeight === 0.3 (Math.min)');
  assertClose(result.categories.posture!.score, 80, 'F6b: score === 80 (single contributor weighted-avg)');
}

group('F7. OD-2A min: vis=1.0 cam=0.5 → weight=0.5');
{
  const breakdown = [makeBreakdownEntry('spineAngle', 80, 'measured')];
  const mc: MetricConfidenceMap = { spineAngle: makeConfidence(1.0, 0.5) };
  const result = aggregateSwing(makeScoring(breakdown), mc);
  assertClose(result.categories.posture!.totalWeight, 0.5, 'F7a: totalWeight === 0.5');
  assertClose(result.categories.posture!.score, 80, 'F7b: score === 80');
}

group('F8. OD-2A min zero-edge: vis=0 cam=1 → totalWeight=0 → category null (operator-locked F8 choice)');
{
  const breakdown = [makeBreakdownEntry('spineAngle', 80, 'measured')];
  const mc: MetricConfidenceMap = { spineAngle: makeConfidence(0, 1) };
  const result = aggregateSwing(makeScoring(breakdown), mc);
  assertEq(result.categories.posture, null, 'F8: zero-totalWeight → posture null (NaN guard per plan §2 F8)');
}

// ---------------------------------------------------------------------------
// F9-F10 — Key-set divergence (Internal Trap 1)
// ---------------------------------------------------------------------------

group('F9. Internal Trap 1: confidence-only key (hipSpreadDelta) never enters contributingMetrics');
{
  const breakdown = [makeBreakdownEntry('spineAngle', 80, 'measured')];
  const mc: MetricConfidenceMap = {
    spineAngle: makeConfidence(1, 1),
    hipSpreadDelta: makeConfidence(1, 1),
  };
  const result = aggregateSwing(makeScoring(breakdown), mc);
  assertDeepEq(
    result.categories.posture?.contributingMetrics,
    ['spineAngle'],
    'F9a: posture.contributingMetrics excludes hipSpreadDelta',
  );
  assertEq(result.categories.rotationControl, null, 'F9b: rotationControl still null (empty sub-metrics list)');
}

group('F10. All 7 metric_keys + tempo populated; breakdown has spineAngle + tempo + 5 diagnostics');
{
  const breakdown = [
    makeBreakdownEntry('spineAngle', 80, 'measured'),
    makeBreakdownEntry('leftElbowAngle', 90, 'measured'),
    makeBreakdownEntry('rightElbowAngle', 90, 'measured'),
    makeBreakdownEntry('leftKneeAngle', 70, 'measured'),
    makeBreakdownEntry('rightKneeAngle', 70, 'measured'),
    makeBreakdownEntry('shoulderTilt', 85, 'measured'),
    makeBreakdownEntry('tempo', 75, 'measured'),
  ];
  const mc: MetricConfidenceMap = {
    spineAngle: makeConfidence(1, 1),
    leftElbowAngle: makeConfidence(1, 1),
    rightElbowAngle: makeConfidence(1, 1),
    leftKneeAngle: makeConfidence(1, 1),
    rightKneeAngle: makeConfidence(1, 1),
    shoulderTilt: makeConfidence(1, 1),
    hipSpreadDelta: makeConfidence(1, 1),
    tempo: makeConfidence(1, 1),
  };
  const result = aggregateSwing(makeScoring(breakdown), mc);
  assertDeepEq(result.categories.posture?.contributingMetrics, ['spineAngle'], 'F10a: posture = [spineAngle]');
  assertDeepEq(result.categories.tempo?.contributingMetrics, ['tempo'], 'F10b: tempo = [tempo]');
  assertEq(result.categories.balance, null, 'F10c: balance still null');
  assertEq(result.categories.rotationControl, null, 'F10d: rotationControl still null');
}

// ---------------------------------------------------------------------------
// F11 — HC13 enforcement (diagnostic-vs-scoring boundary)
// ---------------------------------------------------------------------------

group('F11. HC13: 5 diagnostics measured at 100 + spineAngle absent → posture null (NOT 100)');
{
  const breakdown = [
    makeBreakdownEntry('leftElbowAngle', 100, 'measured'),
    makeBreakdownEntry('rightElbowAngle', 100, 'measured'),
    makeBreakdownEntry('leftKneeAngle', 100, 'measured'),
    makeBreakdownEntry('rightKneeAngle', 100, 'measured'),
    makeBreakdownEntry('shoulderTilt', 100, 'measured'),
  ];
  const mc: MetricConfidenceMap = {
    leftElbowAngle: makeConfidence(1, 1),
    rightElbowAngle: makeConfidence(1, 1),
    leftKneeAngle: makeConfidence(1, 1),
    rightKneeAngle: makeConfidence(1, 1),
    shoulderTilt: makeConfidence(1, 1),
  };
  const result = aggregateSwing(makeScoring(breakdown), mc);
  assertEq(result.categories.posture, null, 'F11: HC13 — diagnostics never enter posture');
  assertEq(result.categories.balance, null, 'F11b: balance null');
  assertEq(result.categories.rotationControl, null, 'F11c: rotationControl null');
  assertEq(result.categories.tempo, null, 'F11d: tempo null (no tempo entry in breakdown)');
}

// ---------------------------------------------------------------------------
// F12 — Null-category propagation (OD-2B / OD-2B-EXTENDED)
// ---------------------------------------------------------------------------

group('F12. OD-2B-EXTENDED: balance + rotationControl always null at v0 (literal map drives)');
{
  const breakdown = [
    makeBreakdownEntry('spineAngle', 100, 'measured'),
    makeBreakdownEntry('leftElbowAngle', 100, 'measured'),
    makeBreakdownEntry('rightElbowAngle', 100, 'measured'),
    makeBreakdownEntry('leftKneeAngle', 100, 'measured'),
    makeBreakdownEntry('rightKneeAngle', 100, 'measured'),
    makeBreakdownEntry('shoulderTilt', 100, 'measured'),
    makeBreakdownEntry('tempo', 100, 'measured'),
  ];
  const mc: MetricConfidenceMap = {
    spineAngle: makeConfidence(1, 1),
    leftElbowAngle: makeConfidence(1, 1),
    rightElbowAngle: makeConfidence(1, 1),
    leftKneeAngle: makeConfidence(1, 1),
    rightKneeAngle: makeConfidence(1, 1),
    shoulderTilt: makeConfidence(1, 1),
    hipSpreadDelta: makeConfidence(1, 1),
    tempo: makeConfidence(1, 1),
  };
  const result = aggregateSwing(makeScoring(breakdown), mc);
  assertEq(result.categories.balance, null, 'F12a: balance still null');
  assertEq(result.categories.rotationControl, null, 'F12b: rotationControl still null');
}

// ---------------------------------------------------------------------------
// F13-F14 — Output shape contract
// ---------------------------------------------------------------------------

group('F13. Result has exactly 4 category keys');
{
  const result = aggregateSwing(makeScoring([]));
  const keys = Object.keys(result.categories).sort();
  assertDeepEq(keys, ['balance', 'posture', 'rotationControl', 'tempo'], 'F13: 4 keys exactly');
}

group('F14. Each non-null CategoryScore has exactly 3 keys');
{
  const breakdown = [makeBreakdownEntry('spineAngle', 80, 'measured')];
  const mc: MetricConfidenceMap = { spineAngle: makeConfidence(1, 1) };
  const result = aggregateSwing(makeScoring(breakdown), mc);
  const keys = Object.keys(result.categories.posture!).sort();
  assertDeepEq(keys, ['contributingMetrics', 'score', 'totalWeight'], 'F14: posture has [contributingMetrics, score, totalWeight] only');
}

// ---------------------------------------------------------------------------
// F15 — Tempo State-3 confidence semantics regression (SCR-0b-0 quirk)
// ---------------------------------------------------------------------------

group('F15. Tempo State-3 default: vis=1 cam=0.6 → tempo.totalWeight=0.6');
{
  const breakdown = [makeBreakdownEntry('tempo', 87, 'measured')];
  const mc: MetricConfidenceMap = { tempo: makeConfidence(1, 0.6) };
  const result = aggregateSwing(makeScoring(breakdown), mc);
  assertClose(result.categories.tempo!.score, 87, 'F15a: tempo.score === 87');
  assertClose(result.categories.tempo!.totalWeight, 0.6, 'F15b: tempo.totalWeight === 0.6 (Math.min(1,0.6))');
}

// Reference type-only assertion to keep CategoryName imported (compile-time check)
const _categoryNameTypeRef: CategoryName = 'posture';
void _categoryNameTypeRef;

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
  console.log('✅ All categoryAggregation tests passed');
}
