/**
 * swingRowBuilders.test.ts — unit tests for the pure swings-row builders.
 *
 * Run with: npx tsx lib/swingRowBuilders.test.ts
 *
 * No jest — project-standard hand-rolled runner (mirrors lib/swingStore.test.ts).
 * Every expected value is derived from the real implementation in
 * swingRowBuilders.ts (and its pure deps isGoodFrame / calculateGolfAngles /
 * the watchImu constants), not hardcoded guesses.
 */

import type { PostgrestError } from '@supabase/supabase-js';
import {
  classifyInsertError,
  buildWatchImuDebug,
  calcPoseSuccessRate,
  extractPhaseSource,
  buildMetricSnapshotFromAnalysis,
  buildPhaseTagsFromAnalysis,
  buildSpineAngleSeries,
  calcFpsEstimate,
  enrichFramesWithVelocity,
  type WatchImuPersist,
} from './swingRowBuilders';
import { createEmptyJoints, type PoseFrame, type JointName } from '../packages/pose/PoseTypes';
import { calculateGolfAngles, type GolfAngles } from '../packages/domain/swing/angles';
import type { DetectedPhase, SwingTrailPoint } from '../packages/domain/swing/phaseDetection';
import type { SwingTempo } from '../packages/domain/swing/tempoAnalysis';
import type { AnalysisResult } from '../packages/domain/swing/analysisPipeline';
import type { WatchImuMeasured, WatchImuReading } from '../packages/domain/swing/watchImu';
import { WORN_WRIST, WATCH_IMU_CLOCK_NOTE } from '../packages/domain/swing/watchImu';

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

const EPS = 1e-9;
function assertClose(actual: number, expected: number, label: string): void {
  assert(Math.abs(actual - expected) < EPS, `${label} (got ${actual}, expected ≈${expected})`);
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const KEY_JOINTS: JointName[] = [
  'leftShoulder', 'rightShoulder', 'leftHip', 'rightHip',
];

/** Frame that passes isGoodFrame (4 key joints at confidence ≥ 0.3). */
function goodFrame(timestampMs = 0): PoseFrame {
  const joints = createEmptyJoints();
  for (const name of KEY_JOINTS) {
    joints[name] = { name, x: 0.5, y: 0.5, confidence: 0.9 };
  }
  return { timestampMs, joints, frameWidth: 1, frameHeight: 1 };
}

/** Frame that fails isGoodFrame (0 confident key joints). */
function badFrame(timestampMs = 0): PoseFrame {
  return { timestampMs, joints: createEmptyJoints(), frameWidth: 1, frameHeight: 1 };
}

function pt(): SwingTrailPoint {
  return { x: 0, y: 0, timestamp: 0, leadX: 0, leadY: 0, trailX: 0, trailY: 0 };
}

function makePhase(
  phase: DetectedPhase['phase'],
  index: number,
  source: DetectedPhase['source'] = 'heuristic',
): DetectedPhase {
  return { phase, label: phase, point: pt(), index, timestamp: index * 10, source };
}

function makeAnalysis(over: Partial<AnalysisResult>): AnalysisResult {
  // Required-field base mirrors analysisPipeline's empty-return shape verbatim.
  return {
    score: null,
    honeyBoom: false,
    cameraAngleValid: false,
    swingConfidence: {
      overall: 0,
      tier: 'low',
      components: { jointVisibility: 0, cameraAngle: 0, phaseDetection: 0, frameCoverage: 0 },
    },
    cameraAngleResult: {
      angle: 'unknown',
      shoulderSpread: 0,
      hipSpread: 0,
      avgSpread: 0,
      footIndexNorm: null,
      weights: {
        spineAngle: 0, leftElbowAngle: 0, rightElbowAngle: 0, leftKneeAngle: 0,
        rightKneeAngle: 0, hipSpreadDelta: 0, shoulderTilt: 0, tempo: 0,
      },
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// classifyInsertError
// ---------------------------------------------------------------------------

group('classifyInsertError');
const err = (code: string): PostgrestError => ({ code } as unknown as PostgrestError);
assertEq(classifyInsertError(err('23503'), null), 'fk_missing_profile', '23503 → fk_missing_profile');
assertEq(classifyInsertError(err('42501'), null), 'rls_denied', '42501 → rls_denied');
assertEq(classifyInsertError(err('23505'), null), 'constraint', '23xxx (23505) → constraint');
assertEq(classifyInsertError(err('42P01'), null), 'unknown', 'other code (42P01) → unknown');
assertEq(classifyInsertError(err(''), null), 'unknown', 'falsy code → unknown');
assertEq(classifyInsertError(null, new Error('boom')), 'network', 'thrown, no pgError → network');
assertEq(classifyInsertError(null, null), 'unknown', 'nothing → unknown');

// ---------------------------------------------------------------------------
// calcPoseSuccessRate (round to 2 dp)
// ---------------------------------------------------------------------------

group('calcPoseSuccessRate');
assertEq(calcPoseSuccessRate([]), 0, 'empty → 0');
assertEq(
  calcPoseSuccessRate([goodFrame(), goodFrame(), goodFrame(), badFrame()]),
  0.75,
  '3 good of 4 → 0.75',
);
assertEq(
  calcPoseSuccessRate([goodFrame(), goodFrame(), badFrame()]),
  0.67,
  '2 good of 3 → 0.67 (exercises round-to-2dp)',
);

// ---------------------------------------------------------------------------
// extractPhaseSource
// ---------------------------------------------------------------------------

group('extractPhaseSource');
assertEq(extractPhaseSource(undefined), 'none', 'undefined → none');
assertEq(extractPhaseSource([]), 'none', 'empty → none');
assertEq(
  extractPhaseSource([makePhase('takeaway', 0, 'heuristic'), makePhase('top', 1, 'heuristic')]),
  'heuristic',
  'all heuristic → heuristic',
);
assertEq(
  extractPhaseSource([makePhase('takeaway', 0, 'fallback'), makePhase('top', 1, 'fallback')]),
  'fallback',
  'all fallback → fallback',
);
assertEq(
  extractPhaseSource([makePhase('takeaway', 0, 'heuristic'), makePhase('top', 1, 'fallback')]),
  'mixed',
  'heuristic + fallback → mixed',
);

// ---------------------------------------------------------------------------
// buildMetricSnapshotFromAnalysis
// ---------------------------------------------------------------------------

group('buildMetricSnapshotFromAnalysis');
const angles: GolfAngles = {
  spineAngle: 30,
  spineDrift: 4,
  leftElbowAngle: 170,
  rightElbowAngle: 165,
  leftKneeAngle: 160,
  rightKneeAngle: 155,
  hipSpreadDelta: 12,
  shoulderTilt: -5,
};
const tempo: SwingTempo = {
  backswingMs: 800,
  downswingMs: 280,
  tempoRatio: 2.86,
  totalSwingMs: 1080,
  tempoRating: 'good',
  phaseTimestamps: { takeaway: 200, top: 800, downswing: 900, impact: 1080, follow_through: 1280 },
};
const snap = buildMetricSnapshotFromAnalysis(makeAnalysis({ angles, tempo }));
assertEq(snap.spineAngle, 30, 'spineAngle mapped');
assertEq(snap.spineDrift, 4, 'spineDrift mapped');
assertEq(snap.tempoRatio, 2.86, 'tempoRatio from tempo');
assertEq(snap.hipSpreadDelta, 12, 'hipSpreadDelta mapped');
assertEq(snap.leftElbowAngle, 170, 'leftElbowAngle mapped');
assertEq(snap.rightElbowAngle, 165, 'rightElbowAngle mapped');
assertEq(snap.leftKneeAngle, 160, 'leftKneeAngle mapped');
assertEq(snap.rightKneeAngle, 155, 'rightKneeAngle mapped');
assertEq(snap.shoulderTilt, -5, 'shoulderTilt mapped');

const snapNull = buildMetricSnapshotFromAnalysis(makeAnalysis({}));
assert(
  Object.values(snapNull).every((v) => v === null),
  'angles & tempo undefined → all 9 fields null',
);

// ---------------------------------------------------------------------------
// buildPhaseTagsFromAnalysis (sort + dedup + follow_through→finish)
// ---------------------------------------------------------------------------

group('buildPhaseTagsFromAnalysis');
assertEq(
  JSON.stringify(buildPhaseTagsFromAnalysis(makeAnalysis({ phases: [] }), 25)),
  '[]',
  'no phases → []',
);
// Out-of-order input WITH a duplicate clinic tag (two takeaways).
const phases: DetectedPhase[] = [
  makePhase('top', 5),
  makePhase('takeaway', 2),
  makePhase('takeaway', 8), // duplicate tag — must be dropped after sort
  makePhase('impact', 12),
  makePhase('follow_through', 20),
];
const ranges = buildPhaseTagsFromAnalysis(makeAnalysis({ phases }), 25);
assertEq(ranges.length, 4, 'duplicate takeaway dropped → 4 ranges');
assertEq(JSON.stringify(ranges[0]), JSON.stringify({ phase: 'takeaway', startFrameIndex: 2, endFrameIndex: 4 }), 'takeaway 2→4 (sorted first; end = next.index−1)');
assertEq(JSON.stringify(ranges[1]), JSON.stringify({ phase: 'top', startFrameIndex: 5, endFrameIndex: 11 }), 'top 5→11');
assertEq(JSON.stringify(ranges[2]), JSON.stringify({ phase: 'impact', startFrameIndex: 12, endFrameIndex: 19 }), 'impact 12→19');
assertEq(JSON.stringify(ranges[3]), JSON.stringify({ phase: 'finish', startFrameIndex: 20, endFrameIndex: 24 }), 'follow_through→finish 20→24 (last end = frameCount−1)');

// ---------------------------------------------------------------------------
// buildSpineAngleSeries (asserted against a live calculateGolfAngles call)
// ---------------------------------------------------------------------------

group('buildSpineAngleSeries');
const seriesFrames = [goodFrame(0), goodFrame(10)];
const series = buildSpineAngleSeries(seriesFrames);
assertEq(series.length, seriesFrames.length, 'length matches frame count');
assertEq(series[0], calculateGolfAngles(seriesFrames[0]).spineAngle, 'frame0 = calculateGolfAngles().spineAngle');
assertEq(series[1], calculateGolfAngles(seriesFrames[1]).spineAngle, 'frame1 = calculateGolfAngles().spineAngle');

// ---------------------------------------------------------------------------
// calcFpsEstimate (median dt; slice(0,20); even-count; degenerate cases)
// ---------------------------------------------------------------------------

group('calcFpsEstimate');
assertEq(calcFpsEstimate([]), null, 'empty → null');
assertEq(calcFpsEstimate([goodFrame(0)]), null, 'single frame → null');
assertEq(calcFpsEstimate([goodFrame(0), goodFrame(0)]), null, 'identical timestamps (median dt 0) → null');
// Even dt count: ts 0,10,30 → dts [10,20] → median (10+20)/2 = 15 → round(1000/15*10)/10 = 66.7
assertEq(calcFpsEstimate([goodFrame(0), goodFrame(10), goodFrame(30)]), 66.7, 'even-count median 15 → 66.7');
// >20 frames: first 20 spaced 10ms (median 10 → 100.0); 30 trailing frames spaced 1000ms must be IGNORED by slice(0,20).
const fpsFrames: PoseFrame[] = [];
for (let i = 0; i < 20; i++) fpsFrames.push(goodFrame(i * 10));            // ts 0..190
let t = 190;
for (let i = 0; i < 30; i++) { t += 1000; fpsFrames.push(goodFrame(t)); } // huge spacing, beyond index 20
assertEq(calcFpsEstimate(fpsFrames), 100.0, '50 frames: slice(0,20) median 10 → 100.0 (trailing frames ignored)');

// ---------------------------------------------------------------------------
// enrichFramesWithVelocity
// ---------------------------------------------------------------------------

group('enrichFramesWithVelocity');
const f0 = badFrame(0);
f0.joints.leftWrist = { name: 'leftWrist', x: 0.1, y: 0.2, z: 0.3, confidence: 0.9 };
f0.joints.rightWrist = { name: 'rightWrist', x: 0.0, y: 0.0, z: 0.0, confidence: 0.9 };
const f1 = badFrame(100); // dt = 100
f1.joints.leftWrist = { name: 'leftWrist', x: 0.5, y: 0.6, z: 0.8, confidence: 0.9 };
f1.joints.rightWrist = { name: 'rightWrist', x: 0.9, y: 0.9, z: 0.9, confidence: 0 }; // curr conf 0 → no velocity
f1.joints.leftElbow = { name: 'leftElbow', x: 0.4, y: 0.4, confidence: 0.9 };          // no prev → no velocity

const enriched = enrichFramesWithVelocity([f0, f1]);

assertEq(enriched[0].joints.leftWrist?.vx, undefined, 'frame0 has no velocity (no prev)');
assertClose(enriched[1].joints.leftWrist!.vx!, (0.5 - 0.1) / 100, 'frame1 leftWrist vx = (Δx)/dt');
assertClose(enriched[1].joints.leftWrist!.vy!, (0.6 - 0.2) / 100, 'frame1 leftWrist vy = (Δy)/dt');
assertClose(enriched[1].joints.leftWrist!.vz!, (0.8 - 0.3) / 100, 'frame1 leftWrist vz = (Δz)/dt');
assertEq(enriched[1].joints.rightWrist?.vx, undefined, 'curr confidence 0 → cloned without velocity');
assertEq(enriched[1].joints.leftElbow?.vx, undefined, 'missing prev joint → cloned without velocity');
// Immutability: original input must be untouched.
assertEq(f1.joints.leftWrist?.vx, undefined, 'input frame not mutated');

// ---------------------------------------------------------------------------
// buildWatchImuDebug
// ---------------------------------------------------------------------------

group('buildWatchImuDebug');
assertEq(buildWatchImuDebug(null), null, 'null → null');
assertEq(buildWatchImuDebug(undefined), null, 'undefined → null');
const summary: WatchImuMeasured = { sampleCount: 100, derivedHz: 200, maxAccelMagnitudeG: 5 };
const reading: WatchImuReading = { t: 0, ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 };
const emptyReadings: WatchImuPersist = { readings: [], summary };
assertEq(buildWatchImuDebug(emptyReadings), null, 'empty readings → null');
const persisted: WatchImuPersist = { readings: [reading], summary, alignment: null };
const debug = buildWatchImuDebug(persisted) as unknown as Record<string, unknown>;
assertEq(debug.sampleCount, 100, 'summary spread: sampleCount');
assertEq(debug.derivedHz, 200, 'summary spread: derivedHz');
assertEq(debug.maxAccelMagnitudeG, 5, 'summary spread: maxAccelMagnitudeG');
assertEq(debug.wornWrist, WORN_WRIST, 'wornWrist = WORN_WRIST');
assertEq(debug.clockNote, WATCH_IMU_CLOCK_NOTE, 'clockNote = WATCH_IMU_CLOCK_NOTE');
assertEq(debug.alignment, null, 'alignment defaults to null');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '✅' : '❌'} swingRowBuilders: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
