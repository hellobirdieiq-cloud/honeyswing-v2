/**
 * tempoAnalysis.test.ts — Tests for calculateTempo and isTempoTrustworthy
 *
 * Every expected value is derived from tempoAnalysis.ts source:
 *   - <5 phases → null                       (tempoAnalysis.ts:57)
 *   - missing named phase → null             (tempoAnalysis.ts:67)
 *   - backswing/downswing = top−takeaway / impact−top, total = finish−takeaway
 *                                            (tempoAnalysis.ts:72-74)
 *   - non-positive segment → null            (tempoAnalysis.ts:76)
 *   - ratio rounded to 2dp                   (tempoAnalysis.ts:80)
 *   - rating bands (inclusive upper bounds, tempoAnalysis.ts:25-31, <= at :51):
 *       ≤1.5 rushed | ≤2.5 fast | ≤3.5 good | ≤4.5 slow | else very_slow
 *   - TEMPO_MIN_PHASE_MS = 120, strict <     (tempoAnalysis.ts:106, :126)
 *   - TEMPO_MIN_RATIO = 0.5 / TEMPO_MAX_RATIO = 10, strict </> (tempoAnalysis.ts:110-111, :129)
 *
 * Run with: npx --yes tsx packages/domain/swing/tempoAnalysis.test.ts
 */

import {
  calculateTempo,
  isTempoTrustworthy,
  TEMPO_MIN_PHASE_MS,
  TEMPO_MIN_RATIO,
  TEMPO_MAX_RATIO,
} from './tempoAnalysis';
import type { SwingTempo, TempoRating } from './tempoAnalysis';
import type { DetectedPhase, SwingPhase, SwingTrailPoint } from './phaseDetection';

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

function trailPoint(timestamp: number): SwingTrailPoint {
  return { x: 0.5, y: 0.5, timestamp, leadX: 0.52, leadY: 0.5, trailX: 0.48, trailY: 0.5 };
}

function phase(
  name: SwingPhase,
  timestamp: number,
  source: 'heuristic' | 'fallback' = 'heuristic',
): DetectedPhase {
  return {
    phase: name,
    label: name,
    point: trailPoint(timestamp),
    index: 0,
    timestamp,
    source,
  };
}

/** The five phases calculateTempo reads, at the given timestamps. */
function makePhases(ts: {
  takeaway: number;
  top: number;
  downswing: number;
  impact: number;
  follow_through: number;
}): DetectedPhase[] {
  return [
    phase('takeaway', ts.takeaway),
    phase('top', ts.top),
    phase('downswing', ts.downswing),
    phase('impact', ts.impact),
    phase('follow_through', ts.follow_through),
  ];
}

/** Phases producing exactly backswingMs/downswingMs (ratio = their quotient). */
function phasesForSegments(backswingMs: number, downswingMs: number): DetectedPhase[] {
  return makePhases({
    takeaway: 0,
    top: backswingMs,
    downswing: backswingMs + 1,
    impact: backswingMs + downswingMs,
    follow_through: backswingMs + downswingMs + 300,
  });
}

function makeTempo(overrides: Partial<SwingTempo> = {}): SwingTempo {
  return {
    backswingMs: 850,
    downswingMs: 300,
    tempoRatio: 2.83,
    totalSwingMs: 1600,
    tempoRating: 'good',
    phaseTimestamps: { takeaway: 0 } as SwingTempo['phaseTimestamps'],
    ...overrides,
  };
}

const HEURISTIC_SOURCES = [{ source: 'heuristic' as const }, { source: 'heuristic' as const }];

console.log('\n=== Tempo Analysis Module Tests ===');

// ---------------------------------------------------------------------------
// Section A — calculateTempo guards
// ---------------------------------------------------------------------------

group('A. calculateTempo guards');

assertEq(
  calculateTempo(makePhases({ takeaway: 0, top: 850, downswing: 851, impact: 1150, follow_through: 1450 }).slice(0, 4)),
  null,
  'A1: fewer than 5 phases → null (tempoAnalysis.ts:57)',
);
{
  // 5 phases, but follow_through replaced by a duplicate impact → named-phase guard fires.
  // (SwingPhase has exactly 5 members — phaseDetection.ts:33-38 — so a "missing
  // phase at length 5" can only be built with a duplicate of another member.)
  const phases = makePhases({ takeaway: 0, top: 850, downswing: 851, impact: 1150, follow_through: 1450 });
  phases[4] = phase('impact', 1450);
  assertEq(calculateTempo(phases), null, 'A2: 5 phases but follow_through missing → null (:67)');
}
{
  const phases = makePhases({ takeaway: 0, top: 850, downswing: 851, impact: 1150, follow_through: 1450 });
  phases[0] = phase('downswing', 0);
  assertEq(calculateTempo(phases), null, 'A3: 5 phases but takeaway missing → null (:67)');
}
assertEq(
  calculateTempo(makePhases({ takeaway: 500, top: 500, downswing: 600, impact: 800, follow_through: 1100 })),
  null,
  'A4: backswingMs = 0 (top at takeaway timestamp) → null (:76)',
);
assertEq(
  calculateTempo(makePhases({ takeaway: 0, top: 900, downswing: 950, impact: 850, follow_through: 1400 })),
  null,
  'A5: downswingMs < 0 (impact before top) → null (:76)',
);

// ---------------------------------------------------------------------------
// Section B — calculateTempo arithmetic
// ---------------------------------------------------------------------------

group('B. calculateTempo arithmetic');

{
  // takeaway 200 / top 1050 / impact 1350 / finish 1800
  // backswing = 1050−200 = 850; downswing = 1350−1050 = 300; total = 1800−200 = 1600
  // ratio = 850/300 = 2.8333… → 2.83 (rounded 2dp, :80); 2.83 ≤ 3.5 → good
  const tempo = calculateTempo(
    makePhases({ takeaway: 200, top: 1050, downswing: 1100, impact: 1350, follow_through: 1800 }),
  );
  assert(tempo !== null, 'B1: complete phase set → non-null');
  assertEq(tempo?.backswingMs, 850, 'B2: backswingMs = top − takeaway (:72)');
  assertEq(tempo?.downswingMs, 300, 'B3: downswingMs = impact − top (:73)');
  assertEq(tempo?.totalSwingMs, 1600, 'B4: totalSwingMs = follow_through − takeaway (:74)');
  assertEq(tempo?.tempoRatio, 2.83, 'B5: ratio 850/300 rounds to 2.83 (:80)');
  assertEq(tempo?.tempoRating, 'good' as TempoRating, 'B6: 2.83 rates good (band ≤3.5, :28)');
  assertEq(tempo?.phaseTimestamps.takeaway, 200, 'B7: phaseTimestamps.takeaway echoed (:84)');
  assertEq(tempo?.phaseTimestamps.downswing, 1100, 'B8: phaseTimestamps.downswing echoed (:86)');
  assertEq(tempo?.phaseTimestamps.follow_through, 1800, 'B9: phaseTimestamps.follow_through echoed (:88)');
}
{
  // 800/700 = 1.142857… → 1.14
  const tempo = calculateTempo(phasesForSegments(800, 700));
  assertEq(tempo?.tempoRatio, 1.14, 'B10: 800/700 rounds to 1.14 (:80)');
}
{
  // Extra trailing duplicate takeaway must not disturb the named lookups (find, :61)
  const phases = makePhases({ takeaway: 200, top: 1050, downswing: 1100, impact: 1350, follow_through: 1800 });
  phases.push(phase('takeaway', 999));
  const tempo = calculateTempo(phases);
  assertEq(tempo?.backswingMs, 850, 'B11: duplicate trailing takeaway ignored — first occurrence wins (:61)');
}
{
  // Duplicate top: find() takes the FIRST occurrence (:62)
  const phases = makePhases({ takeaway: 0, top: 800, downswing: 900, impact: 1100, follow_through: 1500 });
  phases.push(phase('top', 950));
  const tempo = calculateTempo(phases);
  assertEq(tempo?.backswingMs, 800, 'B12: duplicate top → first occurrence wins (find, :62)');
}

// ---------------------------------------------------------------------------
// Section C — rating bands (TEMPO_THRESHOLDS :25-31, inclusive upper via <= :51)
// ---------------------------------------------------------------------------

group('C. Rating bands');

function ratingOf(backswingMs: number, downswingMs: number): TempoRating | undefined {
  return calculateTempo(phasesForSegments(backswingMs, downswingMs))?.tempoRating;
}

assertEq(ratingOf(1000, 1000), 'rushed' as TempoRating, 'C1: ratio 1.0 → rushed (≤1.5, :26)');
assertEq(ratingOf(1500, 1000), 'rushed' as TempoRating, 'C2: ratio 1.5 boundary → rushed (inclusive, :51)');
assertEq(ratingOf(2000, 1000), 'fast' as TempoRating, 'C3: ratio 2.0 → fast (≤2.5, :27)');
assertEq(ratingOf(2500, 1000), 'fast' as TempoRating, 'C4: ratio 2.5 boundary → fast (inclusive, :51)');
assertEq(ratingOf(2510, 1000), 'good' as TempoRating, 'C5: ratio 2.51 → good (≤3.5, :28)');
assertEq(ratingOf(3500, 1000), 'good' as TempoRating, 'C6: ratio 3.5 boundary → good (inclusive, :51)');
assertEq(ratingOf(3510, 1000), 'slow' as TempoRating, 'C7: ratio 3.51 → slow (≤4.5, :29)');
assertEq(ratingOf(4500, 1000), 'slow' as TempoRating, 'C8: ratio 4.5 boundary → slow (inclusive, :51)');
assertEq(ratingOf(4510, 1000), 'very_slow' as TempoRating, 'C9: ratio 4.51 → very_slow (:30)');

// ---------------------------------------------------------------------------
// Section D — isTempoTrustworthy (:117-135)
// ---------------------------------------------------------------------------

group('D. isTempoTrustworthy');

assertEq(
  isTempoTrustworthy(makeTempo(), [{ source: 'fallback' }, { source: 'fallback' }]),
  false,
  'D1: all-fallback phases → untrustworthy (:122-123)',
);
assertEq(
  isTempoTrustworthy(makeTempo(), [{ source: 'heuristic' }, { source: 'fallback' }]),
  true,
  'D2: mixed sources (one heuristic) → trustworthy (:122 every)',
);
assertEq(
  isTempoTrustworthy(makeTempo({ backswingMs: TEMPO_MIN_PHASE_MS - 1 }), HEURISTIC_SOURCES),
  false,
  `D3: backswingMs ${TEMPO_MIN_PHASE_MS - 1} < TEMPO_MIN_PHASE_MS(${TEMPO_MIN_PHASE_MS}) → untrustworthy (:106, :126)`,
);
assertEq(
  isTempoTrustworthy(makeTempo({ backswingMs: TEMPO_MIN_PHASE_MS }), HEURISTIC_SOURCES),
  true,
  `D4: backswingMs exactly ${TEMPO_MIN_PHASE_MS} passes (strict <, :126)`,
);
assertEq(
  isTempoTrustworthy(makeTempo({ downswingMs: TEMPO_MIN_PHASE_MS - 1 }), HEURISTIC_SOURCES),
  false,
  `D5: downswingMs ${TEMPO_MIN_PHASE_MS - 1} < ${TEMPO_MIN_PHASE_MS} → untrustworthy (:126)`,
);
assertEq(
  isTempoTrustworthy(makeTempo({ downswingMs: TEMPO_MIN_PHASE_MS }), HEURISTIC_SOURCES),
  true,
  `D6: downswingMs exactly ${TEMPO_MIN_PHASE_MS} passes (strict <, :126)`,
);
assertEq(
  isTempoTrustworthy(makeTempo({ tempoRatio: TEMPO_MIN_RATIO - 0.01 }), HEURISTIC_SOURCES),
  false,
  `D7: ratio ${TEMPO_MIN_RATIO - 0.01} < TEMPO_MIN_RATIO(${TEMPO_MIN_RATIO}) → untrustworthy (:110, :129)`,
);
assertEq(
  isTempoTrustworthy(makeTempo({ tempoRatio: TEMPO_MIN_RATIO }), HEURISTIC_SOURCES),
  true,
  `D8: ratio exactly ${TEMPO_MIN_RATIO} passes (strict <, :129)`,
);
assertEq(
  isTempoTrustworthy(makeTempo({ tempoRatio: TEMPO_MAX_RATIO }), HEURISTIC_SOURCES),
  true,
  `D9: ratio exactly ${TEMPO_MAX_RATIO} passes (strict >, :129)`,
);
assertEq(
  isTempoTrustworthy(makeTempo({ tempoRatio: TEMPO_MAX_RATIO + 0.01 }), HEURISTIC_SOURCES),
  false,
  `D10: ratio ${TEMPO_MAX_RATIO + 0.01} > TEMPO_MAX_RATIO(${TEMPO_MAX_RATIO}) → untrustworthy (:111, :129)`,
);
assertEq(
  isTempoTrustworthy(makeTempo({ tempoRatio: NaN }), HEURISTIC_SOURCES),
  false,
  'D11: NaN ratio → untrustworthy (NaN passes :129 comparisons, caught by isFinite :132)',
);
assertEq(
  isTempoTrustworthy(makeTempo(), []),
  true,
  'D12: CHARACTERIZATION — empty phases array is NOT all-fallback (length>0 guard :122), tempo trusted',
);

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
  console.log('✅ All tempoAnalysis tests passed');
}
