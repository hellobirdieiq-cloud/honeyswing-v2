/**
 * detectFineTakeaway.test.ts — ramp-foot fine takeaway, two tiers.
 *
 * Tier (a) SYNTHETIC — ships now: constructed displacement series verifying
 * the hard-cross 3-consecutive rule, the max(3σ, 1.2px) floor, ramp-foot
 * walkback, press-hold exclusion, the coarse−15 scan floor, and null-safety.
 * Expectations are derived from the spec rules, not from implementation runs.
 *
 * Tier (b) DEVICE FIXTURES — loads __fixtures__/refined-disp-clip{1,2}.json
 * IF PRESENT and asserts onset ∈ [77,80] / [56,59]. Until the batched device
 * session supplies those exports this tier prints a loud SKIP (the v8 DATA
 * `disp` field is NOT a substitute — geometry-only vs a GLOBAL reference;
 * the validated onsets used pixel-refined points vs the LOCAL reference).
 * Post-batch lock-in (plan Step 6) makes this tier mandatory.
 *
 * Run with: npx --yes tsx packages/domain/putting/detectFineTakeaway.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildDisplacement,
  computeRefineWindow,
  findOnset,
  HARD_CROSS_MIN_PX,
} from './detectFineTakeaway';
import { applyFineTakeaway } from './applyFineTakeaway';
import type { PuttingDetectorsResult, RefinedHeadPoint } from './types';

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

/**
 * Synthetic series builder: refined points on a straight line so displacement
 * from the rest reference equals |offset|. coarse = 50, so the ref window is
 * [30, 44] and the scan floor is 35.
 */
const COARSE = 50;
const TOP = 90;

function pointsFromOffsets(offsets: Record<number, number>): RefinedHeadPoint[] {
  const { lo, hi } = computeRefineWindow(COARSE, TOP);
  const pts: RefinedHeadPoint[] = [];
  for (let f = lo; f <= hi; f++) {
    pts.push({ gridIdx: f, x: 100 + (offsets[f] ?? 0), y: 200, coasted: false });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// (a) synthetic tier
// ---------------------------------------------------------------------------

group('refine window (spec §4.4)');
assertEq(computeRefineWindow(50, 90).lo, 28, 'lo = coarse−22');
assertEq(computeRefineWindow(50, 90).hi, 68, 'hi = coarse+18 when top is far');
assertEq(computeRefineWindow(50, 60).hi, 60, 'hi clamps to top');

group('hard cross — 3 consecutive over max(3σ, 1.2px)');
{
  // Quiet rest (all zeros → σ=0 → threshold = 1.2px floor). Motion: a clean
  // ramp starting at f52: 0.5, 1.0, 1.5, 2.0, 2.5, ... Hard cross = first f
  // with 3 consecutive > 1.2 → disp 1.5 at f54 (1.5, 2.0, 2.5 all > 1.2).
  const offsets: Record<number, number> = {};
  for (let f = 52; f <= 68; f++) offsets[f] = 0.5 * (f - 51);
  const s = buildDisplacement(pointsFromOffsets(offsets), COARSE)!;
  assert(s !== null && s.sigma === 0, 'quiet rest → σ = 0');
  const r = findOnset(s, COARSE);
  assertEq(r.thresholdPx, HARD_CROSS_MIN_PX, 'threshold = 1.2px floor when 3σ < 1.2');
  assertEq(r.hardCross, 54, 'hard cross = first of 3 consecutive > threshold');
  // Ramp floor = medRest + 2σ = 0 → walkback continues while disp > 0 → f52.
  assertEq(r.onset, 52, 'ramp foot walks back to the rise start');
}

group('two-frame spike is not a cross');
{
  // Spike of 2 frames over threshold then quiet — must NOT cross (needs 3).
  const offsets: Record<number, number> = { 55: 2.0, 56: 2.0 };
  const s = buildDisplacement(pointsFromOffsets(offsets), COARSE)!;
  const r = findOnset(s, COARSE);
  assertEq(r.hardCross, null, '2-frame spike rejected');
  assertEq(r.onset, null, 'no cross → no onset');
}

group('press-hold exclusion — local reference re-centers on the hold');
{
  // Press-hold: the head steps +2.0px BEFORE the window and HOLDS through the
  // whole ref window [30,44] and up to f51; the real stroke ramps from f52.
  // The LOCAL reference (median point over the ref window) re-centers on the
  // held position, so the hold contributes ZERO displacement — this is
  // exactly how v8 excluded clip1's f70-77 press (a plateau is not a ramp;
  // the DATA blob's GLOBAL-reference disp would flag the hold as motion,
  // which is why it is invalid as a findOnset fixture). Onset = the true
  // stroke start f52, never the press step.
  const offsets: Record<number, number> = {};
  for (let f = 28; f <= 68; f++) offsets[f] = f < 52 ? 2.0 : 2.0 + (f - 51) * 0.5;
  const s = buildDisplacement(pointsFromOffsets(offsets), COARSE)!;
  assertEq(s.rx, 102, 'reference re-centered on the held position');
  assertEq(s.medRest, 0, 'held frames contribute zero rest displacement');
  const r = findOnset(s, COARSE);
  assertEq(r.hardCross, 54, 'cross fires in the ramp, not the hold');
  assertEq(r.onset, 52, 'onset = stroke start, press-hold excluded');
}

group('scan floor coarse−15');
{
  // Motion entirely before the scan floor (f30-34, inside ref window) plus
  // noise: crossing frames below coarse−15 are skipped.
  const offsets: Record<number, number> = { 30: 3, 31: 3, 32: 3, 33: 3, 34: 3 };
  const s = buildDisplacement(pointsFromOffsets(offsets), COARSE)!;
  const r = findOnset(s, COARSE);
  assertEq(r.hardCross, null, 'pre-floor motion ignored (no cross ≥ coarse−15)');
}

group('null-safety');
{
  assert(buildDisplacement([], COARSE) === null, 'no points → null series');
  const onlyLate: RefinedHeadPoint[] = [{ gridIdx: 60, x: 1, y: 1, coasted: false }];
  assert(buildDisplacement(onlyLate, COARSE) === null, 'no ref-window points → null series');
}

group('applyFineTakeaway combiner');
{
  const base: PuttingDetectorsResult = {
    impactFrame: 152,
    topFrame: TOP,
    takeawayFrame: COARSE,
    tempo: { backswingFrames: 40, downswingFrames: 62, backswingMs: 333, downswingMs: 517, ratio: 0.65 },
    intermediates: {
      sentinel_filtered_count: 0,
      rest_pos: null,
      backswing_sign: 1,
      crossing_frame: 87,
      plateau: { start: 44, end: 50 },
      warnings: [],
    },
  };
  const offsets: Record<number, number> = {};
  for (let f = 52; f <= 68; f++) offsets[f] = 0.5 * (f - 51);
  const fine = applyFineTakeaway({
    base,
    refinedPoints: pointsFromOffsets(offsets),
    headExtPx: 25,
    anchorCount: 200,
    stepMs: 1000 / 120,
  });
  assertEq(fine.takeawayFrame, 52, 'fine onset replaces takeaway');
  assertEq(fine.intermediates.fine?.coarse_takeaway, COARSE, 'coarse preserved');
  assert(fine.tempo != null && fine.tempo.backswingFrames === TOP - 52, 'tempo recomputed');

  const skipped = applyFineTakeaway({
    base,
    refinedPoints: null,
    headExtPx: null,
    anchorCount: null,
    stepMs: 1000 / 120,
    skipReason: 'no_shaft_len',
  });
  assertEq(skipped.takeawayFrame, COARSE, 'refine skipped → coarse stands');
  assert(skipped.intermediates.warnings.includes('no_shaft_len'), 'skip reason surfaced');
  assert(skipped.tempo === base.tempo, 'tempo untouched on skip (never nulled to 0)');
}

// ---------------------------------------------------------------------------
// (b) device-fixture tier — mandatory after the batched device session
// ---------------------------------------------------------------------------

group('device fixtures (refined-disp, batch session)');
type DeviceFixture = {
  coarse: number;
  top: number;
  expected_onset_window: [number, number];
  refined_points: RefinedHeadPoint[];
};
const deviceCases: { name: string; file: string }[] = [
  { name: 'clip1 51b07a6b', file: 'refined-disp-clip1.json' },
  { name: 'clip2 a347efc8', file: 'refined-disp-clip2.json' },
];
for (const c of deviceCases) {
  const p = path.join(__dirname, '__fixtures__', c.file);
  if (!fs.existsSync(p)) {
    console.log(`  ⏭️  SKIP ${c.name} — device fixture owed (batch session): ${c.file}`);
    continue;
  }
  const fx = JSON.parse(fs.readFileSync(p, 'utf8')) as DeviceFixture;
  const s = buildDisplacement(fx.refined_points, fx.coarse);
  assert(s !== null, `${c.name}: displacement series built`);
  if (s) {
    const r = findOnset(s, fx.coarse);
    const [lo, hi] = fx.expected_onset_window;
    assert(
      r.onset !== null && r.onset >= lo && r.onset <= hi,
      `${c.name}: onset ∈ [${lo},${hi}] (got ${r.onset})`,
    );
  }
}

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All detectFineTakeaway tests passed');
}
