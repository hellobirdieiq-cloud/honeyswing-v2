/**
 * reconstructAnalysis.test.ts — Batch 5.2 validation
 *
 * Run with: npx tsx lib/reconstructAnalysis.test.ts
 *
 * Pins the safe-defaults contract for history-tap reconstruction: confidence
 * forced low (gates tips off), cameraAngle 'unknown' with zeroed weights, and
 * the null-coalescing rules for each persisted column.
 */

import { reconstructAnalysisFromRecord } from './reconstructAnalysis';
import type { SwingRecord } from './swingStore';

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

const BASE = {
  id: 's1', user_id: 'u1', player_profile_id: null, created_at: '2026-07-01T00:00:00Z',
  frame_count: null, duration_ms: null, pose_success_rate: null, capture_validity: null,
  phase_source: null, failure_reason: null, backswing_ms: null, downswing_ms: null,
  tempo_ratio: null, impact_frame_index: null, app_version: null, coach_name: null,
} as unknown as SwingRecord;

group('safe defaults (tips stay gated off)');
const full = reconstructAnalysisFromRecord({
  ...BASE,
  score: 87,
  honey_boom: true,
  camera_angle_valid: true,
  angles: { spineAngle: 34 },
  tempo: { tempoRatio: 3.0, backswingMs: 750, downswingMs: 250 },
  phases: [{ phase: 'impact', index: 120 }],
  trail_points: [{ x: 0.5, y: 0.5 }],
  metric_confidences: { spineAngle: { visibilityConfidence: 0.9, cameraConfidence: 0.8 } },
} as unknown as SwingRecord);
assert(full.swingConfidence.tier === 'low' && full.swingConfidence.overall === 0, 'confidence forced low/0');
assert(
  full.swingConfidence.components.jointVisibility === 0 &&
  full.swingConfidence.components.cameraAngle === 0 &&
  full.swingConfidence.components.phaseDetection === 0 &&
  full.swingConfidence.components.frameCoverage === 0,
  'all 4 confidence components zeroed',
);
assert(full.cameraAngleResult.angle === 'unknown', 'camera angle unknown');
assert(Object.values(full.cameraAngleResult.weights).every((w) => w === 0), 'all 8 weights zeroed');
assert(full.cameraAngleResult.footIndexNorm === null, 'footIndexNorm null');
assert(full.swing_debug === undefined, 'swing_debug omitted (DB column is a superset)');
assert(full.aggregate === undefined, 'aggregate omitted (not persisted)');

group('persisted columns pass through');
assert(full.score === 87, 'score passes through');
assert(full.honeyBoom === true, 'honey_boom → honeyBoom');
assert(full.cameraAngleValid === true, 'camera_angle_valid passes');
assert(full.angles?.spineAngle === 34, 'angles pass through');
assert(full.tempo?.tempoRatio === 3.0, 'tempo passes through');
assert(full.phases?.length === 1, 'phases pass through');
assert(full.trail?.length === 1, 'trail_points → trail');
assert(full.metricConfidences?.spineAngle?.visibilityConfidence === 0.9, 'metric_confidences pass through');

group('null coalescing');
const nulls = reconstructAnalysisFromRecord({
  ...BASE,
  score: null, honey_boom: null, camera_angle_valid: null,
  angles: null, tempo: null, phases: null, trail_points: null, metric_confidences: null,
} as unknown as SwingRecord);
assert(nulls.score === null, 'score stays null (no coalesce)');
assert(nulls.honeyBoom === false, 'honey_boom null → false');
assert(nulls.cameraAngleValid === false, 'camera_angle_valid null → false');
assert(nulls.angles === undefined, 'angles null → undefined');
assert(nulls.tempo === null, 'tempo null → null (not undefined)');
assert(nulls.phases === undefined, 'phases null → undefined');
assert(nulls.trail === undefined, 'trail null → undefined');
assert(nulls.metricConfidences === undefined, 'metric_confidences null → undefined');

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All tests passed — reconstructAnalysis validated');
}
