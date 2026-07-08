/**
 * outbox.ts — durable write-outbox for swing video + pose_full.
 *
 * persistPoseFull (200-360 KB pose_full JSONB) and uploadSwingVideo (4-5 MB
 * video) were fire-and-forget writes with inline 3-attempt retry loops that did
 * NOT survive process death — kill the app mid-retry and the write was lost.
 *
 * This engine persists each pending write to documentDirectory/outbox/<id>/
 * (meta.json + payload), retries with cross-restart exponential backoff, drains
 * on lifecycle/network edges behind a single in-flight lock, and dead-letters
 * with telemetry on terminal failure. The on-disk directory IS the index —
 * there is no AsyncStorage index and no sync table.
 *
 * Capture is decoupled from BOTH swingId and network: the video is copied into
 * the outbox as early as recording-finish (before the up-to-45s extraction),
 * meta.swingId starts null (pending, skipped by drain), and is reconciled via
 * attachSwingId once persistSwing's network insert resolves a swingId.
 *
 * FS / Supabase / clock / emit / scheduler are injectable adapters so the whole
 * engine is testable under the plain tsx runner (mirrors lib/eventBus.ts).
 */

import { decode } from 'base64-arraybuffer';
import type { Rtmw133Frame } from '../packages/pose/rtmw/Rtmw133Frame';

// Lazy require for ./supabase, ./eventBus, react-native, expo-file-system —
// those transitively load native/@clerk modules that can't run under the plain
// tsx test runner. Declaring require here so tsc accepts it under strict mode.
declare function require(id: string): unknown;

// Source of truth for the pose-model identity tag. persistPoseFull.ts
// re-exports this for backward compatibility.
export const POSE_SOURCE_TAG = 'rtmw-l-2d-v1';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OutboxKind = 'video' | 'pose';

export type DrainOutcome = 'done' | 'zero_row' | 'retry';
export type DrainResult2 = { outcome: DrainOutcome; code: string | null };

export type FailureReason =
  | 'max_attempts'
  | 'zero_rows'
  | 'orphan_pending'
  | 'incomplete_copy';

export type Classification =
  | 'network_retryable'
  | 'zero_rows'
  | 'orphan_pending'
  | 'incomplete_copy';

export type OutboxMeta = {
  id: string; // entryId === directory name
  kind: OutboxKind;
  swingId: string | null; // null = PENDING (skipped by drain) until attachSwingId
  copyComplete: boolean; // video: temp->outbox copy finished; pose: always true
  payloadFile: string; // RELATIVE filename only: 'video.mov' | 'pose.json' (HC3)
  createdAt: string; // ISO; orphan-grace clock
  attempts: number; // generic retryable-failure counter
  zeroRowAttempts: number; // SEPARATE counter for 0-row UPDATE (insert lag)
  nextEligibleAt: string; // ISO; exponential-backoff gate (persisted across restart)
  bytes: number | null; // computed ONCE at copy/write completion
  md5: string | null; // computed ONCE (getInfoAsync {md5}) for video; null ok for pose
  code: string | null; // last failing attempt's statusCode / Postgres code; null otherwise
};

export type DeadLetterRecord = {
  swingId: string | null;
  kind: OutboxKind;
  failureReason: FailureReason;
  classification: Classification;
  code: string | null;
  attempts: number;
  bytes: number | null;
  md5: string | null;
};

export type OutboxDrainResult = {
  attempted: number;
  done: number;
  retried: number;
  deadLettered: number;
  remaining: number;
};

// ---------------------------------------------------------------------------
// Adapters (overridable for tests)
// ---------------------------------------------------------------------------

export type FsFileInfo = {
  exists: boolean;
  size?: number;
  md5?: string;
  modificationTime?: number;
};

export type FsAdapter = {
  documentDirectory: string;
  makeDirectoryAsync(path: string, opts: { intermediates: boolean }): Promise<void>;
  writeAsStringAsync(
    path: string,
    contents: string,
    opts?: { encoding?: 'utf8' | 'base64' },
  ): Promise<void>;
  readAsStringAsync(
    path: string,
    opts?: { encoding?: 'utf8' | 'base64' },
  ): Promise<string>;
  copyAsync(opts: { from: string; to: string }): Promise<void>;
  getInfoAsync(path: string, opts?: { md5?: boolean }): Promise<FsFileInfo>;
  deleteAsync(path: string, opts?: { idempotent?: boolean }): Promise<void>;
  readDirectoryAsync(path: string): Promise<string[]>;
};

export type StorageUploadError = {
  statusCode?: string;
  message?: string;
} | null;

export type PgError = { code?: string; message?: string } | null;

export type OutboxSupabaseAdapter = {
  getUserId(): Promise<string | null>;
  uploadVideo(
    storagePath: string,
    body: ArrayBuffer,
  ): Promise<{ error: StorageUploadError }>;
  updateVideoColumns(
    swingId: string,
    storagePath: string,
    uploadedAtIso: string,
  ): Promise<{ rowCount: number; error: PgError }>;
  selectPoseSource(
    swingId: string,
  ): Promise<{ poseSource: string | null; error: PgError }>;
  updatePose(
    swingId: string,
    frames: Rtmw133Frame[],
  ): Promise<{ rowCount: number; error: PgError }>;
};

export type EmitErrorFn = (payload: {
  scope: string;
  message: string;
  context: Record<string, unknown>;
}) => void;

export type Scheduler = (cb: () => void, ms: number) => unknown;

// ---------------------------------------------------------------------------
// Constants (EXTERNAL ASSUMPTIONS — see plan §5)
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 8; // > inline 3; spans multiple sessions with backoff
const ZERO_ROW_MAX = 5; // separate counter for 0-row UPDATE (insert lag)
const BACKOFF_BASE_MS = 2000; // first retry ~2s (matches old loops' magnitude)
const BACKOFF_CAP_MS = 21_600_000; // 6h ceiling
const JITTER_FRACTION = 0.2; // ±20% thundering-herd guard
const DEAD_CAP = 50; // bounded dead/ ledger
const ORPHAN_GRACE_MS = 1_800_000; // 30 min before dead-lettering stranded pending

const CLASSIFICATION: Record<FailureReason, Classification> = {
  max_attempts: 'network_retryable',
  zero_rows: 'zero_rows',
  orphan_pending: 'orphan_pending',
  incomplete_copy: 'incomplete_copy',
};

const VIDEO_PAYLOAD = 'video.mov';
const POSE_PAYLOAD = 'pose.json';

// ---------------------------------------------------------------------------
// Injectable state + production defaults
// ---------------------------------------------------------------------------

let fsAdapter: FsAdapter | null = null;
let supabaseAdapter: OutboxSupabaseAdapter | null = null;

let nowMs: () => number = () => Date.now();
let jitter: () => number = () => Math.random();

let emitError: EmitErrorFn = (payload) => {
  try {
    const mod = require('./eventBus') as {
      emit: (type: string, payload: unknown) => void;
    };
    mod.emit('error.captured', {
      scope: payload.scope,
      message: payload.message,
      context: payload.context,
    });
  } catch {
    // eventBus unavailable (e.g. test env without ./supabase) — drop telemetry.
  }
};

let scheduler: Scheduler = (cb, ms) => {
  const g = globalThis as { setTimeout?: (cb: () => void, ms: number) => unknown };
  return g.setTimeout ? g.setTimeout(cb, ms) : null;
};

function fs(): FsAdapter {
  if (fsAdapter) return fsAdapter;
  const FileSystem = require('expo-file-system/legacy') as {
    documentDirectory: string;
    makeDirectoryAsync: FsAdapter['makeDirectoryAsync'];
    writeAsStringAsync: FsAdapter['writeAsStringAsync'];
    readAsStringAsync: FsAdapter['readAsStringAsync'];
    copyAsync: FsAdapter['copyAsync'];
    getInfoAsync: FsAdapter['getInfoAsync'];
    deleteAsync: FsAdapter['deleteAsync'];
    readDirectoryAsync: FsAdapter['readDirectoryAsync'];
  };
  fsAdapter = {
    documentDirectory: FileSystem.documentDirectory,
    makeDirectoryAsync: FileSystem.makeDirectoryAsync,
    writeAsStringAsync: FileSystem.writeAsStringAsync,
    readAsStringAsync: FileSystem.readAsStringAsync,
    copyAsync: FileSystem.copyAsync,
    getInfoAsync: FileSystem.getInfoAsync,
    deleteAsync: FileSystem.deleteAsync,
    readDirectoryAsync: FileSystem.readDirectoryAsync,
  };
  return fsAdapter;
}

function sb(): OutboxSupabaseAdapter {
  if (supabaseAdapter) return supabaseAdapter;
  const mod = require('./supabase') as {
    supabase: {
      storage: {
        from(bucket: string): {
          upload(
            path: string,
            body: ArrayBuffer,
            opts: { contentType: string; upsert: boolean },
          ): Promise<{ error: { statusCode?: string; message?: string } | null }>;
        };
      };
      from(table: string): {
        update(values: Record<string, unknown>): {
          eq(
            col: string,
            val: string,
          ): {
            select(cols: string): Promise<{
              data: unknown[] | null;
              error: { code?: string; message?: string } | null;
            }>;
          };
        };
        select(cols: string): {
          eq(
            col: string,
            val: string,
          ): {
            maybeSingle(): Promise<{
              data: { pose_source: string | null } | null;
              error: { code?: string; message?: string } | null;
            }>;
          };
        };
      };
    };
    getUserId(): Promise<string | null>;
  };
  supabaseAdapter = {
    getUserId: () => mod.getUserId(),
    async uploadVideo(storagePath, body) {
      const { error } = await mod.supabase.storage
        .from('swing-videos')
        .upload(storagePath, body, {
          contentType: 'video/quicktime',
          upsert: false,
        });
      return { error: error ?? null };
    },
    async updateVideoColumns(swingId, storagePath, uploadedAtIso) {
      const { data, error } = await mod.supabase
        .from('swings')
        .update({
          video_storage_path: storagePath,
          video_uploaded_at: uploadedAtIso,
        })
        .eq('id', swingId)
        .select('id');
      return { rowCount: data?.length ?? 0, error: error ?? null };
    },
    async selectPoseSource(swingId) {
      const { data, error } = await mod.supabase
        .from('swings')
        .select('id,pose_source')
        .eq('id', swingId)
        .maybeSingle();
      return { poseSource: data?.pose_source ?? null, error: error ?? null };
    },
    async updatePose(swingId, frames) {
      const { data, error } = await mod.supabase
        .from('swings')
        .update({ pose_full: frames, pose_source: POSE_SOURCE_TAG })
        .eq('id', swingId)
        .select('id');
      return { rowCount: data?.length ?? 0, error: error ?? null };
    },
  };
  return supabaseAdapter;
}

// ---------------------------------------------------------------------------
// Module state (locks + timer)
// ---------------------------------------------------------------------------

let isDraining = false;
let drainPromise: Promise<OutboxDrainResult> | null = null;
let timerHandle: unknown = null;
let idCounter = 0;
let listenersWired = false;
// Last connectivity edge seen by the NetInfo listener. false => known offline:
// drain returns WITHOUT attempting (so a foregrounded offline session can't burn
// MAX_ATTEMPTS and dead-letter live payloads). null/unknown => proceed. The
// existing false->true NetInfo trigger drains on reconnect.
let lastKnownConnected: boolean | null = null;

// ---------------------------------------------------------------------------
// Path helpers (HC3 — reconstruct absolute paths from documentDirectory)
// ---------------------------------------------------------------------------

function outboxRoot(): string {
  return `${fs().documentDirectory}outbox/`;
}
function entryDir(id: string): string {
  return `${outboxRoot()}${id}/`;
}
function metaPath(id: string): string {
  return `${entryDir(id)}meta.json`;
}
function payloadPath(id: string, payloadFile: string): string {
  return `${entryDir(id)}${payloadFile}`;
}
function deadDir(): string {
  return `${outboxRoot()}dead/`;
}
function deadPath(id: string): string {
  return `${deadDir()}${id}.json`;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

function mintId(): string {
  const t = Math.floor(nowMs()).toString(36);
  const c = (idCounter++).toString(36);
  const r = Math.floor(jitter() * 1e9).toString(36);
  return `${t}-${c}-${r}`;
}

function byteLengthUtf8(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4; // surrogate pair → 4 UTF-8 bytes
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function ensureFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function backoffIso(attempts: number): string {
  const base = BACKOFF_BASE_MS * Math.pow(2, attempts);
  const capped = Math.min(BACKOFF_CAP_MS, base);
  const jittered = capped * (1 + JITTER_FRACTION * (jitter() * 2 - 1));
  return new Date(nowMs() + jittered).toISOString();
}

function cancelTimer(): void {
  const g = globalThis as { clearTimeout?: (h: unknown) => void };
  if (timerHandle != null && g.clearTimeout) g.clearTimeout(timerHandle);
  timerHandle = null;
}

// ---------------------------------------------------------------------------
// Meta + entry I/O
// ---------------------------------------------------------------------------

async function readMeta(id: string): Promise<OutboxMeta | null> {
  try {
    const raw = await fs().readAsStringAsync(metaPath(id), { encoding: 'utf8' });
    const m = JSON.parse(raw) as OutboxMeta;
    if (!m || typeof m.id !== 'string' || typeof m.kind !== 'string') return null;
    return m;
  } catch {
    return null;
  }
}

// Per-entry mutation lock. Without it, a read-modify-write patch is unsafe: a
// copy-completion patch (copyComplete/bytes/md5) and an attachSwingId patch
// (swingId) on the SAME video entry could interleave — the copy block reads
// meta before attach writes, then writes its stale snapshot back with
// swingId:null, clobbering the attached swingId. The entry would be stuck
// pending forever -> orphan_pending dead-letter -> payload lost. So every meta
// mutation (create / patch / delete) for an id chains onto that id's promise,
// guaranteeing each read sees the prior mutation's write.
const metaChains = new Map<string, Promise<unknown>>();

function serializeMeta<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = metaChains.get(id) ?? Promise.resolve();
  const resultP = prev.then(fn, fn); // run fn after prev settles (success or fail)
  const tail = resultP.then(
    () => {},
    () => {},
  ); // never rejects → keeps the chain alive
  metaChains.set(id, tail);
  void tail.then(() => {
    if (metaChains.get(id) === tail) metaChains.delete(id); // GC when idle
  });
  return resultP;
}

async function writeMetaRaw(m: OutboxMeta): Promise<void> {
  await fs().writeAsStringAsync(metaPath(m.id), JSON.stringify(m), {
    encoding: 'utf8',
  });
}

/** Serialized read-modify-write of the latest on-disk meta (no lost updates). */
function patchMeta(
  id: string,
  fn: (m: OutboxMeta) => void,
): Promise<OutboxMeta | null> {
  return serializeMeta(id, async () => {
    const m = await readMeta(id);
    if (!m) return null;
    fn(m);
    await writeMetaRaw(m);
    return m;
  });
}

/** Serialized entry-dir deletion (chains behind any pending meta mutation). */
function deleteEntryDir(id: string): Promise<void> {
  return serializeMeta(id, () => fs().deleteAsync(entryDir(id), { idempotent: true }));
}

/** Unserialized delete for ids with no live chain (junk-dir sweep). */
function rawDeleteEntryDir(id: string): Promise<void> {
  return fs().deleteAsync(entryDir(id), { idempotent: true });
}

async function listEntries(): Promise<OutboxMeta[]> {
  let names: string[];
  try {
    names = await fs().readDirectoryAsync(outboxRoot());
  } catch {
    return []; // outbox dir not created yet
  }
  const metas: OutboxMeta[] = [];
  for (const name of names) {
    if (name === 'dead') continue;
    const meta = await readMeta(name);
    if (meta) metas.push(meta);
  }
  return metas;
}

// ---------------------------------------------------------------------------
// Dead-letter
// ---------------------------------------------------------------------------

async function pruneDead(): Promise<void> {
  let names: string[];
  try {
    names = await fs().readDirectoryAsync(deadDir());
  } catch {
    return;
  }
  if (names.length <= DEAD_CAP) return;
  const withTime: { name: string; t: number }[] = [];
  for (const name of names) {
    let t = 0;
    try {
      const info = await fs().getInfoAsync(`${deadDir()}${name}`);
      t = info.modificationTime ?? 0;
    } catch {
      t = 0;
    }
    withTime.push({ name, t });
  }
  withTime.sort((a, b) => a.t - b.t); // oldest first
  const toDelete = withTime.slice(0, withTime.length - DEAD_CAP);
  for (const { name } of toDelete) {
    await fs()
      .deleteAsync(`${deadDir()}${name}`, { idempotent: true })
      .catch(() => {});
  }
}

async function deadLetter(meta: OutboxMeta, reason: FailureReason): Promise<void> {
  const record: DeadLetterRecord = {
    swingId: meta.swingId,
    kind: meta.kind,
    failureReason: reason,
    classification: CLASSIFICATION[reason],
    code: meta.code,
    attempts: meta.attempts,
    bytes: meta.bytes,
    md5: meta.md5,
  };
  await fs().makeDirectoryAsync(deadDir(), { intermediates: true });
  // Write the dead-letter record BEFORE dropping the payload (req 6).
  await fs().writeAsStringAsync(deadPath(meta.id), JSON.stringify(record), {
    encoding: 'utf8',
  });
  await deleteEntryDir(meta.id);
  await pruneDead();
  emitError({ scope: 'outbox', message: reason, context: { ...record } });
}

// ---------------------------------------------------------------------------
// Write+idempotency handler bodies (shared by engine AND fallback wrappers)
// ---------------------------------------------------------------------------

export async function runVideoUpload(
  swingId: string,
  absVideoPath: string,
): Promise<DrainResult2> {
  const userId = await sb().getUserId();
  if (!userId) return { outcome: 'retry', code: null };

  let body: ArrayBuffer;
  try {
    const b64 = await fs().readAsStringAsync(ensureFileUri(absVideoPath), {
      encoding: 'base64',
    });
    body = decode(b64);
  } catch {
    return { outcome: 'retry', code: null };
  }

  const storagePath = `${userId}/${swingId}.mov`;
  const { error } = await sb().uploadVideo(storagePath, body);
  if (error) {
    const statusCode = error.statusCode;
    const msg = error.message ?? '';
    // 409 / already-exists from a prior attempt => treat as uploaded. Preserve
    // BOTH the string statusCode check AND the message regex (V6) — backends
    // differ in which field they populate.
    const isDuplicate = statusCode === '409' || /exist|duplicate/i.test(msg);
    if (!isDuplicate) return { outcome: 'retry', code: statusCode ?? null };
  }

  // Uploaded OR already-exists => run the UPDATE regardless (idempotent).
  const upd = await sb().updateVideoColumns(swingId, storagePath, nowIso());
  if (upd.error) return { outcome: 'retry', code: upd.error.code ?? null };
  if (upd.rowCount === 0) return { outcome: 'zero_row', code: null };
  return { outcome: 'done', code: null };
}

export async function runPoseUpdate(
  swingId: string,
  frames: Rtmw133Frame[],
): Promise<DrainResult2> {
  // AUTH GATE PARITY with runVideoUpload: an expired/changed session makes RLS
  // filter the UPDATE -> 0 rows, which would wrongly burn zeroRowAttempts and
  // dead-letter as 'zero_rows' with the payload lost. Gate first -> 'retry'.
  const userId = await sb().getUserId();
  if (!userId) return { outcome: 'retry', code: null };

  const pre = await sb().selectPoseSource(swingId); // never selects pose_full (V14)
  if (pre.error) return { outcome: 'retry', code: pre.error.code ?? null };
  // NULL pose_source is overloaded (pre-RTMW OR failed write) — match the TAG
  // only, never "is null / not null".
  if (pre.poseSource === POSE_SOURCE_TAG) return { outcome: 'done', code: null };

  const upd = await sb().updatePose(swingId, frames);
  if (upd.error) return { outcome: 'retry', code: upd.error.code ?? null };
  if (upd.rowCount === 0) return { outcome: 'zero_row', code: null };
  return { outcome: 'done', code: null };
}

// ---------------------------------------------------------------------------
// Capture (decoupled: independent of swingId AND network)
// ---------------------------------------------------------------------------

/**
 * Hot path. entryId is minted SYNCHRONOUSLY and returned immediately.
 * expo-file-system/legacy has no synchronous write, so persistence is async:
 * meta.json is written first (un-awaited), then copyAsync is chained after the
 * meta write resolves (meta-before-payload, so a half-written entry is never
 * copyComplete). Returns before either lands so the up-to-45s extraction (which
 * reads the ORIGINAL temp path) is never blocked. On copy finish: compute
 * bytes+md5, set copyComplete:true, fire one un-awaited drain.
 *   - Kill AFTER meta lands, mid-copy => copyComplete:false => orphan sweep
 *     dead-letters 'incomplete_copy'.
 *   - Kill BEFORE meta lands => no entry on disk; acceptable (equivalent to
 *     today's loss window, far smaller than the extraction/upload window).
 */
export function captureVideoOutbox(tempVideoPath: string): string {
  const id = mintId();
  const meta: OutboxMeta = {
    id,
    kind: 'video',
    swingId: null,
    copyComplete: false,
    payloadFile: VIDEO_PAYLOAD,
    createdAt: nowIso(),
    attempts: 0,
    zeroRowAttempts: 0,
    nextEligibleAt: nowIso(),
    bytes: null,
    md5: null,
    code: null,
  };

  // Register the create link SYNCHRONOUSLY (before returning) so any later
  // attachSwingId patch is guaranteed to chain after the initial meta write.
  const created = serializeMeta(id, async () => {
    await fs().makeDirectoryAsync(entryDir(id), { intermediates: true });
    await writeMetaRaw(meta); // meta lands first
  });

  void (async () => {
    await created;
    const to = payloadPath(id, VIDEO_PAYLOAD);
    await fs().copyAsync({ from: ensureFileUri(tempVideoPath), to }); // OUTSIDE lock (slow, no meta touch)
    const info = await fs().getInfoAsync(to, { md5: true });
    await patchMeta(id, (m) => {
      // Re-reads the latest meta inside the lock — preserves a swingId that
      // attachSwingId may have set while the copy was in flight.
      m.copyComplete = true;
      m.bytes = info.exists ? info.size ?? null : null;
      m.md5 = info.exists ? info.md5 ?? null : null;
    });
    // Background copy-completion trigger: a video whose copy finishes after its
    // attachSwingId pass must not wait for the next lifecycle edge (req 4).
    void drainOutbox().catch(() => {});
  })().catch((err) =>
    console.warn('[outbox] captureVideoOutbox persist failed:', err),
  );

  return id;
}

/**
 * Post-extraction. AWAITED write = durable (pose is already in memory; no temp
 * race). Writes pose.json + meta.json, resolves with entryId. payload is
 * written before meta so a complete entry always has meta last.
 */
export async function capturePoseOutbox(frames: Rtmw133Frame[]): Promise<string> {
  const id = mintId();
  const json = JSON.stringify(frames);
  const meta: OutboxMeta = {
    id,
    kind: 'pose',
    swingId: null,
    copyComplete: true,
    payloadFile: POSE_PAYLOAD,
    createdAt: nowIso(),
    attempts: 0,
    zeroRowAttempts: 0,
    nextEligibleAt: nowIso(),
    bytes: byteLengthUtf8(json),
    md5: null,
    code: null,
  };
  await serializeMeta(id, async () => {
    await fs().makeDirectoryAsync(entryDir(id), { intermediates: true });
    await fs().writeAsStringAsync(payloadPath(id, POSE_PAYLOAD), json, {
      encoding: 'utf8',
    });
    await writeMetaRaw(meta); // meta last → a meta-bearing entry is always complete
  });
  return id;
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Insert resolved a swingId: stamp it onto the pending entries, fire ONE
 * un-awaited drain (trigger d). No-op for unknown/already-reconciled ids.
 */
export function attachSwingId(entryIds: string[], swingId: string): void {
  void (async () => {
    for (const id of entryIds) {
      await patchMeta(id, (m) => {
        if (m.swingId === null) m.swingId = swingId;
      });
    }
    void drainOutbox().catch(() => {});
  })().catch((err) => console.warn('[outbox] attachSwingId failed:', err));
}

/**
 * Insert returned null (anonymous / failed) OR capture invalid: these entries
 * can NEVER reconcile -> delete dir + payload. NOT a failure: no dead-letter,
 * no telemetry (expected for anonymous users).
 */
export async function abandonPending(entryIds: string[]): Promise<void> {
  for (const id of entryIds) {
    await deleteEntryDir(id).catch(() => {});
  }
}

/**
 * Per-swing delete support: drop every entry reconciled to this swingId so a
 * queued video/pose entry can't re-upload after the row + storage object are
 * deleted (the re-upload's 0-row UPDATE would burn zeroRowAttempts and
 * dead-letter as 'zero_rows'). Same contract as abandonPending: dir + payload
 * removed, NO dead-letter, NO telemetry — intentional deletion, not a failure.
 * Entries still pending (swingId null) are left alone: they belong to a
 * capture that hasn't reconciled and are the orphan sweep's job.
 */
export async function purgeOutboxEntriesForSwing(swingId: string): Promise<void> {
  const entries = await listEntries();
  const ids = entries.filter((e) => e.swingId === swingId).map((e) => e.id);
  await abandonPending(ids);
}

// ---------------------------------------------------------------------------
// Drain (single in-flight lock — mirrors eventBus isDraining/drainPromise)
// ---------------------------------------------------------------------------

function scheduleNextDrain(entries: OutboxMeta[]): void {
  cancelTimer();
  const now = nowMs();
  const future = entries
    .filter(
      (e) =>
        e.swingId !== null &&
        e.copyComplete &&
        e.attempts < MAX_ATTEMPTS &&
        e.zeroRowAttempts < ZERO_ROW_MAX,
    )
    .map((e) => Date.parse(e.nextEligibleAt))
    .filter((t) => Number.isFinite(t) && t > now);
  if (future.length === 0) return;
  const soonest = Math.min(...future);
  timerHandle = scheduler(() => {
    void drainOutbox().catch(() => {});
  }, Math.max(0, soonest - now));
}

export function drainOutbox(): Promise<OutboxDrainResult> {
  if (isDraining && drainPromise) return drainPromise;
  isDraining = true;
  drainPromise = (async () => {
    let attempted = 0;
    let done = 0;
    let retried = 0;
    let deadLettered = 0;
    try {
      const entries = await listEntries();
      // Known-offline: leave every entry untouched (no attempt, no increment, no
      // reschedule). Reconnect re-drains via the false->true NetInfo trigger.
      if (lastKnownConnected === false) {
        return { attempted: 0, done: 0, retried: 0, deadLettered: 0, remaining: entries.length };
      }
      const now = nowMs();
      const eligible = entries.filter(
        (e) =>
          e.swingId !== null && // pending skipped (req 3)
          e.copyComplete && // mid-copy skipped (req 3)
          e.attempts < MAX_ATTEMPTS &&
          e.zeroRowAttempts < ZERO_ROW_MAX &&
          parseEligible(e.nextEligibleAt) <= now, // backoff gate (req 6)
      );

      for (const e of eligible) {
        attempted++;
        let result: DrainResult2;
        try {
          if (e.kind === 'video') {
            result = await runVideoUpload(e.swingId!, payloadPath(e.id, e.payloadFile));
          } else {
            const frames = await readPoseFrames(e);
            result = await runPoseUpdate(e.swingId!, frames);
          }
        } catch {
          result = { outcome: 'retry', code: null }; // thrown = network
        }

        e.code = result.code; // persisted; last failing attempt wins

        if (result.outcome === 'done') {
          await deleteEntryDir(e.id);
          done++;
        } else if (result.outcome === 'zero_row') {
          e.zeroRowAttempts++;
          if (e.zeroRowAttempts >= ZERO_ROW_MAX) {
            await deadLetter(e, 'zero_rows');
            deadLettered++;
          } else {
            // Back off on the zero-row counter, not e.attempts (which this
            // branch never increments) — otherwise the backoff stayed frozen at
            // BACKOFF_BASE and ZERO_ROW_MAX retries burned in ~15s, dead-lettering
            // on a transient insert-lag / RLS hiccup (G9). `-1` keeps the first
            // retry fast (insert lag usually clears quickly) then grows:
            // 2s → 4s → 8s → 16s …
            e.nextEligibleAt = backoffIso(e.zeroRowAttempts - 1);
            await persistDrainDeltas(e);
            retried++;
          }
        } else {
          e.attempts++;
          if (e.attempts >= MAX_ATTEMPTS) {
            await deadLetter(e, 'max_attempts');
            deadLettered++;
          } else {
            e.nextEligibleAt = backoffIso(e.attempts);
            await persistDrainDeltas(e);
            retried++;
          }
        }
      }

      const remainingEntries = await listEntries();
      // G6: an entry can become eligible DURING this in-flight drain — a new
      // capture's attachSwingId fires a drain that coalesces into this one
      // (returns the running promise), or a backoff expires mid-drain. It was
      // not in the start-of-drain snapshot, and scheduleNextDrain only arms
      // FUTURE timers, so it would otherwise wait for the next external edge
      // (foreground / reconnect). Re-drain immediately when one is eligible now.
      const nowEnd = nowMs();
      const eligibleNow = remainingEntries.some(
        (e) =>
          e.swingId !== null &&
          e.copyComplete &&
          e.attempts < MAX_ATTEMPTS &&
          e.zeroRowAttempts < ZERO_ROW_MAX &&
          parseEligible(e.nextEligibleAt) <= nowEnd,
      );
      if (eligibleNow) {
        cancelTimer();
        // 0ms one-shot: runs after the finally below resets isDraining.
        timerHandle = scheduler(() => {
          void drainOutbox().catch(() => {});
        }, 0);
      } else {
        scheduleNextDrain(remainingEntries); // req 4(e) self-rescheduling one-shot
      }
      return {
        attempted,
        done,
        retried,
        deadLettered,
        remaining: remainingEntries.length,
      };
    } finally {
      isDraining = false;
      drainPromise = null;
    }
  })();
  return drainPromise;
}

function parseEligible(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

async function readPoseFrames(e: OutboxMeta): Promise<Rtmw133Frame[]> {
  const raw = await fs().readAsStringAsync(payloadPath(e.id, e.payloadFile), {
    encoding: 'utf8',
  });
  return JSON.parse(raw) as Rtmw133Frame[];
}

/** Serialized write of the drain-owned fields onto the latest meta. */
function persistDrainDeltas(e: OutboxMeta): Promise<OutboxMeta | null> {
  return patchMeta(e.id, (m) => {
    m.code = e.code;
    m.attempts = e.attempts;
    m.zeroRowAttempts = e.zeroRowAttempts;
    m.nextEligibleAt = e.nextEligibleAt;
  });
}

// ---------------------------------------------------------------------------
// Bootstrap + lifecycle triggers
// ---------------------------------------------------------------------------

/** Orphan sweep: dead-letter stranded pending + incomplete-copy entries. */
async function sweepOrphans(): Promise<void> {
  let names: string[];
  try {
    names = await fs().readDirectoryAsync(outboxRoot());
  } catch {
    return;
  }
  const now = nowMs();
  for (const name of names) {
    if (name === 'dead') continue;
    const meta = await readMeta(name);
    if (!meta) {
      // junk dir from an interrupted write (payload but no meta) — remove
      await rawDeleteEntryDir(name).catch(() => {});
      continue;
    }
    if (!meta.copyComplete) {
      // temp source is gone, copy unresumable — dead-letter immediately
      await deadLetter(meta, 'incomplete_copy');
      continue;
    }
    if (meta.swingId === null) {
      const created = Date.parse(meta.createdAt);
      if (!Number.isFinite(created) || now - created >= ORPHAN_GRACE_MS) {
        await deadLetter(meta, 'orphan_pending');
      }
    }
  }
}

/**
 * Piggyback the analytics queue on the outbox's lifecycle triggers (T4-96):
 * eventBus.drain()'s only internal trigger is a 5-minute interval, and JS
 * timers pause in background — without this, events from short sessions sit
 * undelivered for sessions. Lazy-require like emitError above so the engine
 * stays importable under the tsx test runner.
 */
function drainEventBus(): void {
  try {
    const mod = require('./eventBus') as { drain: () => Promise<unknown> };
    void mod.drain().catch(() => {});
  } catch {
    // eventBus unavailable (e.g. test env without ./supabase) — skip.
  }
}

function wireLifecycleListeners(): void {
  if (listenersWired) return;
  listenersWired = true;
  // (b) AppState foreground + (c) NetInfo false->true. Lazy-require so the
  // engine stays importable under the tsx test runner (no top-level RN import).
  try {
    const { AppState } = require('react-native') as {
      AppState: {
        addEventListener(type: string, cb: (state: string) => void): unknown;
      };
    };
    AppState.addEventListener('change', (state: string) => {
      if (state === 'active') {
        void drainOutbox().catch(() => {});
        drainEventBus();
      }
    });
  } catch {
    // RN unavailable — skip.
  }
  try {
    const NetInfo = (
      require('@react-native-community/netinfo') as {
        default: {
          addEventListener(cb: (s: { isConnected: boolean | null }) => void): unknown;
        };
      }
    ).default;
    NetInfo.addEventListener((s) => {
      const connected = s.isConnected === true;
      if (lastKnownConnected === false && connected) {
        void drainOutbox().catch(() => {});
        drainEventBus();
      }
      lastKnownConnected = connected;
    });
  } catch {
    // netinfo unavailable — skip.
  }
}

/**
 * Relaunch bootstrap (trigger a): orphan sweep, wire AppState 'active' +
 * NetInfo false->true, then drain. Safe to call once on app mount.
 * Also drains the analytics queue: the initial 'active' state never fires the
 * AppState change listener, so a relaunch would otherwise wait out eventBus's
 * 5-minute interval — and relaunch-after-a-short-session is exactly the case
 * where prior-session events are sitting undelivered.
 */
export function bootstrapOutbox(): void {
  void (async () => {
    await sweepOrphans();
    wireLifecycleListeners();
    drainEventBus();
    await drainOutbox();
  })().catch((err) => console.warn('[outbox] bootstrap failed:', err));
}

// ---------------------------------------------------------------------------
// Platform gate (lazy — avoids a top-level react-native import)
// ---------------------------------------------------------------------------

let cachedEnabled: boolean | null = null;

/**
 * iOS-gated (req 7). Default true on iOS; Android stays on the legacy fallback
 * path until the FS round-trip is device-verified on physical Android.
 */
export function outboxEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  try {
    const { Platform } = require('react-native') as { Platform: { OS: string } };
    cachedEnabled = Platform.OS === 'ios';
  } catch {
    cachedEnabled = false;
  }
  return cachedEnabled;
}

// ---------------------------------------------------------------------------
// Test-only exports (mirror eventBus)
// ---------------------------------------------------------------------------

export function __setFsForTesting(a: FsAdapter | null): void {
  fsAdapter = a;
}
export function __setSupabaseForTesting(a: OutboxSupabaseAdapter | null): void {
  supabaseAdapter = a;
}
export function __setClockForTesting(
  nowFn: () => number,
  jitterFn?: () => number,
): void {
  nowMs = nowFn;
  if (jitterFn) jitter = jitterFn;
}
export function __setEmitForTesting(fn: EmitErrorFn): void {
  emitError = fn;
}
export function __setSchedulerForTesting(fn: Scheduler): void {
  scheduler = fn;
  cancelTimer();
}
export function __resetForTesting(): void {
  isDraining = false;
  drainPromise = null;
  idCounter = 0;
  listenersWired = false;
  lastKnownConnected = null;
  metaChains.clear();
  cancelTimer();
}
export function __setConnectivityForTesting(connected: boolean | null): void {
  lastKnownConnected = connected;
}
export function __listEntriesForTesting(): Promise<OutboxMeta[]> {
  return listEntries();
}
export function __sweepForTesting(): Promise<void> {
  return sweepOrphans();
}
