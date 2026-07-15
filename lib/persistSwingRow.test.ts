/**
 * persistSwingRow.test.ts — behavior-neutrality snapshot for the Phase 1
 * buildSwingRow refactor (queue-until-login).
 *
 * Captures the exact row object handed to supabase.from('swings').insert()
 * and asserts BYTE-IDENTICAL JSON (raw stringify — key insertion order
 * included) against fixtures generated from the PRE-refactor code, plus the
 * side-effect order invariants (insert → incrementLocalSwingCount →
 * emit('swing.recorded'); stub rows insert only; anon never inserts).
 *
 * Run:                 npx tsx lib/persistSwingRow.test.ts
 * Regenerate fixtures: SNAPSHOT_WRITE=1 npx tsx lib/persistSwingRow.test.ts
 *   (Only legitimate when generating from a tree whose persistSwing behavior
 *   is the accepted baseline — the fixtures ARE the proof artifact.)
 *
 * No jest — project-standard hand-rolled harness. The RN-unsafe modules in
 * persistSwing's import graph (AsyncStorage, expo-constants, ./supabase via
 * Clerk, ./eventBus timers) are replaced via a CommonJS Module._load hook
 * installed BEFORE the graph loads; everything else (analysisPipeline,
 * swingRowBuilders, tipFrequency, positiveReinforcement, sessionAccumulator,
 * playerProfiles) runs real. Date.now is pinned before ANY graph module loads
 * so time-derived row fields (tipFrequency.sessionMs) are deterministic.
 * NOTE: no top-level ESM imports of graph modules here — esbuild hoists them
 * above the hook; the body uses require() exclusively.
 */
import type { PoseFrame, JointName } from '../packages/pose/PoseTypes';
import type { WatchImuPersist } from '../packages/domain/swing/swingRowBuilders';

// ── Pin the clock BEFORE any graph module can capture Date.now ──────────────
const FIXED_NOW = 1750000000000;
// eslint-disable-next-line no-global-assign
Date.now = () => FIXED_NOW;

/* eslint-disable @typescript-eslint/no-require-imports */
const ModuleAny = require('node:module') as { _load: (...a: unknown[]) => unknown } & Record<string, unknown>;
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const crypto = require('node:crypto') as typeof import('node:crypto');

// ── Instrumented environment ────────────────────────────────────────────────
const callLog: string[] = [];
const insertedRows: unknown[] = [];
const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
let currentUserId: string | null = 'user_fixture_0001';

const SWING_COUNT_KEY = 'honeyswing:localSwingCount';
const storage = new Map<string, string>([
  ['honeyswing:coachCode', 'coach-fixture'],
  ['honeyswing:ageTier', 'youth'],
  [SWING_COUNT_KEY, '3'],
  [
    'honeyswing:playerProfiles',
    JSON.stringify([
      {
        id: 'profile-luca-0001',
        name: 'Luca',
        isLeftHanded: false,
        createdAt: FIXED_NOW - 86_400_000,
        isPrimary: true,
        nickname: 'Luca',
        ageTier: 'youth',
      },
    ]),
  ],
]);

const asyncStorageStub = {
  async getItem(k: string): Promise<string | null> {
    return storage.has(k) ? storage.get(k)! : null;
  },
  async setItem(k: string, v: string): Promise<void> {
    if (k === SWING_COUNT_KEY) callLog.push('incrementLocalSwingCount');
    storage.set(k, v);
  },
  async removeItem(k: string): Promise<void> {
    storage.delete(k);
  },
  async multiGet(keys: string[]): Promise<Array<[string, string | null]>> {
    return keys.map((k) => [k, storage.get(k) ?? null]);
  },
};

function benignChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'limit', 'update', 'insert', 'upsert', 'maybeSingle']) {
    chain[m] = () => chain;
  }
  chain.single = async () => ({ data: null, error: null });
  chain.then = undefined; // not thenable
  return chain;
}

const supabaseModuleStub = {
  __esModule: true,
  supabase: {
    from(table: string) {
      if (table !== 'swings') return benignChain();
      return {
        insert(row: unknown) {
          callLog.push('insert');
          insertedRows.push(row);
          return {
            select() {
              return {
                async single() {
                  return { data: { id: 'swing-fixture-0001' }, error: null };
                },
              };
            },
          };
        },
      };
    },
  },
  getUserId: async () => currentUserId,
  getUser: async () => (currentUserId ? { id: currentUserId } : null),
  getClerkToken: async () => null,
};

const eventBusStub = {
  __esModule: true,
  emit(event: string, payload: Record<string, unknown>) {
    callLog.push(`emit:${event}`);
    emitted.push({ event, payload });
  },
};

// ── Module._load hook (must precede all graph requires) ─────────────────────
const origLoad = ModuleAny._load.bind(ModuleAny);
ModuleAny._load = function patchedLoad(request: unknown, parent: unknown, isMain: unknown) {
  const req = request as string;
  const parentFile = (parent as { filename?: string } | null)?.filename ?? '';
  const fromLib = parentFile.includes(`${path.sep}lib${path.sep}`) || parentFile.endsWith(`${path.sep}lib`);
  if (req === '@react-native-async-storage/async-storage') {
    return { __esModule: true, default: asyncStorageStub };
  }
  if (req === 'expo-constants') {
    return {
      __esModule: true,
      default: { expoConfig: { version: '9.9.9-test' }, nativeAppVersion: '9.9.9-test' },
    };
  }
  if (req === './supabase' && fromLib) return supabaseModuleStub;
  if (req === './eventBus' && fromLib) return eventBusStub;
  if (req === 'react-native') {
    // Some transitive graph module touches RN (see console line for whom) —
    // esbuild can't parse RN's Flow-typed index.js, so serve a minimal stub.
    console.log(`  [hook] 'react-native' requested by ${parentFile || '(unknown)'}`);
    return {
      __esModule: true,
      Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
      AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
      NativeModules: {},
    };
  }
  return origLoad(request, parent, isMain);
};

// ── Graph loads (post-hook, post-clock-pin) ─────────────────────────────────
const { persistSwing } = require('./persistSwing') as typeof import('./persistSwing');
const { analyzePoseSequence } =
  require('../packages/domain/swing/analysisPipeline') as typeof import('../packages/domain/swing/analysisPipeline');
const { createEmptyJoints } =
  require('../packages/pose/PoseTypes') as typeof import('../packages/pose/PoseTypes');

// ── Deterministic fixtures ──────────────────────────────────────────────────
function makeFrames(n: number): PoseFrame[] {
  const frames: PoseFrame[] = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const joints = createEmptyJoints();
    const set = (name: JointName, x: number, y: number) => {
      joints[name] = { name, x, y, confidence: 0.9 };
    };
    set('nose', 0.5, 0.2);
    set('leftShoulder', 0.42, 0.32);
    set('rightShoulder', 0.58, 0.32);
    set('leftElbow', 0.4, 0.45);
    set('rightElbow', 0.6, 0.45);
    set('leftWrist', 0.45 + 0.1 * t, 0.62 - 0.2 * t);
    set('rightWrist', 0.47 + 0.1 * t, 0.63 - 0.2 * t);
    set('leftHip', 0.44, 0.55);
    set('rightHip', 0.56, 0.55);
    set('leftKnee', 0.44, 0.72);
    set('rightKnee', 0.56, 0.72);
    set('leftAnkle', 0.44, 0.9);
    set('rightAnkle', 0.56, 0.9);
    frames.push({ timestampMs: i * 8.33, joints, frameWidth: 1080, frameHeight: 1920 });
  }
  return frames;
}

const watchImuFixture = {
  readings: [
    { t: 0, ax: 0.01, ay: -0.98, az: 0.12, gx: 0.001, gy: 0.002, gz: 0.003 },
    { t: 10, ax: 0.02, ay: -0.97, az: 0.11, gx: 0.002, gy: 0.003, gz: 0.004 },
    { t: 20, ax: 0.03, ay: -0.96, az: 0.1, gx: 0.003, gy: 0.004, gz: 0.005 },
  ],
  summary: { sampleCount: 3, durationMs: 20, peakAccel: 0.98 },
  alignment: null,
  captureSeq: 7,
} as unknown as WatchImuPersist;

async function runFullCase(): Promise<string | null> {
  const frames = makeFrames(12);
  const analysis = analyzePoseSequence(
    { frames, source: 'rtmw-l-2d-v1', metadata: { fps: 120, durationMs: frames[frames.length - 1].timestampMs } },
    false,
    [],
  );
  return persistSwing(
    frames,
    analysis,
    { validity: 'valid', frameCount: 12, goodFrameCount: 12, poseSuccessRate: 1, reason: null },
    { camera_angle_at_start: 12.5, camera_guidance_color: 'green' as never },
    [{ label: 'neutral', score: 0.87 }],
    240, // requestedFps
    [
      { x: 0.01, y: -0.98, z: 0.12 },
      { x: 0.02, y: -0.97, z: 0.11 },
    ] as never,
    'profile-luca-0001', // playerProfileId (explicit — record-flow shape)
    118.9, // captureFps
    4000, // videoDurationMs
    480, // videoFrameCount
    11000, // extractionTotalMs
    watchImuFixture,
    false, // isLeftHandedOverride (explicit — record-flow shape)
    'window_timer' as never,
    { decode_ms: 9000, inference_ms: 1800, metadata_probe_ms: 200 },
    { analyze_ms: 50, persist_ms: null },
  );
}

async function runStubCase(): Promise<string | null> {
  // Mirrors persistImuOnlyRecord: frames=[], undefined playerProfileId and no
  // handedness override — exercises the getPrimaryProfile and
  // getActiveProfileHandedness fallback reads inside the row build.
  const emptyAnalysis = analyzePoseSequence(
    { frames: [], source: 'rtmw-l-2d-v1', metadata: { fps: 240, durationMs: 0 } },
    false,
    [],
  );
  return persistSwing(
    [],
    emptyAnalysis,
    { validity: 'invalid', frameCount: 0, goodFrameCount: 0, poseSuccessRate: 0, reason: 'imu-only' },
    undefined,
    null,
    null,
    undefined,
    undefined, // playerProfileId → getPrimaryProfile fallback
    null,
    null,
    null,
    null,
    watchImuFixture,
    undefined, // isLeftHandedOverride → getActiveProfileHandedness fallback
  );
}

// ── Harness ─────────────────────────────────────────────────────────────────
let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

const FIXTURE_DIR = path.join(__dirname, '__fixtures__');
const FIXTURES = {
  full: path.join(FIXTURE_DIR, 'persistSwingRow.full.json'),
  stub: path.join(FIXTURE_DIR, 'persistSwingRow.stub.json'),
};

function serialize(row: unknown): string {
  return JSON.stringify(row, null, 2);
}

function canonical(row: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, val]) => [k, sortKeys(val)]),
      );
    }
    return v;
  };
  return JSON.stringify(sortKeys(row), null, 2);
}

function sha(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

async function main(): Promise<void> {
  // Case 1: full signed-in swing.
  const fullId = await persistedOrThrow(runFullCase, 'full');
  const fullLog = callLog.splice(0);
  // Case 2: stub row (frames=[], imu-only).
  const stubId = await persistedOrThrow(runStubCase, 'stub');
  const stubLog = callLog.splice(0);

  if (insertedRows.length !== 2) {
    console.error(`FATAL: expected 2 captured inserts, got ${insertedRows.length}`);
    process.exit(1);
  }
  const fullJson = serialize(insertedRows[0]);
  const stubJson = serialize(insertedRows[1]);

  if (process.env.SNAPSHOT_WRITE === '1') {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(FIXTURES.full, fullJson);
    fs.writeFileSync(FIXTURES.stub, stubJson);
    console.log(`fixtures written: full sha256:${sha(fullJson)} (${fullJson.length}b), stub sha256:${sha(stubJson)} (${stubJson.length}b)`);
    return;
  }

  console.log('persistSwingRow snapshot:');
  const expectedFull = fs.readFileSync(FIXTURES.full, 'utf8');
  const expectedStub = fs.readFileSync(FIXTURES.stub, 'utf8');
  check(fullJson === expectedFull, `full row byte-identical (raw key order) [${sha(fullJson)} vs ${sha(expectedFull)}]`);
  check(stubJson === expectedStub, `stub row byte-identical (raw key order) [${sha(stubJson)} vs ${sha(expectedStub)}]`);
  // Secondary, for diagnosability: canonical (sorted-key) equality.
  check(canonical(insertedRows[0]) === canonical(JSON.parse(expectedFull)), 'full row canonical-equal');
  check(canonical(insertedRows[1]) === canonical(JSON.parse(expectedStub)), 'stub row canonical-equal');

  console.log('side-effect invariants:');
  check(fullId === 'swing-fixture-0001', 'full case returns inserted id');
  check(
    fullLog.join(',') === 'insert,incrementLocalSwingCount,emit:swing.recorded',
    `full case order insert → increment → emit (got: ${fullLog.join(',')})`,
  );
  check(stubId === 'swing-fixture-0001', 'stub case returns inserted id');
  check(stubLog.join(',') === 'insert', `stub case inserts only — no counter, no emit (got: ${stubLog.join(',')})`);
  const rec = emitted.find((e) => e.event === 'swing.recorded');
  check(rec?.payload.swingId === 'swing-fixture-0001' && rec?.payload.userId === 'user_fixture_0001',
    'swing.recorded payload carries swingId + userId');

  console.log('anonymous path:');
  const preCount = storage.get(SWING_COUNT_KEY);
  currentUserId = null;
  const anonId = await runFullCase();
  const anonLog = callLog.splice(0);
  check(anonId === null, 'anon returns null');
  check(!anonLog.includes('insert'), 'anon never calls insert');
  check(anonLog.filter((c) => c === 'incrementLocalSwingCount').length === 1, 'anon increments local counter exactly once');
  check(!anonLog.some((c) => c.startsWith('emit:')), 'anon emits nothing');
  check(storage.get(SWING_COUNT_KEY) === String(parseInt(preCount ?? '0', 10) + 1), 'anon counter value advanced by 1');

  console.log(failures === 0 ? '\npersistSwingRow: ALL PASS' : `\npersistSwingRow: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

async function persistedOrThrow(fn: () => Promise<string | null>, label: string): Promise<string | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`FATAL: ${label} case threw:`, err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
