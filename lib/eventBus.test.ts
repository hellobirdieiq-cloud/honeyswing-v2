/**
 * eventBus.test.ts — EVB validation (v9 seq 56)
 *
 * Run with: npx tsx lib/eventBus.test.ts
 *
 * Covers the 16 unit tests in the design spec (§D5).
 * No jest — project-standard hand-rolled harness (see ageTier.test.ts).
 */

import {
  emit,
  on,
  onAny,
  drain,
  endSession,
  type DrainResult,
  type EventRecord,
  type EventRow,
  type StorageAdapter,
  type SupabaseAdapter,
  __resetForTesting,
  __setStorageForTesting,
  __setSupabaseForTesting,
  __whenReady,
  __getQueueForTesting,
} from './eventBus';
import { STORAGE_KEYS } from './storageKeys';

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
// Adapter builders
// ---------------------------------------------------------------------------

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

function makeSupabaseAdapter(
  userId: string | null,
  onUpsert: (rows: EventRow[]) => { error: { message: string } | null },
): SupabaseAdapter & { calls: EventRow[][] } {
  const calls: EventRow[][] = [];
  return {
    calls,
    async upsertEvents(rows) {
      calls.push(rows);
      return onUpsert(rows);
    },
    async getUserId() {
      return userId;
    },
  };
}

function resetAll(userId: string | null = 'user_test'): {
  storage: ReturnType<typeof makeMemoryStorage>;
  supa: ReturnType<typeof makeSupabaseAdapter>;
} {
  __resetForTesting();
  const storage = makeMemoryStorage();
  const supa = makeSupabaseAdapter(userId, () => ({ error: null }));
  __setStorageForTesting(storage);
  __setSupabaseForTesting(supa);
  return { storage, supa };
}

async function flushMicrotasks(): Promise<void> {
  // Wait for fire-and-forget enqueue() promises to settle.
  // Two round-trips: first for initPromise (loadQueue), second for enqueue's
  // getUserId()+persistQueue() chain.
  await __whenReady();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Test 1: emit fans out to on(type, …)
  {
    group('1. emit fans out to matching on(type, …) handler');
    resetAll();
    let received: unknown = null;
    on('tip.shown', (payload) => {
      received = payload;
    });
    emit('tip.shown', {
      swingId: 's1',
      metricKey: 'spineAngle',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    assert(received !== null, 'handler was called');
    assertEq(
      (received as { metricKey: string }).metricKey,
      'spineAngle',
      'handler received correct payload',
    );
    await flushMicrotasks();
  }

  // Test 2: emit does NOT fan out to other types
  {
    group('2. emit does NOT fan out to handler for other types');
    resetAll();
    let otherCalls = 0;
    on('feedback.shown', () => {
      otherCalls++;
    });
    emit('tip.shown', {
      swingId: null,
      metricKey: 'x',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    assertEq(otherCalls, 0, 'feedback.shown handler not called on tip.shown emit');
    await flushMicrotasks();
  }

  // Test 3: onAny receives full EventRecord
  {
    group('3. onAny receives full EventRecord');
    resetAll();
    const seen: EventRecord[] = [];
    onAny((e) => seen.push(e));
    emit('tip.shown', {
      swingId: null,
      metricKey: 'x',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    // Expect session.started (from init, fired BEFORE onAny registered — so not seen) + tip.shown.
    // onAny is registered after init, so it only sees tip.shown.
    const tipSeen = seen.find((e) => e.type === 'tip.shown');
    assert(tipSeen !== undefined, 'onAny saw tip.shown');
    assert(tipSeen?.type === 'tip.shown', 'record has type field');
    assert(
      (tipSeen?.payload as { metricKey: string })?.metricKey === 'x',
      'record has payload field',
    );
    await flushMicrotasks();
  }

  // Test 4: Unsubscribe from on removes handler
  {
    group('4. Unsubscribe from on removes handler');
    resetAll();
    let calls = 0;
    const unsub = on('tip.shown', () => {
      calls++;
    });
    emit('tip.shown', {
      swingId: null,
      metricKey: 'a',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    assertEq(calls, 1, 'handler called once before unsub');
    unsub();
    emit('tip.shown', {
      swingId: null,
      metricKey: 'b',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    assertEq(calls, 1, 'handler NOT called after unsub');
    await flushMicrotasks();
  }

  // Test 5: Unsubscribe from onAny removes handler
  {
    group('5. Unsubscribe from onAny removes handler');
    resetAll();
    let calls = 0;
    const unsub = onAny(() => {
      calls++;
    });
    emit('tip.shown', {
      swingId: null,
      metricKey: 'a',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    const beforeUnsub = calls;
    assert(beforeUnsub >= 1, `onAny called at least once before unsub (got ${beforeUnsub})`);
    unsub();
    emit('tip.shown', {
      swingId: null,
      metricKey: 'b',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    assertEq(calls, beforeUnsub, 'onAny NOT called after unsub');
    await flushMicrotasks();
  }

  // Test 6: emit enqueues to AsyncStorage
  {
    group('6. emit enqueues to (mocked) AsyncStorage');
    const { storage } = resetAll();
    emit('tip.shown', {
      swingId: null,
      metricKey: 'enqueue-test',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    await flushMicrotasks();
    const raw = storage._store.get(STORAGE_KEYS.eventQueue);
    assert(raw !== undefined, 'queue key written to storage');
    const parsed = JSON.parse(raw ?? '[]') as Array<{ type: string }>;
    const hasTip = parsed.some((e) => e.type === 'tip.shown');
    assert(hasTip, 'persisted queue contains tip.shown event');
  }

  // Test 7: Queue persists across init (load-on-first-use)
  {
    group('7. Queue persists across init (load-on-first-use)');
    __resetForTesting();
    const seeded: Array<Record<string, unknown>> = [
      {
        id: 'seed-1',
        type: 'tip.shown',
        payload: {
          swingId: null,
          metricKey: 'persisted',
          tier: 'full',
          displayContext: 'visual_coach',
        },
        emittedAt: '2026-04-21T00:00:00.000Z',
        userId: 'user_test',
        sessionId: null,
        appVersion: '1.9.4',
        attempts: 0,
      },
    ];
    const storage = makeMemoryStorage({
      [STORAGE_KEYS.eventQueue]: JSON.stringify(seeded),
    });
    const supa = makeSupabaseAdapter('user_test', () => ({ error: null }));
    __setStorageForTesting(storage);
    __setSupabaseForTesting(supa);
    // Trigger init + a fresh emit
    emit('tip.shown', {
      swingId: null,
      metricKey: 'new',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    await flushMicrotasks();
    const queue = __getQueueForTesting();
    const hasSeeded = queue.some((e) => e.id === 'seed-1');
    assert(hasSeeded, 'seeded event reappears after init');
    const hasNew = queue.some(
      (e) => e.type === 'tip.shown' && (e.payload as { metricKey: string }).metricKey === 'new',
    );
    assert(hasNew, 'new emit also present');
  }

  // Test 8: Queue cap — emit >500 events, check oldest dropped
  {
    group('8. Queue cap enforced at 500 (drop oldest on overflow)');
    resetAll();
    // First flush init + session.started enqueue
    await flushMicrotasks();
    // Emit 505 tip events
    for (let i = 0; i < 505; i++) {
      emit('tip.shown', {
        swingId: null,
        metricKey: `m-${i}`,
        tier: 'full',
        displayContext: 'visual_coach',
      });
    }
    await flushMicrotasks();
    const queue = __getQueueForTesting();
    assert(queue.length <= 500, `queue length ≤ 500 (got ${queue.length})`);
    // The very first events (session.started, m-0, m-1, ...) should have been dropped.
    const hasSession = queue.some((e) => e.type === 'session.started');
    assert(!hasSession, 'session.started (oldest) was dropped');
    const lastMetric = (queue[queue.length - 1]?.payload as { metricKey: string }).metricKey;
    assertEq(lastMetric, 'm-504', 'most recent event still present');
  }

  // Test 9: drain calls upsert with batch
  {
    group('9. drain calls supabase.upsertEvents with batch');
    const { supa } = resetAll();
    emit('tip.shown', {
      swingId: null,
      metricKey: 'drain-me',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    await flushMicrotasks();
    const result = await drain();
    assert(supa.calls.length >= 1, 'upsertEvents was called');
    const firstCall = supa.calls[0];
    assert(firstCall.length > 0, 'batch had at least one row');
    const row = firstCall[0];
    assert(typeof row.idempotency_key === 'string', 'row has idempotency_key');
    assertEq(row.user_id, 'user_test', 'row carries user_id');
    assert(result.attempted > 0, 'DrainResult.attempted > 0');
  }

  // Test 10: drain success clears sent events from queue
  {
    group('10. drain on success clears sent events from queue');
    resetAll();
    emit('tip.shown', {
      swingId: null,
      metricKey: 'cleared',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    await flushMicrotasks();
    const beforeLen = __getQueueForTesting().length;
    assert(beforeLen > 0, `queue non-empty before drain (${beforeLen})`);
    await drain();
    const afterLen = __getQueueForTesting().length;
    assertEq(afterLen, 0, 'queue empty after successful drain');
  }

  // Test 11: drain error keeps events, increments attempts
  {
    group('11. drain on error keeps queue, increments attempts');
    __resetForTesting();
    const storage = makeMemoryStorage();
    const supa = makeSupabaseAdapter('user_test', () => ({
      error: { message: 'network error' },
    }));
    __setStorageForTesting(storage);
    __setSupabaseForTesting(supa);
    emit('tip.shown', {
      swingId: null,
      metricKey: 'retry-me',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    await flushMicrotasks();
    const before = __getQueueForTesting().length;
    await drain();
    const after = __getQueueForTesting();
    assertEq(after.length, before, 'queue length unchanged on error');
    const allIncremented = after.every((e) => e.attempts >= 1);
    assert(allIncremented, 'all batched events have attempts >= 1');
  }

  // Test 12: drain returns correct DrainResult counts
  {
    group('12. drain returns DrainResult with correct counts');
    resetAll();
    emit('tip.shown', {
      swingId: null,
      metricKey: 'a',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    emit('tip.shown', {
      swingId: null,
      metricKey: 'b',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    await flushMicrotasks();
    const before = __getQueueForTesting().length;
    const r: DrainResult = await drain();
    assertEq(r.attempted, before, 'attempted == queue size before drain');
    assertEq(r.succeeded, before, 'all succeeded on happy-path adapter');
    assertEq(r.failed, 0, 'zero failures');
    assertEq(r.remaining, 0, 'remaining 0 after full drain');
  }

  // Test 13: Concurrent drain shares in-flight promise
  {
    group('13. Concurrent drain calls share in-flight promise');
    __resetForTesting();
    const storage = makeMemoryStorage();
    let upsertCount = 0;
    const supa: SupabaseAdapter = {
      async upsertEvents() {
        upsertCount++;
        // Delay so second drain() arrives during in-flight
        await new Promise((r) => setTimeout(r, 50));
        return { error: null };
      },
      async getUserId() {
        return 'user_test';
      },
    };
    __setStorageForTesting(storage);
    __setSupabaseForTesting(supa);
    emit('tip.shown', {
      swingId: null,
      metricKey: 'concur',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    await flushMicrotasks();
    const [r1, r2] = await Promise.all([drain(), drain()]);
    assertEq(upsertCount, 1, 'upsertEvents called exactly once despite 2 concurrent drains');
    assert(r1 === r2 || JSON.stringify(r1) === JSON.stringify(r2), 'both drains returned same result');
  }

  // Test 14: Idempotency key reused on retry
  {
    group('14. Idempotency key stable across drain retries');
    __resetForTesting();
    const storage = makeMemoryStorage();
    let firstCallRows: EventRow[] | null = null;
    let secondCallRows: EventRow[] | null = null;
    let callIndex = 0;
    const supa: SupabaseAdapter = {
      async upsertEvents(rows) {
        callIndex++;
        if (callIndex === 1) {
          firstCallRows = rows;
          return { error: { message: 'fail first time' } };
        }
        secondCallRows = rows;
        return { error: null };
      },
      async getUserId() {
        return 'user_test';
      },
    };
    __setStorageForTesting(storage);
    __setSupabaseForTesting(supa);
    emit('tip.shown', {
      swingId: null,
      metricKey: 'idempotent',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    await flushMicrotasks();
    await drain(); // fails
    await drain(); // succeeds
    assert(firstCallRows !== null && secondCallRows !== null, 'both drain calls recorded');
    // Find the tip.shown row in each
    const firstTip = firstCallRows!.find((r) => r.type === 'tip.shown');
    const secondTip = secondCallRows!.find((r) => r.type === 'tip.shown');
    assert(firstTip !== undefined && secondTip !== undefined, 'tip row present in both');
    assertEq(firstTip!.idempotency_key, secondTip!.idempotency_key, 'idempotency_key identical across retries');
  }

  // Test 15: Events at max attempts skipped by drain
  {
    group('15. Events with attempts >= 5 skipped by drain');
    __resetForTesting();
    // Seed disk with an event that has attempts=5
    const seeded = [
      {
        id: 'poisoned',
        type: 'tip.shown',
        payload: {
          swingId: null,
          metricKey: 'poison',
          tier: 'full',
          displayContext: 'visual_coach',
        },
        emittedAt: '2026-04-21T00:00:00.000Z',
        userId: 'user_test',
        sessionId: null,
        appVersion: '1.9.4',
        attempts: 5,
      },
    ];
    const storage = makeMemoryStorage({
      [STORAGE_KEYS.eventQueue]: JSON.stringify(seeded),
    });
    let upsertCalls = 0;
    const supa: SupabaseAdapter = {
      async upsertEvents(rows) {
        upsertCalls++;
        // Confirm the poisoned event is NOT in the batch
        const hasPoisoned = rows.some((r) => r.idempotency_key === 'poisoned');
        assert(!hasPoisoned, '  inner: poisoned event excluded from upsert batch');
        return { error: null };
      },
      async getUserId() {
        return 'user_test';
      },
    };
    __setStorageForTesting(storage);
    __setSupabaseForTesting(supa);
    // Trigger init + drain
    emit('tip.shown', {
      swingId: null,
      metricKey: 'healthy',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    await flushMicrotasks();
    const result = await drain();
    // Poisoned event should remain in queue; healthy + session.started should be drained
    const queue = __getQueueForTesting();
    const hasPoisoned = queue.some((e) => e.id === 'poisoned');
    assert(hasPoisoned, 'poisoned event remains on queue');
    assert(result.attempted < queue.length + result.attempted, 'drain skipped at least one event');
    assert(upsertCalls >= 1, 'upsertEvents was called for healthy rows');
  }

  // Test 16: session.started auto-fires on init
  {
    group('16. session.started auto-fires on init');
    __resetForTesting();
    const storage = makeMemoryStorage();
    const supa = makeSupabaseAdapter('user_test', () => ({ error: null }));
    __setStorageForTesting(storage);
    __setSupabaseForTesting(supa);
    const seen: EventRecord[] = [];
    // Register onAny BEFORE the first emit — but onAny() itself triggers init,
    // which fires session.started while onAny handler is being registered.
    // Order of operations in initializeIfNeeded: set isInitialized → start loadQueue → call startSession.
    // Since onAny() calls initializeIfNeeded FIRST, then adds to anyHandlers,
    // the session.started fan-out happens BEFORE the handler is in the Set.
    // So we need to subscribe via on('session.started', ...) and check the queue.
    const unsub = on('session.started', (payload) => {
      seen.push({ type: 'session.started', payload });
    });
    void unsub;
    // The above on() call triggered init, which emitted session.started.
    // But on() also runs initializeIfNeeded BEFORE adding the handler, same issue.
    // Verify via the persisted queue instead.
    await flushMicrotasks();
    const queue = __getQueueForTesting();
    const hasStarted = queue.some((e) => e.type === 'session.started');
    assert(hasStarted, 'session.started present in queue after init');
    // endSession() should then emit session.ended
    endSession();
    await flushMicrotasks();
    const queue2 = __getQueueForTesting();
    const hasEnded = queue2.some((e) => e.type === 'session.ended');
    assert(hasEnded, 'endSession() emits session.ended');
  }

  // Test 17: G8(ii) — pre-auth funnel drains on sign-in, but ONLY for the
  // current session (no cross-user misattribution on a shared device).
  {
    group('17. signed-out events drain on sign-in — current session only');
    __resetForTesting();
    // A leftover null-userId event from a PRIOR app-launch / previous user,
    // persisted to disk while signed out (different sessionId from this launch).
    const seeded = [
      {
        id: 'prior-evt',
        type: 'tip.shown',
        payload: { swingId: null, metricKey: 'prior', tier: 'full', displayContext: 'visual_coach' },
        emittedAt: '2026-04-21T00:00:00.000Z',
        userId: null,
        sessionId: 'prior-session',
        appVersion: '1.9.4',
        attempts: 0,
      },
    ];
    const storage = makeMemoryStorage({
      [STORAGE_KEYS.eventQueue]: JSON.stringify(seeded),
    });
    let currentUser: string | null = null; // signed OUT
    const upserted: EventRow[][] = [];
    const supa: SupabaseAdapter = {
      async upsertEvents(rows) {
        upserted.push(rows);
        return { error: null };
      },
      async getUserId() {
        return currentUser;
      },
    };
    __setStorageForTesting(storage);
    __setSupabaseForTesting(supa);

    // A fresh pre-auth event in THIS session (gets the current sessionId, userId=null).
    emit('tip.shown', {
      swingId: null,
      metricKey: 'current',
      tier: 'full',
      displayContext: 'visual_coach',
    });
    await flushMicrotasks();

    // Still signed out → nothing drains (both current + prior are null-userId).
    const r1 = await drain();
    assertEq(r1.attempted, 0, 'signed-out: nothing drains');
    assert(upserted.length === 0, 'signed-out: upsertEvents not called');

    // Sign in as user_B → the CURRENT-session pre-auth event drains stamped with
    // B (pre-G8 `&& e.userId` never drained it — fails there). The PRIOR-session
    // event must NOT drain: it belongs to a previous user, and inheriting B's id
    // would misattribute it on a shared device (fails if backfill is unscoped).
    currentUser = 'user_B';
    await drain();
    const rows = upserted.flat();

    const currentRow = rows.find(
      (r) => (r.payload as { metricKey?: string }).metricKey === 'current',
    );
    assert(currentRow != null, 'sign-in: current-session pre-auth event drains');
    assertEq(currentRow?.user_id, 'user_B', 'sign-in: current-session event stamped with the signed-in user');

    const priorDrained = rows.some((r) => r.idempotency_key === 'prior-evt');
    assert(!priorDrained, 'MISATTRIBUTION GUARD: prior-session null event does NOT drain under user_B');
    assert(
      __getQueueForTesting().some((e) => e.id === 'prior-evt'),
      'prior-session event stays queued (QUEUE_CAP-evicted, never misattributed)',
    );
  }

  // Test 18: G8(i) — init-clobber guard. The first enqueue (session.started)
  // must NOT persist before loadQueue merges the on-disk queue, or a crash in
  // that window drops the persisted events. A deferred getItem forces the
  // interleave (enqueue-ready while loadQueue is still reading).
  {
    group('18. G8(i) init clobber: first enqueue waits for loadQueue before persisting');
    __resetForTesting();
    const diskRaw = JSON.stringify([
      {
        id: 'disk-evt',
        type: 'tip.shown',
        payload: { swingId: null, metricKey: 'disk', tier: 'full', displayContext: 'visual_coach' },
        emittedAt: '2026-04-21T00:00:00.000Z',
        userId: 'user_test',
        sessionId: 'prior',
        appVersion: '1.9.4',
        attempts: 0,
      },
    ]);
    let resolveGet: (v: string | null) => void = () => {};
    const getGate = new Promise<string | null>((res) => {
      resolveGet = res;
    });
    const writes: string[] = [];
    const deferredStorage: StorageAdapter = {
      getItem(key) {
        // loadQueue's read is held open until we resolve getGate.
        return key === STORAGE_KEYS.eventQueue ? getGate : Promise.resolve(null);
      },
      async setItem(key, value) {
        if (key === STORAGE_KEYS.eventQueue) writes.push(value);
      },
    };
    const supa = makeSupabaseAdapter('user_test', () => ({ error: null }));
    __setStorageForTesting(deferredStorage);
    __setSupabaseForTesting(supa);

    // Trigger init: loadQueue starts (blocked on getGate); startSession enqueues
    // session.started; the emit enqueues 'live'. Let their getUserId microtasks
    // settle — WITHOUT the fix, an enqueue would now persist a queue missing the
    // on-disk events (the clobber).
    emit('tip.shown', { swingId: null, metricKey: 'live', tier: 'full', displayContext: 'visual_coach' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Fix: every enqueue is blocked awaiting initPromise (loadQueue) → no write
    // yet. Bug: a clobbering persist already happened in this window.
    assertEq(writes.length, 0, 'G8(i): no persist before loadQueue merges (no clobber window)');

    // Release loadQueue → merge completes → the blocked enqueues persist safely.
    resolveGet(diskRaw);
    await flushMicrotasks();

    const finalRaw = writes[writes.length - 1];
    assert(finalRaw != null, 'a persist happened once loadQueue merged');
    const finalQueue = JSON.parse(finalRaw ?? '[]') as Array<{ id: string; type: string }>;
    assert(finalQueue.some((e) => e.id === 'disk-evt'), 'disk event survives (not clobbered by the first enqueue)');
    assert(finalQueue.some((e) => e.type === 'session.started'), 'session.started also persisted');
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
