/**
 * scoring.test.ts — Comprehensive tests for scoreAngle and scoreSwing
 *
 * Run with: npx tsx packages/domain/swing/scoring.test.ts
 */

import { scoreAngle, scoreSwing, type ScoringBreakdownEntry } from './scoring';
import type { GolfAngles } from './angles';
import type { MetricConfidenceWeights } from './cameraAngle';
import type { SwingTempo } from './tempoAnalysis';

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

function makeAngles(overrides: Partial<GolfAngles> = {}): GolfAngles {
  return {
    spineAngle: 35,
    leftElbowAngle: 165,
    rightElbowAngle: 165,
    leftKneeAngle: 155,
    rightKneeAngle: 155,
    hipSpreadDelta: null,
    shoulderTilt: 0,
    ...overrides,
  };
}

function makeTempo(ratio: number): SwingTempo {
  return {
    backswingMs: 900,
    downswingMs: 300,
    tempoRatio: ratio,
    totalSwingMs: 1200,
    tempoRating: 'good',
    phaseTimestamps: { address: 0 } as SwingTempo['phaseTimestamps'],
  };
}

// ---------------------------------------------------------------------------
// Section A — scoreAngle
// ---------------------------------------------------------------------------

console.log('\n=== Scoring Module Tests ===');

group('A. scoreAngle');

// A1: null value → 50
assertEq(scoreAngle(null, 35, 20), 50, 'A1: null value → 50');

// A2: Perfect match
assertEq(scoreAngle(35, 35, 20), 100, 'A2: perfect match → 100');

// A3: At tolerance boundary
assertEq(scoreAngle(55, 35, 20), 0, 'A3: at tolerance boundary → 0');

// A4: Beyond tolerance
assertEq(scoreAngle(60, 35, 20), 0, 'A4: beyond tolerance → 0');

// A5: Half tolerance
assertEq(scoreAngle(45, 35, 20), 50, 'A5: half tolerance → 50');

// A6: Small deviation
assertEq(scoreAngle(37, 35, 20), 90, 'A6: small deviation (37,35,20) → 90');

// A7: Below-ideal symmetry
assertEq(
  scoreAngle(25, 35, 20),
  scoreAngle(45, 35, 20),
  'A7: below-ideal (25,35,20) equals above-ideal (45,35,20)',
);

// A8: Negative angle
assertEq(scoreAngle(-5, 0, 25), 80, 'A8: negative angle (-5,0,25) → 80');

// A9: Large ideal elbow
assertEq(scoreAngle(165, 165, 40), 100, 'A9: large ideal elbow → 100');

// A10: Tolerance=0, exact match → NaN (0/0 in JS)
{
  const result = scoreAngle(35, 35, 0);
  assert(Number.isNaN(result), `A10: tolerance=0 exact match → NaN (got ${result})`);
}

// A11: Tolerance=0, not exact → 0
assertEq(scoreAngle(36, 35, 0), 0, 'A11: tolerance=0, not exact → 0');

// A12: Rounding case
assertEq(scoreAngle(36, 35, 3), 67, 'A12: rounding (36,35,3) → 67');

// A13: Tempo ratio perfect
assertEq(scoreAngle(3, 3, 1.5), 100, 'A13: tempo ratio perfect → 100');

// A14: Tempo ratio bad
assertEq(scoreAngle(1, 3, 1.5), 0, 'A14: tempo ratio bad → 0');

// ---------------------------------------------------------------------------
// Section B — scoreSwing
// ---------------------------------------------------------------------------

group('B1. All ideal + perfect tempo → 100, honeyBoom=true');
{
  const result = scoreSwing({ angles: makeAngles(), tempo: makeTempo(3) });
  assertEq(result.score, 100, 'score = 100');
  assertEq(result.honeyBoom, true, 'honeyBoom = true');
}

group('B2. All null angles + null tempo → 50, honeyBoom=false');
{
  const allNull: GolfAngles = {
    spineAngle: null,
    leftElbowAngle: null,
    rightElbowAngle: null,
    leftKneeAngle: null,
    rightKneeAngle: null,
    hipSpreadDelta: null,
    shoulderTilt: null,
  };
  const result = scoreSwing({ angles: allNull, tempo: null });
  assertEq(result.score, 50, 'score = 50');
  assertEq(result.honeyBoom, false, 'honeyBoom = false');
  const allMissing = result.breakdown.every((e) => e.dataQuality === 'missing');
  assert(allMissing, 'all dataQuality = missing');
}

group('B3. Mixed measured/missing → correct dataQuality');
{
  const angles = makeAngles({ leftElbowAngle: null, rightKneeAngle: null });
  const result = scoreSwing({ angles, tempo: makeTempo(3) });
  const byMetric = Object.fromEntries(result.breakdown.map((e) => [e.metric, e]));
  assertEq(byMetric['spineAngle'].dataQuality, 'measured', 'spineAngle measured');
  assertEq(byMetric['leftElbowAngle'].dataQuality, 'missing', 'leftElbowAngle missing');
  assertEq(byMetric['rightKneeAngle'].dataQuality, 'missing', 'rightKneeAngle missing');
  assertEq(byMetric['tempo'].dataQuality, 'measured', 'tempo measured');
}

group('B4. HoneyBoom threshold');
{
  // Score >= 85 → honeyBoom=true
  // Use small deviations to land just above 85
  const angles85 = makeAngles({ spineAngle: 38, leftKneeAngle: 150 });
  const result85 = scoreSwing({ angles: angles85, tempo: makeTempo(3) });
  assert(result85.score >= 85, `score ${result85.score} >= 85`);
  assertEq(result85.honeyBoom, true, 'honeyBoom = true when score >= 85');

  // Score < 85 → honeyBoom=false
  // Use larger deviations to push below 85
  const anglesLow = makeAngles({ spineAngle: 50, leftElbowAngle: 140, leftKneeAngle: 130 });
  const resultLow = scoreSwing({ angles: anglesLow, tempo: makeTempo(3) });
  assert(resultLow.score < 85, `score ${resultLow.score} < 85`);
  assertEq(resultLow.honeyBoom, false, 'honeyBoom = false when score < 85');
}

group('B5. Breakdown has exactly 7 entries');
{
  const result = scoreSwing({ angles: makeAngles(), tempo: makeTempo(3) });
  assertEq(result.breakdown.length, 7, 'breakdown.length = 7');
}

group('B6. Breakdown metric names');
{
  const result = scoreSwing({ angles: makeAngles(), tempo: makeTempo(3) });
  const names = result.breakdown.map((e) => e.metric);
  const expected = [
    'spineAngle', 'leftElbowAngle', 'rightElbowAngle',
    'leftKneeAngle', 'rightKneeAngle', 'shoulderTilt', 'tempo',
  ];
  assertEq(JSON.stringify(names), JSON.stringify(expected), 'metric names match exactly');
}

group('B7. Camera weights applied');
{
  const customWeights: MetricConfidenceWeights = {
    spineAngle: 2,
    leftElbowAngle: 1,
    rightElbowAngle: 1,
    leftKneeAngle: 1,
    rightKneeAngle: 1,
    hipSpreadDelta: 1,
    shoulderTilt: 1,
    tempo: 1,
  };
  const result = scoreSwing({ angles: makeAngles(), tempo: makeTempo(3), weights: customWeights });
  const spineEntry = result.breakdown.find((e) => e.metric === 'spineAngle')!;
  assertEq(spineEntry.weight, 2, 'spineAngle weight = 2 with custom weights');

  const elbowEntry = result.breakdown.find((e) => e.metric === 'leftElbowAngle')!;
  assertEq(elbowEntry.weight, 1, 'leftElbowAngle weight = 1 (unchanged)');
}

group('B8. Missing data halves weight');
{
  const angles = makeAngles({ spineAngle: null });
  const result = scoreSwing({ angles, tempo: makeTempo(3) });
  const spineEntry = result.breakdown.find((e) => e.metric === 'spineAngle')!;
  assertEq(spineEntry.weight, 0.5, 'null spineAngle → weight halved to 0.5');

  const elbowEntry = result.breakdown.find((e) => e.metric === 'leftElbowAngle')!;
  assertEq(elbowEntry.weight, 1, 'measured leftElbowAngle → weight stays 1');
}

group('B9. All terrible angles → score 0');
{
  const terrible: GolfAngles = {
    spineAngle: 55,       // diff=20, score=0
    leftElbowAngle: 125,  // diff=40, score=0
    rightElbowAngle: 125, // diff=40, score=0
    leftKneeAngle: 120,   // diff=35, score=0
    rightKneeAngle: 120,  // diff=35, score=0
    hipSpreadDelta: null,
    shoulderTilt: 25,      // diff=25, score=0
  };
  const result = scoreSwing({ angles: terrible, tempo: makeTempo(0) }); // ratio 0: diff=3, score=0
  assertEq(result.score, 0, 'all terrible → score 0');
  assertEq(result.honeyBoom, false, 'honeyBoom = false');
}

group('B10. Single bad angle, rest ideal → between 0 and 100');
{
  const angles = makeAngles({ spineAngle: 55 }); // spine at tolerance → score 0
  const result = scoreSwing({ angles, tempo: makeTempo(3) });
  assert(result.score < 100, `score ${result.score} < 100`);
  assert(result.score > 0, `score ${result.score} > 0`);
}

group('B11. Tempo null → tempo entry score=50, weight=0.5');
{
  const result = scoreSwing({ angles: makeAngles(), tempo: null });
  const tempoEntry = result.breakdown.find((e) => e.metric === 'tempo')!;
  assertEq(tempoEntry.score, 50, 'tempo null → score 50');
  assertEq(tempoEntry.weight, 0.5, 'tempo null → weight 0.5');
  assertEq(tempoEntry.dataQuality, 'missing', 'tempo null → missing');
}

group('B12. Breakdown entry shape validation');
{
  const result = scoreSwing({ angles: makeAngles(), tempo: makeTempo(3) });
  for (const entry of result.breakdown) {
    assert(typeof entry.metric === 'string', `${entry.metric}: metric is string`);
    assert(typeof entry.score === 'number', `${entry.metric}: score is number`);
    assert(typeof entry.weight === 'number', `${entry.metric}: weight is number`);
    assert(typeof entry.weighted === 'number', `${entry.metric}: weighted is number`);
    assert(
      entry.dataQuality === 'measured' || entry.dataQuality === 'missing',
      `${entry.metric}: dataQuality is measured|missing`,
    );
  }
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
  console.log('✅ All scoring tests passed');
}
