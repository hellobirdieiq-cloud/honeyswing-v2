/**
 * personalBandCalculator.test.ts — Clinic personal band validation
 *
 * Run with: npx tsx packages/domain/clinic/personalBandCalculator.test.ts
 *
 * Covers:
 *   - createPersonalBand returns zeroed stats
 *   - appendSample updates average and SD correctly (3-sample hand-calculated)
 *   - appendSample does not mutate input
 *   - isWithinBand returns true within 1 SD, false outside 2 SD
 *   - archiveSession appends to sessionHistory
 */

import {
  createPersonalBand,
  appendSample,
  archiveSession,
  isWithinBand,
} from './personalBandCalculator';
import type { PersonalBand } from './PersonalBand';

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
// Tests
// ---------------------------------------------------------------------------

group('createPersonalBand returns zeroed stats');
{
  const band = safeCall('createPersonalBand', () =>
    createPersonalBand('kid-1', 'spineAngle'),
  );
  if (band) {
    assertEq(band.kidId, 'kid-1', 'kidId set');
    assertEq(band.metric, 'spineAngle', 'metric set');
    assertEq(band.average, 0, 'average starts at 0');
    assertEq(band.standardDeviation, 0, 'standardDeviation starts at 0');
    assertEq(band.sampleCount, 0, 'sampleCount starts at 0');
    assert(Array.isArray(band.sessionHistory) && band.sessionHistory.length === 0,
      'sessionHistory is empty array');
  }
}

group('appendSample updates average and SD correctly (3 samples: 10, 20, 30)');
{
  // Hand calculation:
  //   values   = [10, 20, 30]
  //   mean     = 60 / 3 = 20
  //   deviations² = [100, 0, 100], sum = 200
  //   sample variance = 200 / (n-1) = 100  → sample SD = 10
  //   population variance = 200 / n = 66.667 → population SD ≈ 8.16497
  //
  // Accept either convention by checking SD ∈ {10, 8.16497}.
  const start = safeCall('seed band', () => createPersonalBand('kid-1', 'spineAngle'));
  if (start) {
    const b1 = safeCall('append 10', () => appendSample(start, 10));
    const b2 = b1 && safeCall('append 20', () => appendSample(b1, 20));
    const b3 = b2 && safeCall('append 30', () => appendSample(b2, 30));

    if (b1) {
      assertEq(b1.sampleCount, 1, 'after 1 sample: count = 1');
      assertClose(b1.average, 10, 'after 1 sample: average = 10');
      assertClose(b1.standardDeviation, 0, 'after 1 sample: SD = 0');
    }
    if (b2) {
      assertEq(b2.sampleCount, 2, 'after 2 samples: count = 2');
      assertClose(b2.average, 15, 'after 2 samples: average = 15');
    }
    if (b3) {
      assertEq(b3.sampleCount, 3, 'after 3 samples: count = 3');
      assertClose(b3.average, 20, 'after 3 samples: average = 20');
      const sd = b3.standardDeviation;
      const sampleSd = 10;
      const populationSd = Math.sqrt(200 / 3); // ≈ 8.16497
      assert(
        Math.abs(sd - sampleSd) <= 1e-4 || Math.abs(sd - populationSd) <= 1e-4,
        `after 3 samples: SD matches sample (10) or population (≈8.165) — got ${sd}`,
      );
    }
  }
}

group('appendSample does not mutate input');
{
  const start = safeCall('seed band', () => createPersonalBand('kid-1', 'spineAngle'));
  if (start) {
    const snapshotBefore = JSON.stringify(start);
    safeCall('append 42', () => appendSample(start, 42));
    const snapshotAfter = JSON.stringify(start);
    assertEq(snapshotAfter, snapshotBefore, 'input band unchanged after appendSample');
  }
}

group('isWithinBand: true within 1 SD, false outside 2 SD');
{
  // Build a band with average = 20, SD ∈ {10 (sample), ≈8.165 (population)}.
  // 25 is within 1 SD under both conventions (|25-20| = 5 ≤ 8.165).
  // 45 is outside 2 SD under both conventions (|45-20| = 25 > 2 × 10 = 20).
  let band = safeCall('seed band', () => createPersonalBand('kid-1', 'spineAngle'));
  if (band) {
    band = safeCall('append 10', () => appendSample(band as PersonalBand, 10));
    band = band && safeCall('append 20', () => appendSample(band, 20));
    band = band && safeCall('append 30', () => appendSample(band, 30));
  }
  if (band) {
    const inside = safeCall('isWithinBand(25) default tolerance',
      () => isWithinBand(band as PersonalBand, 25));
    if (inside !== undefined) assertEq(inside, true, '25 within 1 SD of 20 → true');

    const outside = safeCall('isWithinBand(45, 2)',
      () => isWithinBand(band as PersonalBand, 45, 2));
    if (outside !== undefined) assertEq(outside, false, '45 outside 2 SD of 20 → false');
  }
}

group('archiveSession appends to sessionHistory');
{
  let band = safeCall('seed band', () => createPersonalBand('kid-1', 'spineAngle'));
  if (band) {
    band = safeCall('append 10', () => appendSample(band as PersonalBand, 10));
    band = band && safeCall('append 20', () => appendSample(band, 20));
  }
  if (band) {
    const recordedAt = 1700000000000;
    const archived = safeCall('archiveSession',
      () => archiveSession(band as PersonalBand, 'session-1', 3, recordedAt));
    if (archived) {
      assertEq(archived.sessionHistory.length, 1, 'sessionHistory length = 1');
      const entry = archived.sessionHistory[0];
      if (entry) {
        assertEq(entry.sessionId, 'session-1', 'entry.sessionId set');
        assertEq(entry.clinicNumber, 3, 'entry.clinicNumber set');
        assertEq(entry.recordedAt, recordedAt, 'entry.recordedAt set');
        assertEq(entry.sampleCount, 2, 'entry.sampleCount snapshots count');
        assertClose(entry.average, 15, 'entry.average snapshots avg');
      }
    }
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
  console.log('✅ All tests passed — personalBandCalculator validated');
}
