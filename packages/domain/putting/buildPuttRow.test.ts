/**
 * buildPuttRow.test.ts — putt-row shape locked against a canonical fixture
 * (persistSwingRow.test.ts pattern: canonical-sorted JSON, SNAPSHOT_WRITE=1
 * regenerates __fixtures__/puttRow.json after an intentional change).
 *
 * Run with: npx --yes tsx packages/domain/putting/buildPuttRow.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildPuttRow, PUTT_ANALYSIS_VERSION, type BuildPuttRowInput } from './buildPuttRow';
import type { PuttingDetectorsResult } from './types';

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

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce((acc: Record<string, unknown>, key) => {
          acc[key] = (v as Record<string, unknown>)[key];
          return acc;
        }, {});
    }
    return v;
  }, 2);
}

// Deterministic input — values echo the clip2 fixture shape.
const detectors: PuttingDetectorsResult = {
  impactFrame: 151,
  topFrame: 119,
  takeawayFrame: 57,
  tempo: {
    backswingFrames: 62,
    downswingFrames: 32,
    backswingMs: 517,
    downswingMs: 267,
    ratio: 1.94,
  },
  intermediates: {
    sentinel_filtered_count: 45,
    rest_pos: { x: 558.1, y: 1529.1 },
    backswing_sign: -1,
    crossing_frame: 116,
    plateau: { start: 55, end: 59 },
    warnings: [],
    fine: {
      coarse_takeaway: 59,
      onset: 57,
      hard_cross: 60,
      sigma_px: 0.31,
      med_rest_px: 0.2,
      threshold_px: 1.2,
      ramp_floor_px: 0.82,
      refine_window: { lo: 37, hi: 77 },
      ref_window: { lo: 39, hi: 53 },
      head_ext_px: 25,
      disp_by_frame: { '57': 1.4, '58': 2.1 },
      coasted_count: 2,
      anchor_count: 264,
    },
  },
};

const input: BuildPuttRowInput = {
  playerProfileId: 'profile-123',
  appVersion: '1.10.4',
  classification: { validity: 'valid', reason: null },
  frames: [{ timestampMs: 0 }, { timestampMs: 8 }],
  durationMs: 2450.4,
  fpsActual: 240,
  detectors,
  score: 90,
  smoothed: [{ ang: 2.5, px: 237, py: 470.9, hx: 245.5, hy: 664.7, anchor: true }],
  shaftLenPx: 194,
  analysisWidth: 480,
  barCalibration: { shaftLenPx: 194, restStartIdx: 0, restEndIdx: 124, acceptedFitCount: 80, launchFrameIdx: 151 },
  timings: { bar_track_ms: 9000, refine_ms: 800, total_ms: 21000 },
};

console.log('\n── discriminator + column mapping ──');
const row = buildPuttRow(input);
assert(row.analysis_version === PUTT_ANALYSIS_VERSION, `analysis_version === '${PUTT_ANALYSIS_VERSION}'`);
assert(row.score === 90, 'score = tempo band score');
assert(row.tempo_ratio === 1.94, 'tempo_ratio column from putting tempo');
assert(row.backswing_ms === 517 && row.downswing_ms === 267, 'backswing/downswing ms columns');
assert(row.frame_count === 2 && row.duration_ms === 2450, 'frame_count + rounded duration_ms');
assert(row.capture_validity === 'valid' && row.failure_reason === null, 'classification mapping');
const debug = row.swing_debug as { putting?: Record<string, unknown> } | null;
assert(debug?.putting != null, 'swing_debug.putting present');
assert(
  ['takeaway_frame', 'top_frame', 'impact_frame', 'tempo', 'score', 'intermediates',
   'smoothed_series', 'shaft_len_px', 'analysis_width', 'bar_calibration', 'timings']
    .every((k) => k in (debug!.putting as object)),
  'swing_debug.putting carries all replay/ledger fields',
);
assert(!('user_id' in row), 'user_id NOT set by the builder (persistPutt adds it)');

console.log('\n── withheld tempo → null columns, never 0 ──');
const withheldRow = buildPuttRow({
  ...input,
  score: null,
  detectors: { ...detectors, tempo: null, takeawayFrame: null },
});
assert(withheldRow.score === null, 'score null');
assert(
  withheldRow.tempo_ratio === null && withheldRow.backswing_ms === null && withheldRow.downswing_ms === null,
  'tempo columns null',
);

console.log('\n── canonical snapshot ──');
const fixturePath = path.join(__dirname, '__fixtures__', 'puttRow.json');
const actual = canonical(row);
if (process.env.SNAPSHOT_WRITE === '1') {
  fs.writeFileSync(fixturePath, actual + '\n');
  console.log(`  📸 snapshot written: ${fixturePath}`);
  passed++;
} else if (!fs.existsSync(fixturePath)) {
  console.log('  ❌ FAIL: fixture missing — run with SNAPSHOT_WRITE=1 to create');
  failed++;
} else {
  const expected = fs.readFileSync(fixturePath, 'utf8').trimEnd();
  assert(actual === expected, 'row byte-identical to canonical fixture (SNAPSHOT_WRITE=1 to regen)');
}

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All buildPuttRow tests passed');
}
