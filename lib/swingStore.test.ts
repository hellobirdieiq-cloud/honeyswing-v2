/**
 * swingStore.test.ts — STO validation (v9 seq 57)
 *
 * Run with: npx tsx lib/swingStore.test.ts
 *
 * Covers the 11 unit tests in the design spec (§D7). Harness mirrors
 * lib/eventBus.test.ts — no jest, project-standard hand-rolled runner.
 *
 * Query-chain fidelity (the literal SQL produced by the real adapter) is
 * verified by manual device smoke test rather than an automated test; see
 * the plan Verification section.
 */

import {
  getSwingById,
  getGripHistory,
  type SwingRecord,
  type GripHistoryRecord,
  type SwingStoreAdapter,
  __setAdapterForTesting,
  __resetForTesting,
} from './swingStore';

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
// Adapter builder
// ---------------------------------------------------------------------------

type AdapterCalls = {
  fetchSwingById: Array<{ id: string }>;
  fetchGripHistory: Array<{ userId: string; sinceIso: string }>;
  fetchSwingHistory: Array<{ userId: string; sinceIso: string }>;
  getUserId: number;
};

type MockAdapter = SwingStoreAdapter & { calls: AdapterCalls };

function makeAdapter(overrides: Partial<SwingStoreAdapter> = {}): MockAdapter {
  const calls: AdapterCalls = {
    fetchSwingById: [],
    fetchGripHistory: [],
    fetchSwingHistory: [],
    getUserId: 0,
  };
  return {
    calls,
    async fetchSwingById(id) {
      calls.fetchSwingById.push({ id });
      if (overrides.fetchSwingById) return overrides.fetchSwingById(id);
      return { data: null, error: null };
    },
    async fetchGripHistory(userId, sinceIso) {
      calls.fetchGripHistory.push({ userId, sinceIso });
      if (overrides.fetchGripHistory) return overrides.fetchGripHistory(userId, sinceIso);
      return { data: [], error: null };
    },
    async fetchSwingHistory(userId, sinceIso) {
      calls.fetchSwingHistory.push({ userId, sinceIso });
      if (overrides.fetchSwingHistory) return overrides.fetchSwingHistory(userId, sinceIso);
      return { data: [], error: null };
    },
    async getUserId() {
      calls.getUserId++;
      if (overrides.getUserId) return overrides.getUserId();
      return 'user_test';
    },
  };
}

function resetAll(overrides: Partial<SwingStoreAdapter> = {}): MockAdapter {
  __resetForTesting();
  const a = makeAdapter(overrides);
  __setAdapterForTesting(a);
  return a;
}

function captureConsoleError(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  return {
    logs,
    restore: () => {
      console.error = orig;
    },
  };
}

function sampleSwingRecord(): SwingRecord {
  return {
    id: 'swing_1',
    user_id: 'user_test',
    created_at: '2026-04-20T00:00:00.000Z',
    score: 85,
    honey_boom: false,
    frame_count: 150,
    duration_ms: 2500,
    pose_success_rate: 0.95,
    capture_validity: 'valid',
    phase_source: 'heuristic',
    failure_reason: null,
    backswing_ms: 800,
    downswing_ms: 300,
    tempo_ratio: 2.67,
    impact_frame_index: 90,
    app_version: '1.9.6',
    coach_name: null,
    analysis_version: 'v1',
    video_storage_path: null,
    video_uploaded_at: null,
    swing_debug: { grip_cloud: { overall: 'solid', analysis_failed: false } },
    camera_angle_valid: true,
    player_profile_id: null,
    angles: null,
    tempo: null,
    phases: null,
    trail_points: null,
    metric_confidences: null,
    category_scores: null,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Test 1: SwingRecord shape — 29 keys from SWING_RECORD_COLUMNS projection
  {
    group('1. SwingRecord shape matches SWING_RECORD_COLUMNS projection (29 keys)');
    const record = sampleSwingRecord();
    const keys = Object.keys(record).sort();
    const expectedKeys = [
      'id',
      'user_id',
      'created_at',
      'score',
      'honey_boom',
      'frame_count',
      'duration_ms',
      'pose_success_rate',
      'capture_validity',
      'phase_source',
      'failure_reason',
      'backswing_ms',
      'downswing_ms',
      'tempo_ratio',
      'impact_frame_index',
      'app_version',
      'coach_name',
      'analysis_version',
      'video_storage_path',
      'video_uploaded_at',
      'swing_debug',
      'camera_angle_valid',
      'player_profile_id',
      'angles',
      'tempo',
      'phases',
      'trail_points',
      'metric_confidences',
      'category_scores',
    ].sort();
    assertEq(keys.length, 29, 'SwingRecord has 29 keys');
    assertEq(
      JSON.stringify(keys),
      JSON.stringify(expectedKeys),
      'all expected keys present, none unexpected',
    );
  }

  // Test 2: getSwingById happy path
  {
    group('2. getSwingById returns SwingRecord on success');
    const sample = sampleSwingRecord();
    resetAll({ fetchSwingById: async () => ({ data: sample, error: null }) });
    const result = await getSwingById('swing_1');
    assert(result !== null, 'result is not null');
    assertEq(result?.id, 'swing_1', 'id matches');
    assertEq(result?.score, 85, 'score matches');
    const gc = result?.swing_debug?.grip_cloud as { overall: string } | undefined;
    assertEq(gc?.overall, 'solid', 'swing_debug.grip_cloud.overall passes through');
  }

  // Test 3: getSwingById returns null when row not found
  {
    group('3. getSwingById returns null when row not found');
    resetAll({ fetchSwingById: async () => ({ data: null, error: null }) });
    const result = await getSwingById('missing_id');
    assertEq(result, null, 'not-found returns null');
  }

  // Test 4: getSwingById on DB error returns null + logs STO-prefixed message
  {
    group('4. getSwingById on DB error returns null and logs');
    resetAll({
      fetchSwingById: async () => ({ data: null, error: { message: 'boom' } }),
    });
    const { logs, restore } = captureConsoleError();
    try {
      const result = await getSwingById('swing_x');
      assertEq(result, null, 'error returns null');
      const hasLog = logs.some(
        (l) =>
          l.includes('[HoneySwing] swingStore getSwingById error:') && l.includes('boom'),
      );
      assert(hasLog, 'error logged with [HoneySwing] swingStore prefix');
    } finally {
      restore();
    }
  }

  // Test 5: getGripHistory happy path
  {
    group('5. getGripHistory returns rows on success');
    const fixture: GripHistoryRecord[] = [
      { id: 's1', created_at: '2026-04-20T00:00:00.000Z', grip_overall: 'solid', grip_failed: null },
      { id: 's2', created_at: '2026-04-19T00:00:00.000Z', grip_overall: 'playable', grip_failed: null },
      { id: 's3', created_at: '2026-04-18T00:00:00.000Z', grip_overall: 'needs_adjustment', grip_failed: null },
    ];
    resetAll({ fetchGripHistory: async () => ({ data: fixture, error: null }) });
    const result = await getGripHistory();
    assertEq(result.length, 3, 'returns 3 rows');
    assertEq(result[0].grip_overall, 'solid', 'first row grip_overall preserved');
    assertEq(result[2].id, 's3', 'order preserved from adapter');
  }

  // Test 6: getGripHistory returns [] when no rows match
  {
    group('6. getGripHistory returns [] when no rows match');
    resetAll({ fetchGripHistory: async () => ({ data: [], error: null }) });
    const result = await getGripHistory();
    assertEq(result.length, 0, 'empty array returned');
  }

  // Test 7: getGripHistory on DB error returns [] + logs preserved message
  {
    group('7. getGripHistory on DB error returns [] and logs');
    resetAll({
      fetchGripHistory: async () => ({ data: null, error: { message: 'db down' } }),
    });
    const { logs, restore } = captureConsoleError();
    try {
      const result = await getGripHistory();
      assertEq(result.length, 0, 'error returns []');
      const hasLog = logs.some(
        (l) =>
          l.includes('[HoneySwing] grip history fetch error:') && l.includes('db down'),
      );
      assert(
        hasLog,
        'error logged with GripHistoryRow-preserved prefix (observability parity)',
      );
    } finally {
      restore();
    }
  }

  // Test 8: getGripHistory defaults windowMs to 30 days
  {
    group('8. getGripHistory defaults windowMs to 30 days');
    const a = resetAll();
    const before = Date.now();
    await getGripHistory();
    const after = Date.now();
    assertEq(a.calls.fetchGripHistory.length, 1, 'fetchGripHistory called once');
    const { sinceIso } = a.calls.fetchGripHistory[0];
    const since = new Date(sinceIso).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const lowerBound = before - thirtyDaysMs;
    const upperBound = after - thirtyDaysMs + 100;
    assert(
      since >= lowerBound && since <= upperBound,
      `sinceIso within [now-30d, now-30d+100ms] (got ${since}, expected ≥${lowerBound} and ≤${upperBound})`,
    );
  }

  // Test 9: getGripHistory respects custom windowMs
  {
    group('9. getGripHistory respects custom windowMs');
    const a = resetAll();
    const customWindow = 7 * 24 * 60 * 60 * 1000;
    const before = Date.now();
    await getGripHistory({ windowMs: customWindow });
    const after = Date.now();
    const { sinceIso } = a.calls.fetchGripHistory[0];
    const since = new Date(sinceIso).getTime();
    const lowerBound = before - customWindow;
    const upperBound = after - customWindow + 100;
    assert(
      since >= lowerBound && since <= upperBound,
      `7-day custom window applied (got ${since}, expected ≥${lowerBound} and ≤${upperBound})`,
    );
  }

  // Test 10: getGripHistory returns [] without DB call when no user
  {
    group('10. getGripHistory returns [] without DB call when no user');
    const a = resetAll({ getUserId: async () => null });
    const result = await getGripHistory();
    assertEq(result.length, 0, 'returns [] when no user');
    assertEq(
      a.calls.fetchGripHistory.length,
      0,
      'fetchGripHistory NOT called when no user',
    );
    assertEq(a.calls.getUserId, 1, 'getUserId was consulted');
  }

  // Test 11: getGripHistory forwards userId from getUserId()
  {
    group('11. getGripHistory forwards userId from getUserId()');
    const a = resetAll({ getUserId: async () => 'user_123' });
    await getGripHistory();
    assertEq(a.calls.fetchGripHistory.length, 1, 'fetchGripHistory called once');
    assertEq(
      a.calls.fetchGripHistory[0].userId,
      'user_123',
      'userId forwarded verbatim to adapter',
    );
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  __resetForTesting();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
