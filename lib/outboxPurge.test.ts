/**
 * outboxPurge.test.ts — purgeOutboxEntriesForSwing (per-swing delete support).
 *
 * Run with: npx tsx lib/outboxPurge.test.ts
 *
 * No jest — project-standard hand-rolled harness (see outbox.test.ts). A
 * minimal in-memory FS adapter is injected and seeded with meta.json entries;
 * the emit hook records telemetry so the no-dead-letter/no-telemetry contract
 * is asserted. Expected values are derived from the implementation under test.
 */

import {
  purgeOutboxEntriesForSwing,
  type FsAdapter,
  type FsFileInfo,
  type OutboxMeta,
  __setFsForTesting,
  __setEmitForTesting,
  __resetForTesting,
  __listEntriesForTesting,
} from './outbox';

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
// Minimal in-memory FS (subset of outbox.test.ts's MemFs: list/read/delete)
// ---------------------------------------------------------------------------

type MemFs = FsAdapter & { _files: Map<string, string> };

function makeMemoryFs(): MemFs {
  const files = new Map<string, string>();
  const doc = 'file:///doc/';
  return {
    documentDirectory: doc,
    _files: files,
    async makeDirectoryAsync() {},
    async writeAsStringAsync(path, contents) {
      files.set(path, contents);
    },
    async readAsStringAsync(path) {
      if (!files.has(path)) throw new Error('ENOENT ' + path);
      return files.get(path)!;
    },
    async copyAsync({ from, to }) {
      if (!files.has(from)) throw new Error('ENOENT ' + from);
      files.set(to, files.get(from)!);
    },
    async getInfoAsync(path): Promise<FsFileInfo> {
      if (files.has(path)) return { exists: true, size: files.get(path)!.length };
      return { exists: false };
    },
    async deleteAsync(path) {
      for (const k of [...files.keys()]) {
        if (k === path || k.startsWith(path)) files.delete(k);
      }
    },
    async readDirectoryAsync(path) {
      const norm = path.endsWith('/') ? path : path + '/';
      const names = new Set<string>();
      for (const k of files.keys()) {
        if (!k.startsWith(norm)) continue;
        const seg = k.slice(norm.length).split('/')[0];
        if (seg) names.add(seg);
      }
      if (names.size === 0) throw new Error('ENOENT ' + path);
      return [...names];
    },
  };
}

function seedEntry(
  fs: MemFs,
  id: string,
  swingId: string | null,
  kind: 'video' | 'pose' = 'video',
): void {
  const meta: OutboxMeta = {
    id,
    kind,
    swingId,
    copyComplete: true,
    payloadFile: kind === 'video' ? 'video.mov' : 'pose.json',
    createdAt: '2026-07-05T00:00:00.000Z',
    attempts: 0,
    zeroRowAttempts: 0,
    nextEligibleAt: '2026-07-05T00:00:00.000Z',
    bytes: 3,
    md5: null,
    code: null,
  };
  fs._files.set(`file:///doc/outbox/${id}/meta.json`, JSON.stringify(meta));
  fs._files.set(`file:///doc/outbox/${id}/${meta.payloadFile}`, 'abc');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const emitted: string[] = [];
  __setEmitForTesting((p) => emitted.push(p.message));

  group('purges only the target swingId');
  {
    __resetForTesting();
    const fs = makeMemoryFs();
    __setFsForTesting(fs);
    seedEntry(fs, 'e1', 'target', 'video');
    seedEntry(fs, 'e2', 'other', 'video');
    seedEntry(fs, 'e3', null, 'video'); // pending — must be skipped
    fs._files.set('file:///doc/outbox/dead/d1', '{}'); // dead ledger untouched

    await purgeOutboxEntriesForSwing('target');

    const remaining = (await __listEntriesForTesting()).map((m) => m.id).sort();
    assertEq(remaining.join(','), 'e2,e3', 'e1 purged; other + pending survive');
    assert(!fs._files.has('file:///doc/outbox/e1/meta.json'), 'e1 meta removed');
    assert(!fs._files.has('file:///doc/outbox/e1/video.mov'), 'e1 payload removed');
    assert(fs._files.has('file:///doc/outbox/dead/d1'), 'dead-letter ledger untouched');
  }

  group('purges BOTH kinds for one swing (video + pose)');
  {
    __resetForTesting();
    const fs = makeMemoryFs();
    __setFsForTesting(fs);
    seedEntry(fs, 'v1', 'swing-9', 'video');
    seedEntry(fs, 'p1', 'swing-9', 'pose');
    seedEntry(fs, 'v2', 'swing-8', 'video');

    await purgeOutboxEntriesForSwing('swing-9');

    const remaining = (await __listEntriesForTesting()).map((m) => m.id);
    assertEq(remaining.join(','), 'v2', 'both swing-9 entries dropped, swing-8 kept');
  }

  group('no telemetry / no dead-letter');
  {
    assertEq(emitted.length, 0, 'no error.captured emitted by any purge');
  }

  group('no outbox dir yet');
  {
    __resetForTesting();
    __setFsForTesting(makeMemoryFs());
    let threw = false;
    try {
      await purgeOutboxEntriesForSwing('anything');
    } catch {
      threw = true;
    }
    assertEq(threw, false, 'resolves cleanly when outbox/ does not exist');
  }

  __setFsForTesting(null);
  __resetForTesting();

  // ---- summary ----
  console.log(`\n════════════════════════════════════════`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
