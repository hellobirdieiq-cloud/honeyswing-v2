/**
 * clockAlign.test.ts — watch→video alignment math.
 *
 * Run: npx tsx packages/domain/swing/clockAlign.test.ts
 * NOT Jest. Custom assert harness matching confidenceScore.test.ts.
 *
 * Coverage:
 *   (a) fresh offset + monotonic anchor → confidence 'medium', samples mapped to video time
 *   (b) trimming — samples outside [0, videoDurationMs] dropped (phone trims over-capture)
 *   (c) stale offset → 'low', no aligned output
 *   (d) no sync → 'none', no aligned output
 *   (e) sync fresh but no monotonic anchor → 'low' (wall-clock fallback NOT mixed with offset)
 *   (f) alignment block always populated (captureOrigin, defaults for Phase B)
 */

import {
  alignWatchImuToVideo,
  watchMonoToVideoMs,
  syncConfidenceFor,
  isOffsetUsable,
  type AlignParams,
  type ClockSyncResult,
} from './clockAlign';
import type { WatchImuReading } from './watchImu';

let passed = 0;
let failed = 0;
let currentGroup = '';

function group(name: string): void {
  currentGroup = name;
}

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL [${currentGroup}]: ${msg}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL [${currentGroup}]: ${msg} — expected ${expected}, got ${actual}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function reading(t: number): WatchImuReading {
  return { t, ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 };
}

const sync: ClockSyncResult = {
  clockOffsetMs: 1000, // watchMono = phoneMono + 1000
  roundTripMs: 12,
  handshakeAtMs: 50_000,
};

function makeParams(overrides: Partial<AlignParams> = {}): AlignParams {
  return {
    sync,
    offsetAgeMs: 2_000,
    stalenessMs: 60_000,
    anchor: {
      // video starts at phoneMono = 5000 ⇒ watchMono 6000 maps to video 0
      phoneMonoAtVideoStart: 5_000,
      recordIntentAtMs: 1_700_000_000_000,
      videoDurationMs: 4_000,
    },
    watchStartMs: 6_000,
    captureOrigin: 'watch',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) fresh offset + monotonic anchor
// ---------------------------------------------------------------------------

group('fresh-medium');
{
  const p = makeParams();
  assertEq(syncConfidenceFor(p), 'medium', 'fresh + anchor → medium');
  assertEq(isOffsetUsable(p), true, 'fresh offset usable');
  // watchMono 6000 → phoneMono 5000 → video 0
  assertEq(watchMonoToVideoMs(6_000, p), 0, 'watchStart maps to video 0');
  // watchMono 8000 → phoneMono 7000 → video 2000
  assertEq(watchMonoToVideoMs(8_000, p), 2_000, 'watchMono 8000 → video 2000');

  const res = alignWatchImuToVideo([reading(6_000), reading(8_000)], p);
  assertEq(res.confidence, 'medium', 'result confidence medium');
  assertEq(res.aligned.length, 2, 'both in-span samples kept');
  assertEq(res.aligned[0].videoMs, 0, 'first aligned videoMs 0');
  assertEq(res.aligned[1].videoMs, 2_000, 'second aligned videoMs 2000');
}

// ---------------------------------------------------------------------------
// (b) trimming to the video span
// ---------------------------------------------------------------------------

group('trim');
{
  const p = makeParams();
  // before-start (videoMs -1000), in-span (0..4000), after-end (videoMs 5000)
  const readings = [reading(5_000), reading(6_000), reading(10_000), reading(11_000)];
  const res = alignWatchImuToVideo(readings, p);
  assertEq(res.aligned.length, 2, 'only in-span samples retained');
  assert(
    res.aligned.every((r) => r.videoMs >= 0 && r.videoMs <= 4_000),
    'all retained within [0, videoDurationMs]',
  );
}

// ---------------------------------------------------------------------------
// (c) stale offset
// ---------------------------------------------------------------------------

group('stale-low');
{
  const p = makeParams({ offsetAgeMs: 120_000 });
  assertEq(isOffsetUsable(p), false, 'stale offset not usable');
  assertEq(syncConfidenceFor(p), 'low', 'stale → low');
  assertEq(watchMonoToVideoMs(8_000, p), null, 'stale → no mapping');
  const res = alignWatchImuToVideo([reading(8_000)], p);
  assertEq(res.confidence, 'low', 'result low');
  assertEq(res.aligned.length, 0, 'no aligned output when stale');
  assertEq(res.alignment.clockOffsetMs, 1000, 'offset still recorded in block');
}

// ---------------------------------------------------------------------------
// (d) no sync
// ---------------------------------------------------------------------------

group('no-sync-none');
{
  const p = makeParams({ sync: null, offsetAgeMs: null });
  assertEq(syncConfidenceFor(p), 'none', 'no sync → none');
  const res = alignWatchImuToVideo([reading(8_000)], p);
  assertEq(res.confidence, 'none', 'result none');
  assertEq(res.aligned.length, 0, 'no aligned output');
  assertEq(res.alignment.clockOffsetMs, null, 'offset null in block');
}

// ---------------------------------------------------------------------------
// (e) fresh sync but no monotonic anchor → low (do NOT mix wall-clock + offset)
// ---------------------------------------------------------------------------

group('no-anchor-low');
{
  const p = makeParams({
    anchor: {
      phoneMonoAtVideoStart: null,
      recordIntentAtMs: 1_700_000_000_000,
      videoDurationMs: 4_000,
    },
  });
  assertEq(syncConfidenceFor(p), 'low', 'no monotonic anchor → low');
  assertEq(watchMonoToVideoMs(8_000, p), null, 'no anchor → no mapping');
  const res = alignWatchImuToVideo([reading(8_000)], p);
  assertEq(res.aligned.length, 0, 'no aligned output without anchor');
}

// ---------------------------------------------------------------------------
// (f) alignment block always populated
// ---------------------------------------------------------------------------

group('alignment-block');
{
  const res = alignWatchImuToVideo([reading(6_000)], makeParams({ captureOrigin: 'phone' }));
  assertEq(res.alignment.captureOrigin, 'phone', 'captureOrigin threaded');
  assertEq(res.alignment.correctionSource, 'none', 'correctionSource default none');
  assertEq(res.alignment.impactCorrectionMs, null, 'impactCorrectionMs default null');
  assertEq(res.alignment.watchStartMs, 6_000, 'watchStartMs recorded');
}

// ---------------------------------------------------------------------------

console.log(`\nclockAlign: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
