/**
 * captureFlow.test.ts — unit tests for the pure capture-flow decision helpers.
 *
 * Run with: npx tsx packages/domain/swing/captureFlow.test.ts
 *
 * No jest — project-standard hand-rolled runner. Expected values derived from
 * the original tryNavigate gate and classification override in useSwingCapture.ts.
 */

import {
  computeNavigationBlockReason,
  deriveClassification,
  deriveFallbackGateReason,
  selectLeadWristForGrip,
  buildWatchImuPersistPayload,
  planDriftEvent,
  planOutboxReconcile,
  evaluateWatchAutoStart,
} from './captureFlow';
import type { CaptureClassification } from './captureValidity';
import type { WatchImuReading, WatchImuMeasured } from './watchImu';

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
// computeNavigationBlockReason — precedence: phase → analysis → video → navigated
// ---------------------------------------------------------------------------

group('computeNavigationBlockReason');
assertEq(
  computeNavigationBlockReason({ phase: 'capturing', analysisReady: true, video: 'file.mp4', navigated: false }),
  'phase',
  'phase ≠ complete → phase',
);
// precedence: phase wins even when every later condition would also block
assertEq(
  computeNavigationBlockReason({ phase: 'idle', analysisReady: false, video: 'pending', navigated: true }),
  'phase',
  'phase takes precedence over all others',
);
assertEq(
  computeNavigationBlockReason({ phase: 'complete', analysisReady: false, video: 'file.mp4', navigated: false }),
  'analysis',
  'complete + !analysisReady → analysis',
);
assertEq(
  computeNavigationBlockReason({ phase: 'complete', analysisReady: true, video: 'pending', navigated: false }),
  'video',
  'complete + ready + video pending → video',
);
assertEq(
  computeNavigationBlockReason({ phase: 'complete', analysisReady: true, video: 'file.mp4', navigated: true }),
  'navigated',
  'complete + ready + video ready + navigated → navigated',
);
assertEq(
  computeNavigationBlockReason({ phase: 'complete', analysisReady: true, video: 'file.mp4', navigated: false }),
  null,
  'all clear (video string) → null',
);
assertEq(
  computeNavigationBlockReason({ phase: 'complete', analysisReady: true, video: null, navigated: false }),
  null,
  'all clear (video null, not pending) → null',
);

// ---------------------------------------------------------------------------
// deriveClassification
// ---------------------------------------------------------------------------

group('deriveClassification');
const base: CaptureClassification = {
  validity: 'valid',
  frameCount: 30,
  goodFrameCount: 25,
  poseSuccessRate: 0.83,
  reason: null,
};

const passthrough = deriveClassification(base, null);
assert(passthrough === base, 'fallbackGateReason null → returns base unchanged (same object)');
assertEq(passthrough.validity, 'valid', 'passthrough validity preserved');
assertEq(passthrough.reason, null, 'passthrough reason preserved');

const overridden = deriveClassification(base, 'no-swing');
assertEq(overridden.validity, 'partial', 'fallbackGateReason set → validity partial');
assertEq(overridden.reason, 'no-swing', 'fallbackGateReason set → reason no-swing');
assertEq(overridden.frameCount, 30, 'frameCount preserved');
assertEq(overridden.goodFrameCount, 25, 'goodFrameCount preserved');
assertEq(overridden.poseSuccessRate, 0.83, 'poseSuccessRate preserved');

// ---------------------------------------------------------------------------
// deriveFallbackGateReason — `!= null` semantics: only null/undefined pass through
// ---------------------------------------------------------------------------

group('deriveFallbackGateReason');
assertEq(deriveFallbackGateReason({ fallback_gate: 'tempo-implausible' }), 'no-swing', 'gate string → no-swing');
assertEq(deriveFallbackGateReason({ fallback_gate: 0 }), 'no-swing', 'gate 0 (falsy but != null) → no-swing');
assertEq(deriveFallbackGateReason({ fallback_gate: false }), 'no-swing', 'gate false (falsy but != null) → no-swing');
assertEq(deriveFallbackGateReason({ fallback_gate: null }), null, 'gate null → null');
assertEq(deriveFallbackGateReason({ fallback_gate: undefined }), null, 'gate undefined → null');
assertEq(deriveFallbackGateReason({}), null, 'gate absent → null');
assertEq(deriveFallbackGateReason(undefined), null, 'swing_debug undefined → null');
assertEq(deriveFallbackGateReason(null), null, 'swing_debug null → null');

// ---------------------------------------------------------------------------
// selectLeadWristForGrip — lead wrist: right for lefties, left for righties
// ---------------------------------------------------------------------------

group('selectLeadWristForGrip');
const L = { x: 0.1, y: 0.2 };
const R = { x: 0.8, y: 0.2 };
assertEq(selectLeadWristForGrip({ leftWrist: L, rightWrist: R }, false), L, 'right-handed → leftWrist');
assertEq(selectLeadWristForGrip({ leftWrist: L, rightWrist: R }, true), R, 'left-handed → rightWrist');
assertEq(selectLeadWristForGrip({ leftWrist: undefined, rightWrist: R }, false), undefined, 'missing lead joint passes through as undefined');
assertEq(selectLeadWristForGrip({ leftWrist: L, rightWrist: undefined }, true), undefined, 'missing lead joint (lefty) passes through as undefined');

// ---------------------------------------------------------------------------
// buildWatchImuPersistPayload — payload iff summary measured AND readings present
// ---------------------------------------------------------------------------

group('buildWatchImuPersistPayload');
const reading: WatchImuReading = { t: 1000, ax: 0.1, ay: 0.2, az: 0.3, gx: 0.4, gy: 0.5, gz: 0.6 };
const summary: WatchImuMeasured = { sampleCount: 1, derivedHz: 200, maxAccelMagnitudeG: 1.5 };
assertEq(buildWatchImuPersistPayload([], summary, null, 3), null, 'no readings → null');
assertEq(buildWatchImuPersistPayload([reading], null, null, 3), null, 'no summary → null');
assertEq(buildWatchImuPersistPayload([], null, null, 3), null, 'neither → null');
const payload = buildWatchImuPersistPayload([reading], summary, null, 7);
assert(payload !== null, 'readings + summary → payload');
assert(payload?.readings.length === 1 && payload.readings[0] === reading, 'readings passed by reference');
assertEq(payload?.summary, summary, 'summary passed by reference');
assertEq(payload?.alignment, null, 'alignment null passes through');
assertEq(payload?.captureSeq, 7, 'captureSeq passes through');

// ---------------------------------------------------------------------------
// planDriftEvent — gate: swingId + clean extraction + both numbers measured
// ---------------------------------------------------------------------------

group('planDriftEvent');
const okDrift = planDriftEvent({ swingId: 's1', failure: null, frameCount: 240, durationMs: 4000 });
assert(okDrift !== null, 'all valid → plan');
assertEq(okDrift?.swingId, 's1', 'swingId narrowed through');
assertEq(okDrift?.frameCount, 240, 'frameCount narrowed through');
assertEq(okDrift?.durationMs, 4000, 'durationMs narrowed through');
const zeroDrift = planDriftEvent({ swingId: 's1', failure: null, frameCount: 0, durationMs: 0 });
assert(zeroDrift !== null && zeroDrift.frameCount === 0 && zeroDrift.durationMs === 0, 'zero measurements are valid numbers → plan (matches original typeof gate)');
assertEq(planDriftEvent({ swingId: null, failure: null, frameCount: 240, durationMs: 4000 }), null, 'no swingId → null');
assertEq(planDriftEvent({ swingId: 's1', failure: 'no-person', frameCount: 240, durationMs: 4000 }), null, 'extraction failure → null');
assertEq(planDriftEvent({ swingId: 's1', failure: null, frameCount: null, durationMs: 4000 }), null, 'frameCount null → null');
assertEq(planDriftEvent({ swingId: 's1', failure: null, frameCount: 240, durationMs: undefined }), null, 'durationMs undefined → null');

// ---------------------------------------------------------------------------
// planOutboxReconcile — attach on swingId (even with zero ids: attach also
// fires the drain); abandon orphaned ids; none when nothing to do
// ---------------------------------------------------------------------------

group('planOutboxReconcile');
const both = planOutboxReconcile('pose-1', 'video-1', 'swing-1');
assert(both.action === 'attach' && both.swingId === 'swing-1', 'swingId + both ids → attach with narrowed swingId');
assertEq(both.ids.length, 2, 'both ids collected');
assertEq(both.ids[0], 'pose-1', 'pose id first (original filter order)');
assertEq(both.ids[1], 'video-1', 'video id second');
const attachEmpty = planOutboxReconcile(null, null, 'swing-1');
assert(attachEmpty.action === 'attach' && attachEmpty.ids.length === 0, 'swingId + zero ids → STILL attach (fires the drain, matches original)');
const abandon = planOutboxReconcile('pose-1', null, null);
assert(abandon.action === 'abandon' && abandon.ids.length === 1 && abandon.ids[0] === 'pose-1', 'no swingId + ids → abandon');
const nothing = planOutboxReconcile(null, null, null);
assert(nothing.action === 'none' && nothing.ids.length === 0, 'no swingId + no ids → none');
const videoOnly = planOutboxReconcile(null, 'video-1', null);
assert(videoOnly.action === 'abandon' && videoOnly.ids[0] === 'video-1', 'null pose id filtered, video id survives');

// ---------------------------------------------------------------------------
// evaluateWatchAutoStart — fresh (<= threshold) AND pre-armed AND idle
// ---------------------------------------------------------------------------

group('evaluateWatchAutoStart');
const go = evaluateWatchAutoStart({ startedAgeMs: 100, freshnessMs: 2500, preArmed: true, phase: 'idle' });
assert(go.fresh && go.shouldStart, 'fresh + preArmed + idle → start');
const boundary = evaluateWatchAutoStart({ startedAgeMs: 2500, freshnessMs: 2500, preArmed: true, phase: 'idle' });
assert(boundary.fresh && boundary.shouldStart, 'ageMs == freshnessMs is fresh (<= semantics)');
const stale = evaluateWatchAutoStart({ startedAgeMs: 2501, freshnessMs: 2500, preArmed: true, phase: 'idle' });
assert(!stale.fresh && !stale.shouldStart, 'stale signal → fresh false, no start');
const notArmed = evaluateWatchAutoStart({ startedAgeMs: 100, freshnessMs: 2500, preArmed: false, phase: 'idle' });
assert(notArmed.fresh && !notArmed.shouldStart, 'not pre-armed → fresh true but no start');
const busy = evaluateWatchAutoStart({ startedAgeMs: 100, freshnessMs: 2500, preArmed: true, phase: 'capturing' });
assert(busy.fresh && !busy.shouldStart, 'phase not idle → fresh true but no start');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '✅' : '❌'} captureFlow: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
