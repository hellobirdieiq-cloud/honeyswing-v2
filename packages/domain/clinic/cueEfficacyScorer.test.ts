/**
 * cueEfficacyScorer.test.ts — Cue efficacy scoring validation
 *
 * Run with: npx tsx packages/domain/clinic/cueEfficacyScorer.test.ts
 *
 * Covers:
 *   - scoreAccommodation returns 0 when no movement
 *   - scoreAccommodation returns 1 when metric fully reaches target
 *   - scoreRetention returns null when retentionSwings is empty
 *   - scoreCueBlock produces a CueEfficacyScore with all required fields
 */

import {
  scoreAccommodation,
  scoreRetention,
  scoreCueBlock,
  type CueEfficacyScore,
} from './cueEfficacyScorer';
import type { SwingRecord, MetricSnapshot } from './SwingRecord';
import type { CueBlockRecord } from './CueBlock';

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

function assertClose(actual: number, expected: number, label: string, tol = 1e-6): void {
  assert(
    Math.abs(actual - expected) <= tol,
    `${label} (got ${actual}, expected ≈${expected} ± ${tol})`,
  );
}

function safeCall<T>(label: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    console.log(`  ❌ FAIL: ${label} threw ${(err as Error).message}`);
    failed++;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMetrics(spineAngle: number): MetricSnapshot {
  return {
    spineAngle,
    spineDrift: null,
    tempoRatio: null,
    hipSpreadDelta: null,
    leftElbowAngle: null,
    rightElbowAngle: null,
    leftKneeAngle: null,
    rightKneeAngle: null,
    shoulderTilt: null,
  };
}

function makeSwing(id: string, spineAngle: number): SwingRecord {
  return {
    id,
    kidId: 'kid-1',
    sessionId: 'session-1',
    clinicNumber: 1,
    recordedAt: 1700000000000,
    metrics: makeMetrics(spineAngle),
    phaseTags: [],
    setupOk: true,
    effortLevel: 'medium',
    normalSwing: true,
    structuralProblem: 'none',
    ballOutcome: { direction: 'straight', contact: 'flush' },
  };
}

function makeCueBlock(id: string): CueBlockRecord {
  return {
    id,
    kidId: 'kid-1',
    sessionId: 'session-1',
    clinicNumber: 1,
    recordedAt: 1700000000000,
    cueText: 'Keep your spine angle steady through impact.',
    cueFamily: 'spine-stability',
    prediction: { direction: 'straight', contact: 'flush', confidence: 0.7 },
    attentionIntent: 'spine',
    attentionActual: 'spine',
    postCueSwingIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
    retentionProbeSwingIds: ['r1', 'r2'],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

group('scoreAccommodation returns 0 when no movement');
{
  // baseline mean = 15, postCue mean = 15 → no movement toward target=25 → 0.
  const baseline = [makeSwing('b1', 15), makeSwing('b2', 15), makeSwing('b3', 15)];
  const postCue = [
    makeSwing('p1', 15), makeSwing('p2', 15), makeSwing('p3', 15),
    makeSwing('p4', 15), makeSwing('p5', 15),
  ];
  const score = safeCall('scoreAccommodation',
    () => scoreAccommodation(baseline, postCue, 'spineAngle', 25));
  if (score !== undefined) assertEq(score, 0, 'no movement → 0');
}

group('scoreAccommodation returns 1 when metric fully reaches target');
{
  // baseline mean = 15, target = 25, postCue mean = 25 → fully reached → 1.
  const baseline = [makeSwing('b1', 15), makeSwing('b2', 15), makeSwing('b3', 15)];
  const postCue = [
    makeSwing('p1', 25), makeSwing('p2', 25), makeSwing('p3', 25),
    makeSwing('p4', 25), makeSwing('p5', 25),
  ];
  const score = safeCall('scoreAccommodation',
    () => scoreAccommodation(baseline, postCue, 'spineAngle', 25));
  if (score !== undefined) assertClose(score, 1, 'fully reaches target → 1');
}

group('scoreRetention returns null when retentionSwings is empty');
{
  const postCue = [makeSwing('p1', 25), makeSwing('p2', 25)];
  const result = safeCall('scoreRetention with []',
    () => scoreRetention(postCue, [], 'spineAngle'));
  if (result !== undefined) assertEq(result, null, 'empty retention → null');
}

group('scoreCueBlock produces a CueEfficacyScore with all required fields');
{
  const block = makeCueBlock('cb-1');
  const baseline = [makeSwing('b1', 15), makeSwing('b2', 15), makeSwing('b3', 15)];
  const postCue = [
    makeSwing('p1', 20), makeSwing('p2', 20), makeSwing('p3', 20),
    makeSwing('p4', 20), makeSwing('p5', 20),
  ];
  const retention = [makeSwing('r1', 19), makeSwing('r2', 21)];
  const result = safeCall('scoreCueBlock',
    () => scoreCueBlock(block, baseline, postCue, retention, 'spineAngle', 25));
  if (result) {
    const r = result as CueEfficacyScore;
    assertEq(r.cueBlockId, 'cb-1', 'cueBlockId propagated');
    assertEq(r.metric, 'spineAngle', 'metric propagated');
    assert(typeof r.baselineAverage === 'number', 'baselineAverage is number');
    assert(typeof r.postCueAverage === 'number', 'postCueAverage is number');
    assert(r.retentionAverage === null || typeof r.retentionAverage === 'number',
      'retentionAverage is number or null');
    assert(typeof r.accommodation === 'number', 'accommodation is number');
    assert(r.retention === null || typeof r.retention === 'number',
      'retention is number or null');
    assert(typeof r.metricMovement === 'number', 'metricMovement is number');
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
  console.log('✅ All tests passed — cueEfficacyScorer validated');
}
