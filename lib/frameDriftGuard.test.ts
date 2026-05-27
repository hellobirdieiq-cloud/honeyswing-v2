/**
 * frameDriftGuard.test.ts — Phase 8 drift-sensor unit tests.
 *
 * Run with: npx tsx lib/frameDriftGuard.test.ts
 *
 * 6 pure tests on computeDrift + 2 storage tests on
 * recordDriftEvent/getDriftLog. Each storage test starts with a fresh
 * in-memory StorageAdapter (no inheritance between tests 7 and 8).
 */

import {
  DRIFT_THRESHOLD,
  computeDrift,
  recordDriftEvent,
  getDriftLog,
  __setStorageForTesting,
  type DriftRecord,
  type StorageAdapter,
} from './frameDriftGuard';

const STORAGE_KEY = 'frameDriftLog:v1';

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

function assertClose(
  actual: number,
  expected: number,
  eps: number,
  label: string,
): void {
  assert(
    Math.abs(actual - expected) < eps,
    `${label} (got ${actual}, expected ≈ ${expected} ± ${eps})`,
  );
}

function makeMemoryStorage(seed: Record<string, string> = {}): StorageAdapter & {
  _store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    _store: store,
    async getItem(key) {
      return store.get(key) ?? null;
    },
    async setItem(key, value) {
      store.set(key, value);
    },
  };
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // computeDrift — pure
  // -------------------------------------------------------------------------
  group('Test 1: exact match');
  {
    const r = computeDrift(240, 1000, 240);
    assertEq(r.driftRatio, 1.0, 'driftRatio');
    assertEq(r.flagged, false, 'flagged');
  }

  group('Test 2: under, within threshold');
  {
    const r = computeDrift(235, 1000, 240);
    assertClose(r.driftRatio, 0.9792, 0.001, 'driftRatio');
    assertEq(r.flagged, false, 'flagged');
  }

  group('Test 3: over threshold (high)');
  {
    const r = computeDrift(270, 1000, 240);
    assertEq(r.driftRatio, 1.125, 'driftRatio');
    assertEq(r.flagged, true, 'flagged');
  }

  group('Test 4: over threshold (low)');
  {
    const r = computeDrift(210, 1000, 240);
    assertEq(r.driftRatio, 0.875, 'driftRatio');
    assertEq(r.flagged, true, 'flagged');
  }

  group('Test 5: boundary — strict > not >=');
  {
    const low = computeDrift(216, 1000, 240);
    assertEq(low.driftRatio, 0.9, 'low driftRatio');
    assertEq(low.flagged, false, 'low flagged (boundary, not flagged)');
    const high = computeDrift(264, 1000, 240);
    assertEq(high.driftRatio, 1.1, 'high driftRatio');
    assertEq(high.flagged, false, 'high flagged (boundary, not flagged)');
    assertEq(DRIFT_THRESHOLD, 0.10, 'DRIFT_THRESHOLD constant value');
  }

  group('Test 6: bad inputs return zero-result, do not throw');
  {
    const cases: [number, number, number, string][] = [
      [0, 0, 240, '(0, 0, 240)'],
      [Infinity, 1000, 240, '(Infinity, 1000, 240)'],
      [240, 1000, 0, '(240, 1000, 0)'],
      [240, -100, 240, '(240, -100, 240)'],
      [NaN, 1000, 240, '(NaN, 1000, 240)'],
    ];
    for (const [a, b, c, label] of cases) {
      const r = computeDrift(a, b, c);
      assertEq(r.driftRatio, 0, `${label} driftRatio`);
      assertEq(r.flagged, false, `${label} flagged`);
    }
  }

  // -------------------------------------------------------------------------
  // recordDriftEvent + getDriftLog — fresh storage per test
  // -------------------------------------------------------------------------
  group('Test 7: round-trip — record then read back');
  {
    const storage = makeMemoryStorage();
    __setStorageForTesting(storage);
    const before = Date.now();
    const result = await recordDriftEvent('swing-1', 240, 1000, 240);
    const after = Date.now();
    assertEq(result.driftRatio, 1.0, 'returned driftRatio');
    assertEq(result.flagged, false, 'returned flagged');
    const log = await getDriftLog();
    assertEq(log.length, 1, 'log length');
    const rec = log[0];
    assertEq(rec.swingId, 'swing-1', 'swingId');
    assertEq(rec.recordedFrameCount, 240, 'recordedFrameCount');
    assertEq(rec.expectedFrameCount, 240, 'expectedFrameCount');
    assertEq(rec.driftRatio, 1.0, 'driftRatio');
    assertEq(rec.flagged, false, 'flagged');
    const ts = Date.parse(rec.recordedAtIso);
    assert(Number.isFinite(ts), 'recordedAtIso parses as a Date');
    assert(ts >= before && ts <= after, 'recordedAtIso within call window');
  }

  group('Test 8: trim-to-100 — oldest dropped on overflow');
  {
    const storage = makeMemoryStorage();
    const seed: DriftRecord[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `swing-${String(i).padStart(3, '0')}`;
      seed.push({
        swingId: id,
        recordedFrameCount: 240,
        expectedFrameCount: 240,
        driftRatio: 1.0,
        flagged: false,
        recordedAtIso: new Date(0).toISOString(),
      });
    }
    await storage.setItem(STORAGE_KEY, JSON.stringify(seed));
    __setStorageForTesting(storage);
    await recordDriftEvent('swing-100', 240, 1000, 240);
    const log = await getDriftLog();
    assertEq(log.length, 100, 'log length after overflow');
    assertEq(log[0].swingId, 'swing-001', 'oldest entry dropped (now swing-001)');
    assertEq(log[log.length - 1].swingId, 'swing-100', 'newest entry appended');
  }

  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
