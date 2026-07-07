/**
 * coachingTips.test.ts — Tests for buildRawTips and dedupeWorstMetricScores
 * (frameToLandmarks / pickKeyFrame sections removed with the functions —
 * dead-code sweep, efficiency-audit Fix 9)
 *
 * Run with: npx tsx lib/coachingTips.test.ts
 */

import {
  buildRawTips,
  dedupeWorstMetricScores,
  TIP_SCORE_THRESHOLD,
} from './coachingTips';
import type { ScoringBreakdownEntry } from '../packages/domain/swing/scoring';

// ---------------------------------------------------------------------------
// Test harness
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  metric: string,
  score: number,
  dataQuality: 'measured' | 'missing' = 'measured',
): ScoringBreakdownEntry {
  return { metric, score, weight: 1, weighted: score, dataQuality };
}

console.log('\n=== Coaching Tips Tests ===');

// ---------------------------------------------------------------------------
// Section C — buildRawTips
// ---------------------------------------------------------------------------

group('C1. Entry with score < threshold and measured → included');
{
  const tips = buildRawTips([makeEntry('spineAngle', 60)]);
  assertEq(tips.length, 1, '1 tip');
  assertEq(tips[0].metricKey, 'spineAngle', 'metricKey = spineAngle');
}

group('C2. Entry with score >= threshold → filtered out');
{
  const tips = buildRawTips([makeEntry('spineAngle', TIP_SCORE_THRESHOLD)]);
  assertEq(tips.length, 0, 'score at threshold → filtered');

  const tips2 = buildRawTips([makeEntry('spineAngle', 95)]);
  assertEq(tips2.length, 0, 'score above threshold → filtered');
}

group('C3. Entry with dataQuality=missing → filtered out');
{
  const tips = buildRawTips([makeEntry('spineAngle', 30, 'missing')]);
  assertEq(tips.length, 0, 'missing data → filtered');
}

group('C4. Left/right elbow dedup → single "elbow" entry');
{
  const tips = buildRawTips([
    makeEntry('leftElbowAngle', 70),
    makeEntry('rightElbowAngle', 75),
  ]);
  assertEq(tips.length, 1, '2 elbow entries → 1 tip');
  assertEq(tips[0].metricKey, 'elbow', 'mapped to "elbow"');
}

group('C5. Left/right knee dedup → single "kneeFlex" entry');
{
  const tips = buildRawTips([
    makeEntry('leftKneeAngle', 50),
    makeEntry('rightKneeAngle', 40),
  ]);
  assertEq(tips.length, 1, '2 knee entries → 1 tip');
  assertEq(tips[0].metricKey, 'kneeFlex', 'mapped to "kneeFlex"');
}

group('C6. Unmapped metric → skipped');
{
  const tips = buildRawTips([makeEntry('hipSpreadDelta', 30)]);
  assertEq(tips.length, 0, 'unmapped metric skipped');
}

group('C7. Empty breakdown → empty array');
{
  const tips = buildRawTips([]);
  assertEq(tips.length, 0, 'empty → empty');
}

group('C8. All scores >= threshold → empty array');
{
  const tips = buildRawTips([
    makeEntry('spineAngle', 90),
    makeEntry('leftElbowAngle', 85),
    makeEntry('shoulderTilt', 100),
  ]);
  assertEq(tips.length, 0, 'all good scores → no tips');
}

group('C9. All dataQuality=missing → empty array');
{
  const tips = buildRawTips([
    makeEntry('spineAngle', 30, 'missing'),
    makeEntry('leftElbowAngle', 20, 'missing'),
  ]);
  assertEq(tips.length, 0, 'all missing → no tips');
}

group('C10. Output shape matches RawCoachingTip');
{
  const tips = buildRawTips([makeEntry('shoulderTilt', 60)]);
  assertEq(tips.length, 1, '1 tip');
  assert(typeof tips[0].metricKey === 'string', 'metricKey is string');
  // RawCoachingTip has only { metricKey: string }
  assertEq(Object.keys(tips[0]).length, 1, 'tip has exactly 1 key');
  assertEq(Object.keys(tips[0])[0], 'metricKey', 'only key is metricKey');
}

group('C11. Dedup preserves worse score (order independence)');
{
  // Left worse than right
  const tips1 = buildRawTips([
    makeEntry('leftElbowAngle', 30),
    makeEntry('rightElbowAngle', 70),
  ]);
  assertEq(tips1.length, 1, 'deduped to 1');

  // Right worse than left (reversed order)
  const tips2 = buildRawTips([
    makeEntry('rightElbowAngle', 70),
    makeEntry('leftElbowAngle', 30),
  ]);
  assertEq(tips2.length, 1, 'deduped to 1 (reversed order)');

  // Both produce the same mapped key
  assertEq(tips1[0].metricKey, 'elbow', 'mapped key = elbow');
  assertEq(tips2[0].metricKey, 'elbow', 'mapped key = elbow (reversed)');
}

group('C12. Tempo mapping');
{
  const tips = buildRawTips([makeEntry('tempo', 50)]);
  assertEq(tips.length, 1, 'tempo below threshold → included');
  assertEq(tips[0].metricKey, 'tempo', 'mapped to "tempo"');
}

group('C13. Mixed: some pass, some filtered');
{
  const tips = buildRawTips([
    makeEntry('spineAngle', 60),          // included → spineAngle
    makeEntry('leftElbowAngle', 90),      // filtered (score >= 80)
    makeEntry('rightElbowAngle', 50),     // included → elbow
    makeEntry('shoulderTilt', 30, 'missing'), // filtered (missing)
    makeEntry('tempo', 70),               // included → tempo
  ]);
  assertEq(tips.length, 3, '3 tips pass filters');
  const keys = tips.map((t) => t.metricKey);
  assert(keys.includes('spineAngle'), 'spineAngle included');
  assert(keys.includes('elbow'), 'elbow included');
  assert(keys.includes('tempo'), 'tempo included');
}

// ---------------------------------------------------------------------------
// Section D — dedupeWorstMetricScores (Batch 5.2 lift from result.tsx)
// ---------------------------------------------------------------------------

group('D1. Worst score wins per mapped key');
{
  const scores = dedupeWorstMetricScores([
    makeEntry('leftElbowAngle', 72),
    makeEntry('rightElbowAngle', 55),
    makeEntry('spineAngle', 91),
  ]);
  assertEq(scores.length, 2, 'left+right elbow collapse to one key');
  assert(scores[0].metricKey === 'elbow' && scores[0].score === 55, 'elbow keeps the worse score (55)');
  assert(scores[1].metricKey === 'spineAngle' && scores[1].score === 91, 'spineAngle passes through');
}

group('D2. Missing entries skipped (SCR-0b-1)');
{
  const scores = dedupeWorstMetricScores([
    makeEntry('spineAngle', 0, 'missing'),
    makeEntry('shoulderTilt', 88),
  ]);
  assert(scores.length === 1 && scores[0].metricKey === 'shoulderTilt', 'missing spineAngle (score 0) not pulled in');
}

group('D3. Unmapped metrics skipped');
{
  const scores = dedupeWorstMetricScores([
    makeEntry('notARealMetric', 10),
    makeEntry('tempo', 65),
  ]);
  assert(scores.length === 1 && scores[0].metricKey === 'tempo', 'unmapped metric dropped, tempo mapped');
}

group('D4. ARRAY ORDER: first-seen mapped-key insertion order (load-bearing)');
{
  // positiveReinforcementEngine picks the FIRST improved metric by array order —
  // a later, worse score must update the value but NOT the position.
  const scores = dedupeWorstMetricScores([
    makeEntry('shoulderTilt', 70),
    makeEntry('leftKneeAngle', 60),
    makeEntry('spineAngle', 50),
    makeEntry('rightKneeAngle', 40),
  ]);
  assertEq(
    scores.map((s) => s.metricKey).join(','),
    'shoulderTilt,kneeFlex,spineAngle',
    'order = first-seen; later worse score does not reorder',
  );
  assertEq(scores[1].score, 40, 'kneeFlex holds the later, worse score (40) at its original position');
}

group('D5. No tip threshold — good scores included (unlike buildRawTips)');
{
  const scores = dedupeWorstMetricScores([makeEntry('spineAngle', 95)]);
  assert(scores.length === 1 && scores[0].score === 95, 'score 95 included (positive reinforcement needs good scores)');
  assertEq(dedupeWorstMetricScores([]).length, 0, 'empty breakdown → empty array');
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
  console.log('✅ All coaching tips tests passed');
}
