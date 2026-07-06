/**
 * deleteSwing.test.ts — per-swing delete orchestration.
 *
 * Run with: npx tsx lib/deleteSwing.test.ts
 *
 * No jest — project-standard hand-rolled harness (see outbox.test.ts). The
 * DeleteSwingAdapter is injected and records an ordered call log, so the
 * order-of-operations contract (purge outbox → storage remove → row delete)
 * is asserted directly. Expected values are derived from the implementation
 * under test.
 */

import {
  deleteSwing,
  __setAdapterForTesting,
  type DeleteSwingAdapter,
} from './deleteSwing';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function group(name: string): void {
  console.log(`\n── ${name} ──`);
}
function assert(cond: boolean, label: string): void {
  if (cond) {
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
// Recording adapter
// ---------------------------------------------------------------------------

type Overrides = {
  userId?: string | null;
  purgeThrows?: boolean;
  removeError?: { message?: string } | null;
  deleteError?: { message?: string } | null;
};

function makeAdapter(o: Overrides = {}): { adapter: DeleteSwingAdapter; calls: string[] } {
  const calls: string[] = [];
  const adapter: DeleteSwingAdapter = {
    async getUserId() {
      calls.push('getUserId');
      return o.userId !== undefined ? o.userId : 'user-1';
    },
    async purgeOutbox(swingId) {
      calls.push(`purgeOutbox:${swingId}`);
      if (o.purgeThrows) throw new Error('fs unavailable');
    },
    async removeVideo(storagePath) {
      calls.push(`removeVideo:${storagePath}`);
      return { error: o.removeError ?? null };
    },
    async deleteRow(swingId) {
      calls.push(`deleteRow:${swingId}`);
      return { error: o.deleteError ?? null };
    },
  };
  return { adapter, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  group('happy path — order of operations');
  {
    const { adapter, calls } = makeAdapter();
    __setAdapterForTesting(adapter);
    const ok = await deleteSwing('swing-1');
    assertEq(ok, true, 'returns true on full success');
    assertEq(
      calls.join(' → '),
      'getUserId → purgeOutbox:swing-1 → removeVideo:user-1/swing-1.mov → deleteRow:swing-1',
      'purge runs FIRST, then storage remove, then row delete',
    );
  }

  group('derived storage path');
  {
    const { adapter, calls } = makeAdapter({ userId: 'u-abc' });
    __setAdapterForTesting(adapter);
    await deleteSwing('s-xyz');
    assert(
      calls.includes('removeVideo:u-abc/s-xyz.mov'),
      'path is `${userId}/${swingId}.mov` (pinned to outbox.ts runVideoUpload)',
    );
  }

  group('storage-error tolerance');
  {
    const { adapter, calls } = makeAdapter({ removeError: { message: 'network' } });
    __setAdapterForTesting(adapter);
    const ok = await deleteSwing('swing-2');
    assertEq(ok, true, 'storage remove error does NOT fail the delete');
    assert(calls.includes('deleteRow:swing-2'), 'row delete still runs after storage error');
  }

  group('row delete failure');
  {
    const { adapter, calls } = makeAdapter({ deleteError: { message: 'rls denied' } });
    __setAdapterForTesting(adapter);
    const ok = await deleteSwing('swing-3');
    assertEq(ok, false, 'returns false when the row delete errors (optimistic revert)');
    assert(calls.includes('purgeOutbox:swing-3'), 'purge already ran before the failure');
  }

  group('anonymous user');
  {
    const { adapter, calls } = makeAdapter({ userId: null });
    __setAdapterForTesting(adapter);
    const ok = await deleteSwing('swing-4');
    assertEq(ok, false, 'returns false with no userId');
    assertEq(calls.join(' → '), 'getUserId', 'no purge / remove / delete attempted');
  }

  group('purge failure aborts before any remote mutation');
  {
    const { adapter, calls } = makeAdapter({ purgeThrows: true });
    __setAdapterForTesting(adapter);
    const ok = await deleteSwing('swing-5');
    assertEq(ok, false, 'returns false when the outbox purge throws');
    assert(!calls.some((c) => c.startsWith('removeVideo')), 'storage remove NOT attempted');
    assert(!calls.some((c) => c.startsWith('deleteRow')), 'row delete NOT attempted');
  }

  __setAdapterForTesting(null);

  // ---- summary ----
  console.log(`\n════════════════════════════════════════`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
