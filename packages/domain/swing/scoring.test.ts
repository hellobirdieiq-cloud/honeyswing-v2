/**
 * scoring.test.ts — Tests for scoreAngle, scoreTempoTrafficLight, scoreSwing
 *
 * Run with: npx --yes tsx packages/domain/swing/scoring.test.ts
 */

import {
  scoreAngle,
  scoreSwing,
  scoreTempoTrafficLight,
  isMeasured,
  TEMPO_B1_UPPER,
  TEMPO_B2_UPPER,
  TEMPO_B3_UPPER,
  TEMPO_GREEN_LOWER,
  TEMPO_GREEN_UPPER,
  TEMPO_B6_UPPER,
  TEMPO_B7_UPPER,
  TEMPO_B8_UPPER,
  TEMPO_SCORE_FAR_LOW,
  TEMPO_SCORE_LOW_3,
  TEMPO_SCORE_LOW_2,
  TEMPO_SCORE_LOW_1,
  TEMPO_SCORE_GREEN,
  TEMPO_SCORE_HIGH_1,
  TEMPO_SCORE_HIGH_2,
  TEMPO_SCORE_HIGH_3,
  TEMPO_SCORE_FAR_HIGH,
} from './scoring';
import type { GolfAngles } from './angles';
import type { SwingTempo } from './tempoAnalysis';

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
    spineDrift: null,
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

console.log('\n=== Scoring Module Tests ===');

// ---------------------------------------------------------------------------
// Section A — scoreAngle (still exported; used by VisualCoachCard, confidence)
// ---------------------------------------------------------------------------

group('A. scoreAngle');

assertEq(scoreAngle(null, 35, 20, 13.33), null, 'A1: null value → null');
assertEq(scoreAngle(35, 35, 20, 13.33), 100, 'A2: perfect match → 100');
assertEq(scoreAngle(15, 35, 20, 13.33), 0, 'A3: at under-tolerance boundary → 0');
assertEq(scoreAngle(10, 35, 20, 13.33), 0, 'A4: beyond under-tolerance → 0');
{
  const under = scoreAngle(30, 35, 10, 5);
  const over  = scoreAngle(40, 35, 10, 5);
  assert(under !== null && over !== null && over < under,
    `A5: asymmetric — over (${over}) < under (${under})`);
}
assertEq(scoreAngle(25, 35, 20, 13.33), 50, 'A6: half under-tolerance → 50');
{
  const result = scoreAngle(1000, 35, 20, 13.33);
  assert(result !== null && result === 0, `A7: extreme over clamped to 0 (got ${result})`);
}

// ---------------------------------------------------------------------------
// Section B — scoreTempoTrafficLight (9-band boundaries)
// ---------------------------------------------------------------------------

group('B. scoreTempoTrafficLight — band constants');

assertEq(TEMPO_B1_UPPER, 0.5, 'B0a: TEMPO_B1_UPPER = 0.5');
assertEq(TEMPO_B2_UPPER, 1.0, 'B0b: TEMPO_B2_UPPER = 1.0');
assertEq(TEMPO_B3_UPPER, 1.5, 'B0c: TEMPO_B3_UPPER = 1.5');
assertEq(TEMPO_GREEN_LOWER, 2.0, 'B0d: TEMPO_GREEN_LOWER = 2.0');
assertEq(TEMPO_GREEN_UPPER, 4.3, 'B0e: TEMPO_GREEN_UPPER = 4.3');
assertEq(TEMPO_B6_UPPER, 5.0, 'B0f: TEMPO_B6_UPPER = 5.0');
assertEq(TEMPO_B7_UPPER, 6.0, 'B0g: TEMPO_B7_UPPER = 6.0');
assertEq(TEMPO_B8_UPPER, 7.0, 'B0h: TEMPO_B8_UPPER = 7.0');
assertEq(TEMPO_SCORE_FAR_LOW, 25, 'B0i: TEMPO_SCORE_FAR_LOW = 25');
assertEq(TEMPO_SCORE_LOW_3, 60, 'B0j: TEMPO_SCORE_LOW_3 = 60');
assertEq(TEMPO_SCORE_LOW_2, 70, 'B0k: TEMPO_SCORE_LOW_2 = 70');
assertEq(TEMPO_SCORE_LOW_1, 80, 'B0l: TEMPO_SCORE_LOW_1 = 80');
assertEq(TEMPO_SCORE_GREEN, 100, 'B0m: TEMPO_SCORE_GREEN = 100');
assertEq(TEMPO_SCORE_HIGH_1, 90, 'B0n: TEMPO_SCORE_HIGH_1 = 90');
assertEq(TEMPO_SCORE_HIGH_2, 75, 'B0o: TEMPO_SCORE_HIGH_2 = 75');
assertEq(TEMPO_SCORE_HIGH_3, 60, 'B0p: TEMPO_SCORE_HIGH_3 = 60');
assertEq(TEMPO_SCORE_FAR_HIGH, 25, 'B0q: TEMPO_SCORE_FAR_HIGH = 25');

group('B. scoreTempoTrafficLight — band 1 (ratio < 0.5)');

assertEq(scoreTempoTrafficLight(0).score, TEMPO_SCORE_FAR_LOW, 'B1a: ratio 0 → 25');
assertEq(scoreTempoTrafficLight(0).isGreen, false, 'B1b: ratio 0 → isGreen false');
assertEq(scoreTempoTrafficLight(0.25).score, TEMPO_SCORE_FAR_LOW, 'B1c: ratio 0.25 → 25');
assertEq(scoreTempoTrafficLight(0.49).score, TEMPO_SCORE_FAR_LOW, 'B1d: ratio 0.49 → 25');

group('B. scoreTempoTrafficLight — band 2 (0.5 ≤ ratio < 1.0)');

assertEq(scoreTempoTrafficLight(0.5).score, TEMPO_SCORE_LOW_3, 'B2a: ratio 0.5 → 60');
assertEq(scoreTempoTrafficLight(0.5).isGreen, false, 'B2b: ratio 0.5 → isGreen false');
assertEq(scoreTempoTrafficLight(0.75).score, TEMPO_SCORE_LOW_3, 'B2c: ratio 0.75 → 60');
assertEq(scoreTempoTrafficLight(0.99).score, TEMPO_SCORE_LOW_3, 'B2d: ratio 0.99 → 60');

group('B. scoreTempoTrafficLight — band 3 (1.0 ≤ ratio < 1.5)');

assertEq(scoreTempoTrafficLight(1.0).score, TEMPO_SCORE_LOW_2, 'B3a: ratio 1.0 → 70');
assertEq(scoreTempoTrafficLight(1.0).isGreen, false, 'B3b: ratio 1.0 → isGreen false');
assertEq(scoreTempoTrafficLight(1.25).score, TEMPO_SCORE_LOW_2, 'B3c: ratio 1.25 → 70');
assertEq(scoreTempoTrafficLight(1.49).score, TEMPO_SCORE_LOW_2, 'B3d: ratio 1.49 → 70');

group('B. scoreTempoTrafficLight — band 4 (1.5 ≤ ratio < 2.0)');

assertEq(scoreTempoTrafficLight(1.5).score, TEMPO_SCORE_LOW_1, 'B4a: ratio 1.5 → 80');
assertEq(scoreTempoTrafficLight(1.5).isGreen, false, 'B4b: ratio 1.5 → isGreen false');
assertEq(scoreTempoTrafficLight(1.75).score, TEMPO_SCORE_LOW_1, 'B4c: ratio 1.75 → 80');
assertEq(scoreTempoTrafficLight(1.99).score, TEMPO_SCORE_LOW_1, 'B4d: ratio 1.99 → 80');

group('B. scoreTempoTrafficLight — band 5 GREEN (2.0 ≤ ratio ≤ 4.3)');

assertEq(scoreTempoTrafficLight(2.0).score, TEMPO_SCORE_GREEN, 'B5a: ratio 2.0 → 100');
assertEq(scoreTempoTrafficLight(2.0).isGreen, true, 'B5b: ratio 2.0 → isGreen true');
assertEq(scoreTempoTrafficLight(3.0).score, TEMPO_SCORE_GREEN, 'B5c: ratio 3.0 → 100');
assertEq(scoreTempoTrafficLight(3.0).isGreen, true, 'B5d: ratio 3.0 → isGreen true');
assertEq(scoreTempoTrafficLight(4.3).score, TEMPO_SCORE_GREEN, 'B5e: ratio 4.3 → 100');
assertEq(scoreTempoTrafficLight(4.3).isGreen, true, 'B5f: ratio 4.3 → isGreen true');

group('B. scoreTempoTrafficLight — band 6 (4.3 < ratio ≤ 5.0)');

assertEq(scoreTempoTrafficLight(4.31).score, TEMPO_SCORE_HIGH_1, 'B6a: ratio 4.31 → 90');
assertEq(scoreTempoTrafficLight(4.31).isGreen, false, 'B6b: ratio 4.31 → isGreen false');
assertEq(scoreTempoTrafficLight(4.65).score, TEMPO_SCORE_HIGH_1, 'B6c: ratio 4.65 → 90');
assertEq(scoreTempoTrafficLight(5.0).score, TEMPO_SCORE_HIGH_1, 'B6d: ratio 5.0 → 90');

group('B. scoreTempoTrafficLight — band 7 (5.0 < ratio ≤ 6.0)');

assertEq(scoreTempoTrafficLight(5.01).score, TEMPO_SCORE_HIGH_2, 'B7a: ratio 5.01 → 75');
assertEq(scoreTempoTrafficLight(5.5).score, TEMPO_SCORE_HIGH_2, 'B7b: ratio 5.5 → 75');
assertEq(scoreTempoTrafficLight(6.0).score, TEMPO_SCORE_HIGH_2, 'B7c: ratio 6.0 → 75');

group('B. scoreTempoTrafficLight — band 8 (6.0 < ratio ≤ 7.0)');

assertEq(scoreTempoTrafficLight(6.01).score, TEMPO_SCORE_HIGH_3, 'B8a: ratio 6.01 → 60');
assertEq(scoreTempoTrafficLight(6.5).score, TEMPO_SCORE_HIGH_3, 'B8b: ratio 6.5 → 60');
assertEq(scoreTempoTrafficLight(7.0).score, TEMPO_SCORE_HIGH_3, 'B8c: ratio 7.0 → 60');

group('B. scoreTempoTrafficLight — band 9 (ratio > 7.0)');

assertEq(scoreTempoTrafficLight(7.01).score, TEMPO_SCORE_FAR_HIGH, 'B9a: ratio 7.01 → 25');
assertEq(scoreTempoTrafficLight(7.01).isGreen, false, 'B9b: ratio 7.01 → isGreen false');
assertEq(scoreTempoTrafficLight(10).score, TEMPO_SCORE_FAR_HIGH, 'B9c: ratio 10 → 25');
assertEq(scoreTempoTrafficLight(100).score, TEMPO_SCORE_FAR_HIGH, 'B9d: ratio 100 → 25');

group('B. scoreTempoTrafficLight — isGreen contract');

// isGreen must be true if and only if score === TEMPO_SCORE_GREEN
{
  const ratios = [0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.3, 4.31, 5.0, 6.0, 7.0, 10];
  for (const r of ratios) {
    const result = scoreTempoTrafficLight(r);
    assertEq(
      result.isGreen,
      result.score === TEMPO_SCORE_GREEN,
      `B10@${r}: isGreen === (score === 100)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Section C — scoreSwing (tempo-only result)
// ---------------------------------------------------------------------------

group('C. scoreSwing — null tempo');
{
  const result = scoreSwing({ angles: makeAngles(), tempo: null });
  assertEq(result.score, null, 'C1: null tempo → score null');
  assertEq(result.honeyBoom, false, 'C2: null tempo → honeyBoom false');
  assertEq(result.breakdown.length, 1, 'C3: breakdown has 1 entry (tempo placeholder)');
  assertEq(result.breakdown[0].metric, 'tempo', 'C4: breakdown[0].metric = tempo');
  assertEq(result.breakdown[0].dataQuality, 'missing', 'C5: tempo dataQuality missing');
}

group('C. scoreSwing — green band');
{
  const result = scoreSwing({ angles: makeAngles(), tempo: makeTempo(3.0) });
  assertEq(result.score, TEMPO_SCORE_GREEN, 'C6: ratio 3.0 → score 100');
  assertEq(result.honeyBoom, true, 'C7: green band → honeyBoom true');
  assertEq(result.breakdown.length, 1, 'C8: breakdown has 1 entry');
  assertEq(result.breakdown[0].metric, 'tempo', 'C9: breakdown[0].metric = tempo');
  assertEq(result.breakdown[0].score, TEMPO_SCORE_GREEN, 'C10: breakdown tempo score = 100');
  assertEq(result.breakdown[0].dataQuality, 'measured', 'C11: tempo dataQuality measured');
  assert(isMeasured(result.breakdown[0]), 'C12: isMeasured() returns true for tempo');
}

group('C. scoreSwing — non-green bands propagate score & honeyBoom=false');
{
  const b1 = scoreSwing({ angles: makeAngles(), tempo: makeTempo(0.25) });
  assertEq(b1.score, TEMPO_SCORE_FAR_LOW, 'C13a: ratio 0.25 → score 25');
  assertEq(b1.honeyBoom, false, 'C13b: ratio 0.25 → honeyBoom false');

  const b2 = scoreSwing({ angles: makeAngles(), tempo: makeTempo(0.75) });
  assertEq(b2.score, TEMPO_SCORE_LOW_3, 'C14a: ratio 0.75 → score 60');
  assertEq(b2.honeyBoom, false, 'C14b: ratio 0.75 → honeyBoom false');

  const b3 = scoreSwing({ angles: makeAngles(), tempo: makeTempo(1.25) });
  assertEq(b3.score, TEMPO_SCORE_LOW_2, 'C15a: ratio 1.25 → score 70');
  assertEq(b3.honeyBoom, false, 'C15b: ratio 1.25 → honeyBoom false');

  const b4 = scoreSwing({ angles: makeAngles(), tempo: makeTempo(1.75) });
  assertEq(b4.score, TEMPO_SCORE_LOW_1, 'C16a: ratio 1.75 → score 80');
  assertEq(b4.honeyBoom, false, 'C16b: ratio 1.75 → honeyBoom false');

  const b6 = scoreSwing({ angles: makeAngles(), tempo: makeTempo(4.65) });
  assertEq(b6.score, TEMPO_SCORE_HIGH_1, 'C17a: ratio 4.65 → score 90');
  assertEq(b6.honeyBoom, false, 'C17b: ratio 4.65 → honeyBoom false');

  const b7 = scoreSwing({ angles: makeAngles(), tempo: makeTempo(5.5) });
  assertEq(b7.score, TEMPO_SCORE_HIGH_2, 'C18a: ratio 5.5 → score 75');
  assertEq(b7.honeyBoom, false, 'C18b: ratio 5.5 → honeyBoom false');

  const b8 = scoreSwing({ angles: makeAngles(), tempo: makeTempo(6.5) });
  assertEq(b8.score, TEMPO_SCORE_HIGH_3, 'C19a: ratio 6.5 → score 60');
  assertEq(b8.honeyBoom, false, 'C19b: ratio 6.5 → honeyBoom false');

  const b9 = scoreSwing({ angles: makeAngles(), tempo: makeTempo(10) });
  assertEq(b9.score, TEMPO_SCORE_FAR_HIGH, 'C20a: ratio 10 → score 25');
  assertEq(b9.honeyBoom, false, 'C20b: ratio 10 → honeyBoom false');
}

group('C. scoreSwing — angles ignored');
{
  // Angles wildly off, tempo in green → still 100. Confirms tempo-only contract.
  const terribleAngles: GolfAngles = {
    spineAngle: 100,
    leftElbowAngle: 50,
    rightElbowAngle: 50,
    leftKneeAngle: 50,
    rightKneeAngle: 50,
    hipSpreadDelta: null,
    shoulderTilt: 100,
    spineDrift: null,
  };
  const result = scoreSwing({ angles: terribleAngles, tempo: makeTempo(3.0) });
  assertEq(result.score, TEMPO_SCORE_GREEN, 'C21: terrible angles, green tempo → 100');
  assertEq(result.honeyBoom, true, 'C22: green tempo → honeyBoom true regardless of angles');
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
