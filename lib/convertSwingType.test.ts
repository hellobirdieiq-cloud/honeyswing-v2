/**
 * convertSwingType.test.ts — type-conversion builder + headline-fidelity pins.
 *
 * Imports ONLY the pure builders module + pure domain — no supabase, no
 * native putting wrappers, no AsyncStorage (they live in convertSwingType.ts,
 * deliberately not imported here).
 */

import {
  buildPuttConversionUpdate,
  buildSwingConversionUpdate,
  FULL_SWING_ANALYSIS_DEBUG_KEYS,
  type ConversionPriorRow,
} from './convertSwingTypeBuilders';
import type { PuttingPipelineOutput } from './puttingPipeline';
import {
  analyzePoseSequence,
  type AnalysisResult,
} from '@/packages/domain/swing/analysisPipeline';
import {
  createEmptyJoints,
  type PoseFrame,
  type PoseSequence,
} from '@/packages/pose/PoseTypes';
import type { GravityReading } from '@/packages/domain/swing/tiltCorrection';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRIOR_SWING: ConversionPriorRow = {
  score: 100,
  tempo_ratio: 3.1,
  backswing_ms: 620,
  downswing_ms: 200,
  honey_boom: true,
};

const PRIOR_PUTT: ConversionPriorRow = {
  score: 90,
  tempo_ratio: 1.88,
  backswing_ms: 560,
  downswing_ms: 298,
  honey_boom: null,
};

// A full-swing row's swing_debug as the conversion would find it: analysis
// keys (discard), a label record (discard), capture provenance + one key no
// discard list knows about (both MUST survive — owner A1 preserve-unknown).
const SWING_ROW_DEBUG: Record<string, unknown> = {
  scoring_breakdown: [{ metric: 'tempo', score: 100 }],
  phase_rules: { faceOn: true },
  camera_angle: 'faceOn',
  keypoint_identity: { swaps: 2 },
  operator_labels: { schema: 1, phases: { impact: 140 } },
  handedness: 'right',
  stop_origin: 'window_timer',
  age_tier: 'youth',
  captured_at_iso: '2026-07-20T10:00:00Z',
  fps_estimate: 118.4,
  some_future_key: 'keep-me', // unknown class → PRESERVE
};

const FAKE_PUTT_PIPELINE = {
  detectors: {
    takeawayFrame: 77,
    topFrame: 121,
    impactFrame: 152,
    tempo: { ratio: 1.42, backswingMs: 560.4, downswingMs: 394.6 },
    intermediates: { warnings: [] },
  },
  score: 70,
  smoothed: null,
  shaftLenPx: 194,
  analysisWidth: 720,
  barCalibration: null,
  timings: { track_ms: 1234 },
} as unknown as PuttingPipelineOutput;

const FAKE_SWING_ANALYSIS = {
  score: 100,
  honeyBoom: false,
  cameraAngleValid: true,
  angles: { spineAngle: 32 },
  tempo: { tempoRatio: 3.0, backswingMs: 600.2, downswingMs: 199.9 },
  phases: [
    { phase: 'takeaway', index: 10, timestampMs: 200, source: 'heuristic' },
    { phase: 'impact', index: 90, timestampMs: 1800, source: 'heuristic' },
  ],
  trail: [],
  metricConfidences: undefined,
  aggregate: undefined,
  swing_debug: {
    frame_selection_method: 'phase_windowed',
    scoring_breakdown: [{ metric: 'tempo', score: 100 }],
    camera_angle: 'faceOn',
  },
} as unknown as AnalysisResult;

const NOW = 1_800_000_000_000;

function debugOf(update: { swing_debug?: unknown }): Record<string, unknown> {
  return update.swing_debug as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Swing → putt direction
// ---------------------------------------------------------------------------

console.log('\n=== buildPuttConversionUpdate (swing → putt) ===');

const puttUpdate = buildPuttConversionUpdate({
  pipeline: FAKE_PUTT_PIPELINE,
  existingDebug: SWING_ROW_DEBUG,
  prior: PRIOR_SWING,
  nowMs: NOW,
});

assert(puttUpdate.analysis_version === 'putt-v1', 'version flips to putt-v1');
assert(puttUpdate.score === 70, 'score = putt band score');
assert(puttUpdate.tempo_ratio === 1.42, 'tempo_ratio = putt ratio');
assert(puttUpdate.backswing_ms === 560, 'backswing_ms rounded (buildPuttRow parity)');
assert(puttUpdate.downswing_ms === 395, 'downswing_ms rounded (buildPuttRow parity)');

// Full-swing ANALYSIS output columns → null, every one reconstructAnalysis reads.
for (const col of [
  'honey_boom',
  'camera_angle_valid',
  'angles',
  'tempo',
  'phases',
  'trail_points',
  'metric_confidences',
  'category_scores',
  'phase_source',
] as const) {
  assert(puttUpdate[col] === null, `swing analysis column nulled: ${col}`);
}

// Capture facts are NOT in the payload (untouched by the atomic update).
for (const col of ['gravity_vector', 'watch_imu', 'coach_name', 'motion_frames', 'fps_actual']) {
  assert(!(col in puttUpdate), `capture fact not touched: ${col}`);
}

const pd = debugOf(puttUpdate);
assert(typeof pd.putting === 'object' && pd.putting != null, 'swing_debug.putting written');
assert(
  (pd.putting as Record<string, unknown>).takeaway_frame === 77 &&
    (pd.putting as Record<string, unknown>).score === 70,
  'putting debug carries detector frames + score (buildPuttRow shape)',
);
assert(pd.operator_labels === undefined, 'label record dropped');
for (const k of FULL_SWING_ANALYSIS_DEBUG_KEYS) {
  if (k in SWING_ROW_DEBUG) {
    assert(!(k in pd), `full-swing analysis debug key dropped: ${k}`);
  }
}
assert(pd.handedness === 'right', 'capture provenance preserved: handedness');
assert(pd.stop_origin === 'window_timer', 'capture provenance preserved: stop_origin');
assert(pd.captured_at_iso === '2026-07-20T10:00:00Z', 'capture provenance preserved: captured_at_iso');
assert(pd.some_future_key === 'keep-me', 'UNKNOWN key preserved (A1: never silently delete)');
const ptc = pd.type_conversion as Record<string, unknown>;
assert(ptc.from === 'v2' && ptc.converted_at_ms === NOW, 'provenance: from v2 + timestamp');
assert(
  (ptc.prior as Record<string, unknown>).score === 100 &&
    (ptc.prior as Record<string, unknown>).honey_boom === true,
  'provenance carries prior score/honey_boom',
);

// ---------------------------------------------------------------------------
// 2. Putt → swing direction + ROUND TRIP (owner A6b): swing→putt→swing must
//    leave no stale putting-only or swing-only fields in the final shape.
// ---------------------------------------------------------------------------

console.log('\n=== buildSwingConversionUpdate (putt → swing) + round trip ===');

const roundTripFrames: PoseFrame[] = [
  { timestampMs: 0, joints: createEmptyJoints(), frameWidth: 1, frameHeight: 1 },
  { timestampMs: 20, joints: createEmptyJoints(), frameWidth: 1, frameHeight: 1 },
];

const swingUpdate = buildSwingConversionUpdate({
  analysis: FAKE_SWING_ANALYSIS,
  frames: roundTripFrames,
  isLeftHanded: false,
  existingDebug: debugOf(puttUpdate), // ← round trip: feed the converted-putt debug back
  prior: PRIOR_PUTT,
  nowMs: NOW + 1,
});

assert(swingUpdate.analysis_version === 'v2', 'version flips back to v2');
assert(swingUpdate.score === 100, 'score from analysis');
assert(swingUpdate.honey_boom === false, 'honey_boom from analysis');
assert(swingUpdate.tempo_ratio === 3.0, 'tempo_ratio from analysis');
assert(swingUpdate.backswing_ms === 600, 'backswing_ms rounded (persistSwing parity)');
assert(swingUpdate.downswing_ms === 200, 'downswing_ms rounded (persistSwing parity)');
assert(Array.isArray(swingUpdate.phases), 'phases column populated');
assert(swingUpdate.phase_source === 'heuristic', 'phase_source extracted');
assert(typeof swingUpdate.pose_success_rate === 'number', 'pose_success_rate recomputed');

const sd = debugOf(swingUpdate);
assert(sd.putting === undefined, 'ROUND TRIP: stale putting blob gone');
assert(sd.putting_operator_labels === undefined, 'ROUND TRIP: no putt label record');
assert(sd.operator_labels === undefined, 'ROUND TRIP: no swing label record');
assert(sd.handedness === 'right', 'handedness present (analysis + arg agree)');
assert(sd.some_future_key === 'keep-me', 'ROUND TRIP: unknown key still preserved');
assert(sd.stop_origin === 'window_timer', 'ROUND TRIP: capture provenance still preserved');
assert(sd.frame_selection_method === 'phase_windowed', 'fresh analysis debug laid on top');
const stc = sd.type_conversion as Record<string, unknown>;
assert(stc.from === 'putt-v1', 'provenance: latest conversion wins (no stacking)');
assert((stc.prior as Record<string, unknown>).score === 90, 'provenance carries putt prior score');

// ---------------------------------------------------------------------------
// 3. Headline fidelity pin (owner A6a, framing per A7):
//    Under the CURRENT implementation, empty gravityReadings does not change
//    headline score or tempo for these fixtures — gravity feeds tilt
//    correction (angles) only; calculateTempo(phases) runs on phases and
//    scoreSwing destructures only { tempo } (scoring.ts:107). If gravity is
//    intentionally introduced into tempo/score computation later, update this
//    test alongside the scoring contract.
// ---------------------------------------------------------------------------

console.log('\n=== headline fidelity: gravity affects angles, never score/tempo (current impl) ===');

// Static confident torso: shoulders + hips → spineAngle computes, so tilt
// correction has a correctable metric and actually APPLIES in the gravity run
// (non-vacuity — we prove the two runs took different angle paths).
function torsoFrame(timestampMs: number): PoseFrame {
  const joints = createEmptyJoints();
  joints.leftShoulder = { name: 'leftShoulder', x: 0.4, y: 0.3, confidence: 0.95 };
  joints.rightShoulder = { name: 'rightShoulder', x: 0.6, y: 0.31, confidence: 0.95 };
  joints.leftHip = { name: 'leftHip', x: 0.44, y: 0.55, confidence: 0.95 };
  joints.rightHip = { name: 'rightHip', x: 0.56, y: 0.55, confidence: 0.95 };
  return { timestampMs, joints, frameWidth: 1, frameHeight: 1 };
}
const torsoFrames: PoseFrame[] = [];
for (let i = 0; i < 40; i++) torsoFrames.push(torsoFrame(i * 20));
const torsoSeq: PoseSequence = { frames: torsoFrames, source: 'test' };

// ~26° forward pitch, 10 identical samples: magnitude ≈ 1g, stddev 0 —
// clears every computePhoneTilt gate (MIN_SAMPLE_COUNT 3, MAX_PITCH_STDDEV 8,
// MIN/MAX_TILT_DEG 2/30).
const gravity: GravityReading[] = Array.from({ length: 10 }, () => ({
  x: 0,
  y: -0.9,
  z: -0.436,
}));

const noGravity = analyzePoseSequence(torsoSeq, false, []);
const withGravity = analyzePoseSequence(torsoSeq, false, gravity);

const tiltNo = (noGravity.swing_debug?.tilt_correction as { correctionApplied?: boolean }) ?? {};
const tiltWith = (withGravity.swing_debug?.tilt_correction as { correctionApplied?: boolean }) ?? {};
assert(tiltWith.correctionApplied === true, 'non-vacuity: gravity run APPLIED tilt correction');
assert(tiltNo.correctionApplied !== true, 'empty-gravity run skipped tilt correction');
assert(
  (noGravity.angles?.spineAngle ?? null) !== (withGravity.angles?.spineAngle ?? null),
  'non-vacuity: spineAngle differs between the runs (gravity reached the angle path)',
);
assert(noGravity.score === withGravity.score, 'headline score identical with/without gravity');
assert(
  JSON.stringify(noGravity.tempo ?? null) === JSON.stringify(withGravity.tempo ?? null),
  'tempo identical with/without gravity',
);

// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All convertSwingType tests passed');
}
