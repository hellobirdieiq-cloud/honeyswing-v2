/**
 * scoring.test.ts — Comprehensive tests for scoreAngle and scoreSwing
 *
 * Run with: npx --yes tsx packages/domain/swing/scoring.test.ts
 */

import { scoreAngle, scoreSwing, isMeasured, type ScoringBreakdownEntry } from './scoring';
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
// Section A — scoreAngle (4-arg, asymmetric, null-return)
// ---------------------------------------------------------------------------

console.log('\n=== Scoring Module Tests ===');

group('A. scoreAngle');

// A1: null value → null (was 50 pre-SCR-0b-1)
assertEq(scoreAngle(null, 35, 20, 13.33), null, 'A1: null value → null');

// A2: Perfect match
assertEq(scoreAngle(35, 35, 20, 13.33), 100, 'A2: perfect match → 100');

// A3: At under-tolerance boundary (below ideal)
assertEq(scoreAngle(15, 35, 20, 13.33), 0, 'A3: at under-tolerance boundary → 0');

// A4: Beyond under-tolerance
assertEq(scoreAngle(10, 35, 20, 13.33), 0, 'A4: beyond under-tolerance → 0');

// A5: Asymmetric — equal-magnitude over-shoot scores LOWER than under-shoot
{
  const under = scoreAngle(30, 35, 10, 5);  // -5 from ideal, U=10 → 50
  const over  = scoreAngle(40, 35, 10, 5);  // +5 from ideal, O=5  → 0
  assert(under !== null && over !== null && over < under,
    `A5: asymmetric — over (${over}) < under (${under})`);
}

// A6: Half under-tolerance
assertEq(scoreAngle(25, 35, 20, 13.33), 50, 'A6: half under-tolerance → 50');

// A7: Asymmetric — over and under are NOT equal at equal magnitude (replaces old symmetry test)
{
  const under = scoreAngle(25, 35, 20, 13.33);  // -10 from ideal, U=20 → 50
  const over  = scoreAngle(45, 35, 20, 13.33);  // +10 from ideal, O=13.33 → 25
  assert(under !== null && over !== null && over < under,
    `A7: equal-magnitude over (${over}) scores LOWER than under (${under})`);
}

// A8: Negative angle
assertEq(scoreAngle(-5, 0, 25, 16.67), 80, 'A8: negative angle (-5,0,25,16.67) → 80');

// A9: Large ideal elbow
assertEq(scoreAngle(165, 165, 40, 26.67), 100, 'A9: large ideal elbow → 100');

// A10: Tolerance=0, exact match → NaN (0/0 in JS) — preserves old A10 behavior
{
  const result = scoreAngle(35, 35, 0, 0);
  assert(result !== null && Number.isNaN(result),
    `A10: tolerance=0 exact match → NaN (got ${result})`);
}

// A11: Under-tolerance=0, not exact (under) → 0
assertEq(scoreAngle(34, 35, 0, 5), 0, 'A11: under-tolerance=0, below ideal → 0');

// A12: Clamp — extreme deviation never goes negative
{
  const result = scoreAngle(1000, 35, 20, 13.33);
  assert(result !== null && result === 0, `A12: extreme over (1000,35,20,13.33) → 0 (got ${result})`);
}

// A13: Tempo ratio perfect (symmetric, U==O)
assertEq(scoreAngle(3, 3, 1.5, 1.5), 100, 'A13: tempo ratio perfect → 100');

// A14: Tempo ratio bad
assertEq(scoreAngle(1, 3, 1.5, 1.5), 0, 'A14: tempo ratio bad → 0');

// ---------------------------------------------------------------------------
// Section B — scoreSwing (null-exclude, honeyBoom coverage gate)
// ---------------------------------------------------------------------------

group('B1. All ideal + perfect tempo → 100, honeyBoom=true');
{
  const result = scoreSwing({ angles: makeAngles(), tempo: makeTempo(3) });
  // SCR-0b-2 asymmetric tempo + shoulderTilt removed from scoring aggregate (V85 PART 9 diagnostic-only). 5 ideal angles + tempo(3)=81; aggregate=(500+81)/6=round(96.83)=97.
  assertEq(result.score, 97, 'score = 97');
  assertEq(result.honeyBoom, true, 'honeyBoom = true');
}

group('B2. All null angles + null tempo → score:null, honeyBoom=false');
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
  assertEq(result.score, null, 'score = null (was 50 pre-SCR-0b-1)');
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

group('B4. HoneyBoom — score >= 85 AND coverage >= ceil(6*0.7)=5 measured');
{
  // 6 measured at perfect → score 100, honeyBoom true
  const result7 = scoreSwing({ angles: makeAngles(), tempo: makeTempo(3) });
  assertEq(result7.honeyBoom, true, '6 of 6 measured at 100 → honeyBoom true');

  // 2 of 6 measured at ideal — score ~100 but coverage < 5 → honeyBoom false
  const angles4Missing = makeAngles({
    leftElbowAngle: null,
    rightElbowAngle: null,
    leftKneeAngle: null,
  });
  const result4 = scoreSwing({ angles: angles4Missing, tempo: null });
  // measured = spineAngle, rightKneeAngle = 2 (tempo null too) — should be honeyBoom=false on coverage
  assert(result4.honeyBoom === false,
    `coverage gate: ${result4.breakdown.filter((e) => e.dataQuality === 'measured').length} measured → honeyBoom false`);

  // Score < 85 → honeyBoom false even with full coverage
  const anglesLow = makeAngles({ spineAngle: 50, leftElbowAngle: 140, leftKneeAngle: 130 });
  const resultLow = scoreSwing({ angles: anglesLow, tempo: makeTempo(3) });
  assert(resultLow.score !== null && resultLow.score < 85, `score ${resultLow.score} < 85`);
  assertEq(resultLow.honeyBoom, false, 'honeyBoom = false when score < 85');
}

group('B5. Breakdown has exactly 6 entries');
{
  const result = scoreSwing({ angles: makeAngles(), tempo: makeTempo(3) });
  assertEq(result.breakdown.length, 6, 'breakdown.length = 6');
}

group('B6. Breakdown metric names');
{
  const result = scoreSwing({ angles: makeAngles(), tempo: makeTempo(3) });
  const names = result.breakdown.map((e) => e.metric);
  const expected = [
    'spineAngle', 'leftElbowAngle', 'rightElbowAngle',
    'leftKneeAngle', 'rightKneeAngle', 'tempo',
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

// B8 (weight halving) — REMOVED: behavior gone in SCR-0b-1.

group('B9. All terrible angles → score 0');
{
  const terrible: GolfAngles = {
    spineAngle: 100,        // way over → 0
    leftElbowAngle: 50,     // way under → 0
    rightElbowAngle: 50,    // way under → 0
    leftKneeAngle: 50,      // way under → 0
    rightKneeAngle: 50,     // way under → 0
    hipSpreadDelta: null,
    shoulderTilt: 100,      // way over → 0
  };
  const result = scoreSwing({ angles: terrible, tempo: makeTempo(0) }); // ratio 0: way under → 0
  assertEq(result.score, 0, 'all terrible → score 0');
  assertEq(result.honeyBoom, false, 'honeyBoom = false');
}

group('B10. Single bad angle, rest ideal → between 0 and 100');
{
  const angles = makeAngles({ spineAngle: 100 }); // way over → score 0 contribution
  const result = scoreSwing({ angles, tempo: makeTempo(3) });
  assert(result.score !== null && result.score < 100, `score ${result.score} < 100`);
  assert(result.score !== null && result.score > 0, `score ${result.score} > 0`);
}

group('B11. Tempo null → tempo entry score=0, dataQuality=missing, weight unchanged');
{
  const result = scoreSwing({ angles: makeAngles(), tempo: null });
  const tempoEntry = result.breakdown.find((e) => e.metric === 'tempo')!;
  assertEq(tempoEntry.score, 0, 'tempo null → score 0 (coerced; F-v2-2)');
  assertEq(tempoEntry.weight, 1, 'tempo null → weight 1 (no halving in SCR-0b-1)');
  assertEq(tempoEntry.weighted, 0, 'tempo null → weighted 0');
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
// Section D — D4 spec assertions (SCR-0b-1)
// ---------------------------------------------------------------------------

group('D1. scoreAngle(null,...) returns null');
assertEq(scoreAngle(null, 35, 20, 13.33), null, 'D1: null → null');

group('D2. Asymmetric over < under at equal magnitude');
{
  const under = scoreAngle(35 - 5, 35, 10, 5);  // 50
  const over  = scoreAngle(35 + 5, 35, 10, 5);  // 0
  assert(under !== null && over !== null && over < under, `D2: over (${over}) < under (${under})`);
}

group('D3. scoreAngle(ideal, ideal, U, O) returns 100');
assertEq(scoreAngle(35, 35, 20, 13.33), 100, 'D3: at ideal → 100');

group('D4. Clamps — extreme deviation returns 0, never negative');
{
  const r1 = scoreAngle(1000, 35, 20, 13.33);
  const r2 = scoreAngle(-1000, 35, 20, 13.33);
  assert(r1 === 0, `D4a: extreme over → 0 (got ${r1})`);
  assert(r2 === 0, `D4b: extreme under → 0 (got ${r2})`);
}

group('D5. One null angle → aggregate ignores null');
{
  // 5 measured angles ideal + tempo measured = 6 entries total; one angle set to null
  const angles = makeAngles({ leftElbowAngle: null });
  const result = scoreSwing({ angles, tempo: makeTempo(3) });
  // shoulderTilt removed from scoring aggregate (V85 PART 9); leftElbow null → 4 ideal angles + tempo(3)=81; aggregate=(400+81)/5=round(96.2)=96.
  assertEq(result.score, 96, 'D5: aggregate ≈ 96 (4 ideal + tempo at ratio 3)');
  const elbowEntry = result.breakdown.find((e) => e.metric === 'leftElbowAngle')!;
  assertEq(elbowEntry.dataQuality, 'missing', 'D5: leftElbowAngle dataQuality = missing');
}

group('D6. All angles + tempo null → score: null');
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
  assertEq(result.score, null, 'D6: all null → score null');
}

group('D7. 3 of 6 measured → honeyBoom false (3 < ceil(6*0.7)=5)');
{
  // 2 angles + tempo measured; 3 angles missing (shoulderTilt removed from scoring aggregate)
  const angles = makeAngles({
    spineAngle: null,
    leftElbowAngle: null,
    rightElbowAngle: null,
    leftKneeAngle: 145,   // diff 10 from ideal 155, under-tol 35 → ~71
    rightKneeAngle: 152,  // diff 3 from ideal 155, under-tol 35 → ~91
  });
  // Use tempoRatio that scores 90 from ideal 3, tol 1.5 → diff 0.15
  const result = scoreSwing({ angles, tempo: makeTempo(3.15) });
  const measuredCount = result.breakdown.filter((e) => e.dataQuality === 'measured').length;
  assertEq(measuredCount, 3, `D7: measured count = 3 (got ${measuredCount})`);
  assertEq(result.honeyBoom, false, 'D7: honeyBoom = false (coverage < 5)');
}

group('D8. 5 of 6 measured at >=90 + score >= 85 → honeyBoom true');
{
  // 5 measured at strong score; 1 missing (shoulderTilt removed from scoring aggregate)
  const angles = makeAngles({
    spineAngle: null,
    // remaining: leftElbowAngle, rightElbowAngle, leftKneeAngle, rightKneeAngle at ideal → 100 each
  });
  // tempo at ideal → 100
  const result = scoreSwing({ angles, tempo: makeTempo(3) });
  const measuredCount = result.breakdown.filter((e) => e.dataQuality === 'measured').length;
  assertEq(measuredCount, 5, `D8: measured count = 5 (got ${measuredCount})`);
  assert(result.score !== null && result.score >= 85, `D8: score ${result.score} >= 85`);
  assertEq(result.honeyBoom, true, 'D8: honeyBoom = true');
}

group('D9. All 7 at 84 → honeyBoom false (score < 85)');
{
  // tune values to land aggregate score ≈ 84 with full coverage
  const angles = makeAngles({
    spineAngle: 38.2,       // diff 3.2 / over-tol 13.33 → ~76
    leftElbowAngle: 158,    // diff -7 / under-tol 40 → ~83
    rightElbowAngle: 158,
    leftKneeAngle: 149,     // diff -6 / under-tol 35 → ~83
    rightKneeAngle: 149,
    shoulderTilt: 4,        // diff +4 / over-tol 16.67 → ~76
  });
  const result = scoreSwing({ angles, tempo: makeTempo(3.24) }); // diff 0.24 / 1.5 → ~84
  // exact targeting is approximate; the contract tested is "score < 85 AND honeyBoom false"
  if (result.score !== null && result.score < 85) {
    assertEq(result.honeyBoom, false, 'D9: score < 85 → honeyBoom false');
  } else {
    assert(false, `D9: tuning landed score ${result.score} (need < 85 to test gate)`);
  }
}

group('D10. Missing inputs → breakdown row score=0, weighted=0, dataQuality=missing');
{
  const angles = makeAngles({ spineAngle: null });
  const result = scoreSwing({ angles, tempo: makeTempo(3) });
  const spineEntry = result.breakdown.find((e) => e.metric === 'spineAngle')!;
  assertEq(spineEntry.score, 0, 'D10: missing → score 0 (coerced)');
  assertEq(spineEntry.weighted, 0, 'D10: missing → weighted 0');
  assertEq(spineEntry.dataQuality, 'missing', 'D10: missing → dataQuality missing');
}

group('D11. isMeasured helper');
{
  const result = scoreSwing({ angles: makeAngles({ spineAngle: null }), tempo: makeTempo(3) });
  const spineEntry = result.breakdown.find((e) => e.metric === 'spineAngle')!;
  const tempoEntry = result.breakdown.find((e) => e.metric === 'tempo')!;
  assertEq(isMeasured(spineEntry), false, 'D11: missing entry → false');
  assertEq(isMeasured(tempoEntry), true, 'D11: measured entry → true');
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
