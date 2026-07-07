/**
 * outbox.test.ts — durable write-outbox validation.
 *
 * Run with: npx tsx lib/outbox.test.ts
 *
 * No jest — project-standard hand-rolled harness (see eventBus.test.ts). FS,
 * Supabase, clock, jitter, emit and scheduler are injected as in-memory
 * adapters so the engine is exercised deterministically. Expected values are
 * derived from the implementation under test; user-facing strings (dead-letter
 * failureReason, error.captured scope) are asserted exactly.
 */

import {
  captureVideoOutbox,
  capturePoseOutbox,
  attachSwingId,
  abandonPending,
  drainOutbox,
  runVideoUpload,
  runPoseUpdate,
  POSE_SOURCE_TAG,
  type FsAdapter,
  type FsFileInfo,
  type OutboxSupabaseAdapter,
  type OutboxMeta,
  type DeadLetterRecord,
  type StorageUploadError,
  type PgError,
  __setFsForTesting,
  __setSupabaseForTesting,
  __setClockForTesting,
  __setEmitForTesting,
  __setSchedulerForTesting,
  __setConnectivityForTesting,
  __resetForTesting,
  __listEntriesForTesting,
  __sweepForTesting,
} from './outbox';
import { uploadSwingVideo } from './uploadSwingVideo';
import { persistPoseFull } from './persistPoseFull';
import type { Rtmw133Frame } from '../packages/pose/rtmw/Rtmw133Frame';

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

const flush = async (times = 12): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------
// In-memory FS adapter
// ---------------------------------------------------------------------------

type MemFs = FsAdapter & {
  _files: Map<string, string>;
  _seedFile(path: string, content: string): void;
  _copyGate: Promise<void> | null;
  _metaWriteGate: Promise<void> | null;
};

function makeMemoryFs(): MemFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const mtimes = new Map<string, number>();
  let clock = 0;
  const doc = 'file:///doc/';

  const fs: MemFs = {
    documentDirectory: doc,
    _files: files,
    _copyGate: null,
    _metaWriteGate: null,
    _seedFile(path, content) {
      files.set(path, content);
      mtimes.set(path, ++clock);
    },
    async makeDirectoryAsync(path) {
      dirs.add(path);
    },
    async writeAsStringAsync(path, contents) {
      if (fs._metaWriteGate && path.endsWith('meta.json')) await fs._metaWriteGate;
      files.set(path, contents);
      mtimes.set(path, ++clock);
    },
    async readAsStringAsync(path) {
      if (!files.has(path)) throw new Error('ENOENT ' + path);
      return files.get(path)!;
    },
    async copyAsync({ from, to }) {
      if (fs._copyGate) await fs._copyGate;
      if (!files.has(from)) throw new Error('ENOENT ' + from);
      files.set(to, files.get(from)!);
      mtimes.set(to, ++clock);
    },
    async getInfoAsync(path): Promise<FsFileInfo> {
      if (files.has(path)) {
        const c = files.get(path)!;
        return {
          exists: true,
          size: c.length,
          md5: `md5-${c.length}`,
          modificationTime: mtimes.get(path) ?? 0,
        };
      }
      return { exists: false };
    },
    async deleteAsync(path) {
      for (const k of [...files.keys()]) {
        if (k === path || k.startsWith(path)) {
          files.delete(k);
          mtimes.delete(k);
        }
      }
      for (const d of [...dirs]) {
        if (d === path || d.startsWith(path)) dirs.delete(d);
      }
    },
    async readDirectoryAsync(path) {
      const norm = path.endsWith('/') ? path : path + '/';
      const all = [...files.keys(), ...dirs];
      const matches = all.filter((k) => k.startsWith(norm) && k !== norm);
      if (matches.length === 0 && !dirs.has(norm)) throw new Error('ENOENT ' + path);
      const names = new Set<string>();
      for (const k of matches) {
        const seg = k.slice(norm.length).split('/')[0];
        if (seg) names.add(seg);
      }
      return [...names];
    },
  };
  return fs;
}

// ---------------------------------------------------------------------------
// In-memory Supabase adapter
// ---------------------------------------------------------------------------

type SbCalls = {
  upload: string[];
  updateVideo: string[];
  selectPose: string[];
  updatePose: string[];
};
type SbOpts = {
  userId?: string | null;
  uploadVideo?: (path: string, calls: SbCalls) => { error: StorageUploadError };
  updateVideo?: (swingId: string, calls: SbCalls) => { rowCount: number; error: PgError };
  selectPose?: (
    swingId: string,
    calls: SbCalls,
  ) => { poseSource: string | null; error: PgError };
  updatePose?: (swingId: string, calls: SbCalls) => { rowCount: number; error: PgError };
};

function makeSupabase(opts: SbOpts = {}): OutboxSupabaseAdapter & { calls: SbCalls } {
  const calls: SbCalls = { upload: [], updateVideo: [], selectPose: [], updatePose: [] };
  return {
    calls,
    async getUserId() {
      return opts.userId === undefined ? 'user-1' : opts.userId;
    },
    async uploadVideo(storagePath) {
      calls.upload.push(storagePath);
      return opts.uploadVideo ? opts.uploadVideo(storagePath, calls) : { error: null };
    },
    async updateVideoColumns(swingId) {
      calls.updateVideo.push(swingId);
      return opts.updateVideo ? opts.updateVideo(swingId, calls) : { rowCount: 1, error: null };
    },
    async selectPoseSource(swingId) {
      calls.selectPose.push(swingId);
      return opts.selectPose
        ? opts.selectPose(swingId, calls)
        : { poseSource: null, error: null };
    },
    async updatePose(swingId) {
      calls.updatePose.push(swingId);
      return opts.updatePose ? opts.updatePose(swingId, calls) : { rowCount: 1, error: null };
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

type Emit = { scope: string; message: string; context: Record<string, unknown> };

let nowVal = 1_700_000_000_000;
function setNow(v: number): void {
  nowVal = v;
}
function advance(ms: number): void {
  nowVal += ms;
}

function base(
  sbOpts: SbOpts = {},
  jitterVal = 0.5,
): {
  fs: MemFs;
  sb: OutboxSupabaseAdapter & { calls: SbCalls };
  emits: Emit[];
} {
  __resetForTesting();
  nowVal = 1_700_000_000_000;
  const fs = makeMemoryFs();
  const sb = makeSupabase(sbOpts);
  const emits: Emit[] = [];
  __setFsForTesting(fs);
  __setSupabaseForTesting(sb);
  __setClockForTesting(
    () => nowVal,
    () => jitterVal,
  );
  __setEmitForTesting((p) => emits.push(p));
  __setSchedulerForTesting(() => null); // no-op timer — never fires during tests
  return { fs, sb, emits };
}

function frames(n = 2): Rtmw133Frame[] {
  return Array.from({ length: n }, (_, i) => ({
    timestampMs: i * 33,
    keypoints: Array.from({ length: 133 }, (_, k) => ({ x: k, y: k, confidence: 0.9 })),
    frameWidth: 256,
    frameHeight: 192,
  }));
}

function metaPath(fs: MemFs, id: string): string {
  return `${fs.documentDirectory}outbox/${id}/meta.json`;
}
function deadPath(fs: MemFs, id: string): string {
  return `${fs.documentDirectory}outbox/dead/${id}.json`;
}
async function readMetaDirect(fs: MemFs, id: string): Promise<OutboxMeta | null> {
  const raw = fs._files.get(metaPath(fs, id));
  return raw ? (JSON.parse(raw) as OutboxMeta) : null;
}

/** Seed a complete entry directly on disk (bypasses capture). */
function seedEntry(fs: MemFs, meta: OutboxMeta, payload: string): void {
  fs._seedFile(`${fs.documentDirectory}outbox/${meta.id}/${meta.payloadFile}`, payload);
  fs._seedFile(metaPath(fs, meta.id), JSON.stringify(meta));
}
function baseMeta(over: Partial<OutboxMeta>): OutboxMeta {
  return {
    id: 'seed',
    kind: 'pose',
    swingId: 'swing-x',
    copyComplete: true,
    payloadFile: 'pose.json',
    createdAt: new Date(nowVal).toISOString(),
    attempts: 0,
    zeroRowAttempts: 0,
    nextEligibleAt: new Date(nowVal).toISOString(),
    bytes: 100,
    md5: null,
    code: null,
    ...over,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

async function run(): Promise<void> {
  // 1 — Offline-capture durability ------------------------------------------
  group('1. offline-capture durability');
  {
    const { fs } = base({ uploadVideo: () => ({ error: { message: 'offline' } }) });
    fs._seedFile('file:///tmp/clip.mov', 'AAAA'); // valid base64
    const id = captureVideoOutbox('/tmp/clip.mov');
    await flush();
    const meta = await readMetaDirect(fs, id);
    assert(meta !== null, 'entry persisted');
    assert(meta?.swingId === null, 'swingId starts null (pending)');
    assertEq(meta?.copyComplete ?? false, true, 'copyComplete flips true after copy');
    assert((meta?.bytes ?? 0) > 0, 'bytes computed once at copy');
    assert(meta?.md5 != null, 'md5 computed once at copy');
    assertEq(meta?.payloadFile ?? '', 'video.mov', 'relative payloadFile only (HC3)');
    assert(fs._files.has(`${fs.documentDirectory}outbox/${id}/video.mov`), 'payload copied into outbox');
  }

  // 2 — Pending skipped by drain --------------------------------------------
  group('2. pending entries skipped by drain');
  {
    const { fs, sb } = base();
    fs._seedFile('file:///tmp/clip.mov', 'AAAA');
    captureVideoOutbox('/tmp/clip.mov');
    await capturePoseOutbox(frames());
    await flush();
    const res = await drainOutbox();
    assertEq(res.attempted, 0, 'nothing attempted (both pending)');
    assertEq(sb.calls.upload.length, 0, 'no upload for pending video');
    assertEq(sb.calls.updatePose.length, 0, 'no pose update for pending pose');
  }

  // 3 — Kill-after-upload-before-row-update half-state ----------------------
  group('3. half-state: upload landed, row UPDATE failed, then idempotent recovery');
  {
    let phase = 0;
    const { fs, sb } = base({
      uploadVideo: () =>
        phase === 0 ? { error: null } : { error: { statusCode: '409', message: 'Duplicate' } },
      updateVideo: () =>
        phase === 0 ? (() => { throw new Error('network'); })() : { rowCount: 1, error: null },
    });
    fs._seedFile('file:///tmp/clip.mov', 'AAAA');
    const id = captureVideoOutbox('/tmp/clip.mov');
    await flush();
    attachSwingId([id], 'swing-3');
    await flush();

    await drainOutbox(); // phase 0: upload ok, update throws -> retry
    let meta = await readMetaDirect(fs, id);
    assert(meta !== null && meta.attempts === 1, 'entry survives with attempts=1');

    phase = 1;
    advance(60_000); // past backoff
    await drainOutbox(); // upload 409 -> treated uploaded; update ok -> done
    meta = await readMetaDirect(fs, id);
    assert(meta === null, 'entry deleted after idempotent recovery');
    assertEq(sb.calls.upload.length, 2, 'upload retried (2nd is 409 = treated uploaded)');
    assertEq(sb.calls.updateVideo.length, 2, 'UPDATE retried');
  }

  // 4 — Concurrent-trigger lock ---------------------------------------------
  group('4. concurrent drains share one in-flight lock');
  {
    const { sb } = base();
    await capturePoseOutbox(frames());
    const entries = await __listEntriesForTesting();
    attachSwingId(
      entries.map((e) => e.id),
      'swing-4',
    );
    await flush();
    const p1 = drainOutbox();
    const p2 = drainOutbox();
    assert(p1 === p2, 'second concurrent drain returns the in-flight promise');
    await Promise.all([p1, p2]);
    assertEq(sb.calls.updatePose.length, 1, 'entry handled exactly once');
  }

  // 5 — Pose idempotency precheck (tag-skip) --------------------------------
  group('5. pose precheck: pose_source===TAG => done-skip, no UPDATE');
  {
    const { fs, sb } = base({
      selectPose: () => ({ poseSource: POSE_SOURCE_TAG, error: null }),
    });
    const id = await capturePoseOutbox(frames());
    attachSwingId([id], 'swing-5');
    await flush();
    await drainOutbox();
    assertEq(sb.calls.selectPose.length, 1, 'precheck ran');
    assertEq(sb.calls.updatePose.length, 0, 'UPDATE skipped (already tagged)');
    assert((await readMetaDirect(fs, id)) === null, 'entry deleted (done)');
  }

  // 6 — Zero-row bounded -> dead-letter -------------------------------------
  group('6. 0-row UPDATE: bounded zeroRowAttempts then dead-letter zero_rows');
  {
    const { fs, sb, emits } = base({ updatePose: () => ({ rowCount: 0, error: null }) });
    const id = await capturePoseOutbox(frames());
    attachSwingId([id], 'swing-6');
    await flush();
    for (let i = 0; i < 5; i++) {
      advance(7 * 60 * 60 * 1000); // past any backoff
      await drainOutbox();
    }
    assertEq(sb.calls.updatePose.length, 5, 'tried ZERO_ROW_MAX(5) times');
    assert((await readMetaDirect(fs, id)) === null, 'entry removed after dead-letter');
    const deadRaw = fs._files.get(deadPath(fs, id));
    assert(deadRaw != null, 'dead-letter record written');
    const dead = JSON.parse(deadRaw!) as DeadLetterRecord;
    assertEq(dead.failureReason, 'zero_rows', 'failureReason exact');
    assertEq(dead.classification, 'zero_rows', 'classification exact');
    assertEq(dead.code, null, 'code null for zero_rows');
    assertEq(dead.attempts, 0, 'attempts counter untouched (separate from zeroRowAttempts)');
    const errs = emits.filter((e) => e.message === 'zero_rows');
    assertEq(errs.length, 1, 'one error.captured emitted');
    assertEq(errs[0]?.scope, 'outbox', 'error scope=outbox');
  }

  // 7 — Max-attempts dead-letter + telemetry shape --------------------------
  group('7. max-attempts dead-letter: record before payload delete + exact telemetry');
  {
    const { fs, sb, emits } = base({
      uploadVideo: () => ({ error: { statusCode: '500', message: 'boom' } }),
    });
    fs._seedFile('file:///tmp/clip.mov', 'AAAA');
    const id = captureVideoOutbox('/tmp/clip.mov');
    await flush();
    attachSwingId([id], 'swing-7');
    await flush();
    for (let i = 0; i < 8; i++) {
      advance(7 * 60 * 60 * 1000);
      await drainOutbox();
    }
    assertEq(sb.calls.upload.length, 8, 'tried MAX_ATTEMPTS(8) times');
    assert(!fs._files.has(`${fs.documentDirectory}outbox/${id}/video.mov`), 'payload dropped');
    const deadRaw = fs._files.get(deadPath(fs, id));
    assert(deadRaw != null, 'dead-letter record present (written before payload delete)');
    const dead = JSON.parse(deadRaw!) as DeadLetterRecord;
    assertEq(dead.failureReason, 'max_attempts', 'failureReason exact');
    assertEq(dead.classification, 'network_retryable', 'classification exact');
    assertEq(dead.code, '500', 'code = last StorageError.statusCode');
    assertEq(dead.kind, 'video', 'kind preserved');
    const err = emits.find((e) => e.message === 'max_attempts');
    assert(err != null, 'error.captured emitted');
    assertEq(err?.scope, 'outbox', 'scope=outbox');
    const ctx = err?.context ?? {};
    const ctxKeys = Object.keys(ctx).sort().join(',');
    assertEq(
      ctxKeys,
      ['attempts', 'bytes', 'classification', 'code', 'failureReason', 'kind', 'md5', 'swingId'].join(','),
      'error context carries the exact dead-letter fields',
    );
    assertEq(ctx.swingId, 'swing-7', 'context swingId');
  }

  // 8 — Orphan sweep at bootstrap -------------------------------------------
  group('8. orphan sweep: orphan_pending + incomplete_copy');
  {
    const { fs, emits } = base();
    // stranded pending, older than 30min grace
    const oldPending = baseMeta({
      id: 'orphan-1',
      kind: 'pose',
      swingId: null,
      copyComplete: true,
      createdAt: new Date(nowVal - 31 * 60 * 1000).toISOString(),
    });
    seedEntry(fs, oldPending, JSON.stringify(frames()));
    // incomplete copy (copyComplete false)
    const incomplete = baseMeta({
      id: 'incomplete-1',
      kind: 'video',
      swingId: null,
      copyComplete: false,
      payloadFile: 'video.mov',
    });
    seedEntry(fs, incomplete, 'AAAA');

    await __sweepForTesting();

    assert((await readMetaDirect(fs, 'orphan-1')) === null, 'orphan_pending entry removed');
    assert((await readMetaDirect(fs, 'incomplete-1')) === null, 'incomplete_copy entry removed');
    const d1 = JSON.parse(fs._files.get(deadPath(fs, 'orphan-1'))!) as DeadLetterRecord;
    const d2 = JSON.parse(fs._files.get(deadPath(fs, 'incomplete-1'))!) as DeadLetterRecord;
    assertEq(d1.failureReason, 'orphan_pending', 'orphan reason exact');
    assertEq(d2.failureReason, 'incomplete_copy', 'incomplete reason exact');
    assertEq(emits.filter((e) => e.scope === 'outbox').length, 2, 'two telemetry emits');
  }

  // 9 — Reconcile: attachSwingId + abandonPending ---------------------------
  group('9. reconcile: attachSwingId stamps + drains; abandonPending deletes silently');
  {
    // Failing upload so the attach-triggered drain doesn't upload+delete the
    // entry before we inspect the stamped swingId.
    const { fs, emits } = base({ uploadVideo: () => ({ error: { message: 'offline' } }) });
    fs._seedFile('file:///tmp/clip.mov', 'AAAA');
    const id = captureVideoOutbox('/tmp/clip.mov');
    await flush();
    attachSwingId([id], 'swing-9');
    await flush();
    assertEq((await readMetaDirect(fs, id))?.swingId ?? 'X', 'swing-9', 'swingId attached');

    const id2 = await capturePoseOutbox(frames());
    await abandonPending([id2]);
    assert((await readMetaDirect(fs, id2)) === null, 'abandoned entry deleted');
    assert(!fs._files.has(deadPath(fs, id2)), 'abandon writes NO dead-letter');
    assertEq(emits.length, 0, 'abandon emits no telemetry');
  }

  // 10 — Backoff math (exponential + jitter, capped) ------------------------
  group('10. backoff: min(CAP, BASE*2^attempts) with jitter, capped at 6h');
  {
    const BASE = 2000;
    const CAP = 21_600_000;
    // jitter 0.5 -> factor (1 + 0.2*(0.5*2-1)) = 1.0
    const { fs } = base({ updatePose: () => ({ rowCount: 0, error: null }) }, 0.5);
    const m = baseMeta({ id: 'bo-1', swingId: 'swing-10', attempts: 0, zeroRowAttempts: 0 });
    seedEntry(fs, m, JSON.stringify(frames()));
    // G9: the zero-row retry backoff must GROW on zeroRowAttempts, not stay
    // frozen at BASE. Drive successive 0-row UPDATEs past each backoff and assert
    // 2s → 4s → 8s (BASE*2^0/^1/^2 = backoffIso(zeroRowAttempts-1)). The pre-G9
    // bug used backoffIso(attempts=0) and reported BASE on every retry, so
    // assertions #2 and #3 below FAIL against it — this is what protects the fix.
    for (let i = 0; i < 3; i++) {
      const t0 = nowVal; // backoffIso anchors nextEligibleAt on nowMs()=nowVal
      await drainOutbox(); // zero_row -> zeroRowAttempts++ -> backoffIso(zeroRowAttempts-1)
      const after = await readMetaDirect(fs, 'bo-1');
      assertEq(after!.zeroRowAttempts, i + 1, `zeroRowAttempts = ${i + 1} after drain ${i + 1}`);
      const delta = Date.parse(after!.nextEligibleAt) - t0;
      assertEq(delta, BASE * Math.pow(2, i), `zero-row backoff #${i + 1} = BASE*2^${i} (grows)`);
      advance(delta + 1); // past this backoff so the next drain is eligible
    }

    // Max reachable attempts is MAX_ATTEMPTS-1 = 7 (attempts>=8 dead-letters).
    // backoffIso(7) = BASE*2^7 = 256s, which stays under the 6h ceiling — the
    // cap is a defensive clamp that never engages at these constants.
    const { fs: fs2 } = base({ uploadVideo: () => ({ error: { message: 'x' } }) }, 0.5);
    const m2 = baseMeta({
      id: 'bo-2',
      kind: 'video',
      payloadFile: 'video.mov',
      swingId: 'swing-10b',
      attempts: 6,
      zeroRowAttempts: 0,
    });
    seedEntry(fs2, m2, 'AAAA');
    await drainOutbox(); // retry -> attempts=7 -> backoffIso(7)
    const after2 = await readMetaDirect(fs2, 'bo-2');
    const delta2 = Date.parse(after2!.nextEligibleAt) - nowVal;
    assertEq(delta2, BASE * Math.pow(2, 7), 'backoff = BASE*2^7 at max reachable attempts');
    assert(delta2 <= CAP, 'reachable backoff stays under the 6h ceiling');
  }

  // 11 — Dead-cap prune (oldest-first to bound) -----------------------------
  group('11. dead/ pruned oldest-first to DEAD_CAP(50)');
  {
    const { fs } = base({ updatePose: () => ({ rowCount: 0, error: { code: 'X', message: 'e' } }) });
    // pre-seed 55 dead files (mtime increasing with seed order)
    for (let i = 0; i < 55; i++) {
      fs._seedFile(`${fs.documentDirectory}outbox/dead/old-${String(i).padStart(2, '0')}.json`, '{}');
    }
    // one fresh dead-letter pushes total to 56 -> prune to 50
    const m = baseMeta({ id: 'dc-1', swingId: 'swing-11', attempts: 7 });
    seedEntry(fs, m, JSON.stringify(frames()));
    for (let i = 0; i < 8; i++) {
      advance(7 * 60 * 60 * 1000);
      await drainOutbox();
    }
    const deadNames = await fs.readDirectoryAsync(`${fs.documentDirectory}outbox/dead/`);
    assertEq(deadNames.length, 50, 'dead/ bounded to DEAD_CAP');
    assert(!deadNames.includes('old-00.json'), 'oldest dead-letter pruned first');
  }

  // 12 — Auth-gate parity (runPoseUpdate) -----------------------------------
  group('12. auth gate: getUserId null => retry, not zero_rows');
  {
    const { fs, sb } = base({ userId: null });
    const id = await capturePoseOutbox(frames());
    attachSwingId([id], 'swing-12');
    await flush();
    await drainOutbox();
    assertEq(sb.calls.selectPose.length, 0, 'no precheck when unauthenticated');
    assertEq(sb.calls.updatePose.length, 0, 'no UPDATE when unauthenticated');
    const meta = await readMetaDirect(fs, id);
    assertEq(meta?.attempts ?? -1, 1, 'counted as retry (attempts=1)');
    assertEq(meta?.zeroRowAttempts ?? -1, 0, 'zeroRowAttempts untouched (no false zero_rows)');
    assert(!fs._files.has(deadPath(fs, id)), 'no zero_rows dead-letter');
  }

  // 13 — Fallback regression (OUTBOX_ENABLED=false wrappers) ----------------
  group('13. fallback wrappers green end-to-end (rollback + Android path)');
  {
    // video success
    const a = base();
    a.fs._seedFile('file:///tmp/clip.mov', 'AAAA');
    await uploadSwingVideo('swing-13', '/tmp/clip.mov');
    assertEq(a.sb.calls.upload.length, 1, 'fallback upload ran once');
    assertEq(a.sb.calls.updateVideo.length, 1, 'fallback video UPDATE ran');

    // video 409 treated as uploaded
    const b = base({ uploadVideo: () => ({ error: { statusCode: '409', message: 'exists' } }) });
    b.fs._seedFile('file:///tmp/clip.mov', 'AAAA');
    await uploadSwingVideo('swing-13b', '/tmp/clip.mov');
    assertEq(b.sb.calls.updateVideo.length, 1, '409 => still runs idempotent UPDATE');

    // pose success
    const c = base();
    await persistPoseFull('swing-13c', frames());
    assertEq(c.sb.calls.selectPose.length, 1, 'fallback pose precheck ran');
    assertEq(c.sb.calls.updatePose.length, 1, 'fallback pose UPDATE ran');

    // pose forced non-done => terminal error.captured via event bus
    const evb = await import('./eventBus');
    evb.__resetForTesting();
    evb.__setStorageForTesting({ async getItem() { return null; }, async setItem() {} });
    evb.__setSupabaseForTesting({ async upsertEvents() { return { error: null }; }, async getUserId() { return 'u'; } });
    const captured: string[] = [];
    const off = evb.onAny((e) => { if (e.type === 'error.captured') captured.push(e.payload.scope); });
    const d = base({ updatePose: () => ({ rowCount: 0, error: null }) });
    await persistPoseFull('swing-13d', frames());
    assert(captured.includes('persist_pose_full'), 'fallback emits terminal persist_pose_full telemetry');
    assertEq(d.sb.calls.updatePose.length, 1, 'pose UPDATE attempted on the failing path');
    off();
    evb.__resetForTesting();
  }

  // 14 — RACE FIX: interleaved attachSwingId + copy-completion --------------
  group('14. race fix: concurrent attach + copy-completion keep BOTH fields');
  {
    // Failing upload so the copy-completion-triggered drain doesn't delete the
    // (now-eligible) entry before we inspect both fields.
    const { fs } = base({ uploadVideo: () => ({ error: { message: 'offline' } }) });
    fs._seedFile('file:///tmp/clip.mov', 'AAAA');
    let releaseCopy!: () => void;
    fs._copyGate = new Promise<void>((res) => {
      releaseCopy = res;
    });
    const id = captureVideoOutbox('/tmp/clip.mov'); // copy blocks on the gate
    await flush(); // create-link lands; copy is waiting
    attachSwingId([id], 'swing-14'); // stamps swingId while copy is in flight
    await flush();
    releaseCopy(); // copy-completion patch now runs (chained after attach)
    await flush();
    const meta = await readMetaDirect(fs, id);
    assertEq(meta?.swingId ?? 'LOST', 'swing-14', 'attached swingId preserved (not clobbered)');
    assertEq(meta?.copyComplete ?? false, true, 'copyComplete also set');
    assert((meta?.bytes ?? 0) > 0, 'bytes set by copy-completion');
  }

  // 15 — runVideoUpload duplicate/exists message path -----------------------
  group('15. runVideoUpload: /exist|duplicate/ message (no statusCode) => uploaded');
  {
    base({ uploadVideo: () => ({ error: { message: 'The resource already exists' } }) });
    const fsLocal = makeMemoryFs();
    fsLocal._seedFile('file:///tmp/clip.mov', 'AAAA');
    __setFsForTesting(fsLocal);
    const r = await runVideoUpload('swing-15', '/tmp/clip.mov');
    assertEq(r.outcome, 'done', 'message-only duplicate treated as uploaded then UPDATE ok');
  }

  // 16 — Offline drain skip (no attempt burn) -------------------------------
  group('16. known-offline drain leaves entries untouched; reconnect proceeds');
  {
    const { fs, sb } = base({ updatePose: () => ({ rowCount: 1, error: null }) });
    const m = baseMeta({ id: 'off-1', swingId: 'swing-16', attempts: 0, zeroRowAttempts: 0 });
    seedEntry(fs, m, JSON.stringify(frames()));

    __setConnectivityForTesting(false); // known offline
    const res = await drainOutbox();
    assertEq(res.attempted, 0, 'offline: nothing attempted');
    assertEq(sb.calls.updatePose.length, 0, 'offline: zero adapter calls');
    const stillThere = await readMetaDirect(fs, 'off-1');
    assertEq(stillThere?.attempts ?? -1, 0, 'offline: attempts unchanged (no burn)');
    assert(!fs._files.has(deadPath(fs, 'off-1')), 'offline: no dead-letter');

    __setConnectivityForTesting(true); // reconnect
    await drainOutbox();
    assertEq(sb.calls.updatePose.length, 1, 'reconnect: drain proceeds');
    assert((await readMetaDirect(fs, 'off-1')) === null, 'reconnect: entry drains to done');
  }

  // 17 — RACE FIX (2): attachSwingId fired BEFORE the initial meta write lands -
  group('17. race fix: attach before initial meta write still stamps swingId');
  {
    const { fs } = base({ uploadVideo: () => ({ error: { message: 'offline' } }) });
    fs._seedFile('file:///tmp/clip.mov', 'AAAA');
    let releaseMeta!: () => void;
    fs._metaWriteGate = new Promise<void>((res) => {
      releaseMeta = res;
    });
    const id = captureVideoOutbox('/tmp/clip.mov'); // create link blocks on the meta gate
    attachSwingId([id], 'swing-17'); // fired BEFORE the initial meta write lands
    await flush(); // attach queues behind the (blocked) create link
    releaseMeta(); // create's meta write completes; attach then runs; copy-completion last
    await flush();
    const meta = await readMetaDirect(fs, id);
    assertEq(meta?.swingId ?? 'LOST', 'swing-17', 'swingId stamped despite attach racing the create');
    assertEq(meta?.copyComplete ?? false, true, 'copyComplete still set after the chain drains');
  }

  // ---- summary ----
  console.log(`\n════════════════════════════════════════`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('test harness crashed:', err);
  process.exit(1);
});
