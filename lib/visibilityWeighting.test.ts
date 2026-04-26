/**
 * visibilityWeighting.test.ts — Task 11 Test Suite
 *
 * Run: npx tsx lib/visibilityWeighting.test.ts
 * NOT Jest. Custom assert harness matching Tasks 5, 7, 8, 9, 10.
 *
 * Coverage:
 *   - Core math (sanitizeVisibility, computeFrameWeight, simpleMean, weightedMean)
 *   - Per-metric computation (computeMetricWeighting)
 *   - Full swing computation (computeVisibilityWeighting)
 *   - Data adapter (buildFrameAngleData)
 *   - Edge cases (NaN, empty, single frame, all excluded)
 *   - Monotonicity (higher visibility → more influence)
 *   - Continuity (small visibility changes → small result changes)
 *   - Fallback behavior (all low visibility → unweighted mean)
 *   - Immutability (inputs not mutated)
 *   - Table/constant integrity
 */

import {
  TABLE_VERSION,
  MIN_VISIBILITY_THRESHOLD,
  EPSILON,
  LANDMARK,
  METRIC_LANDMARKS,
  ALL_METRIC_KEYS,
  sanitizeVisibility,
  computeFrameWeight,
  simpleMean,
  weightedMean,
  computeMetricWeighting,
  computeVisibilityWeighting,
  buildFrameAngleData,
  isGatedMetricKey,
  type FrameAngleData,
  type MetricWeightingResult,
  type GatedMetricKey,
} from '../packages/domain/swing/visibilityWeighting';

// ---------------------------------------------------------------------------
// Test harness (matches existing suites)
// ---------------------------------------------------------------------------

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

function assertApprox(actual: number, expected: number, tolerance: number, msg: string): void {
  if (Number.isNaN(expected) && Number.isNaN(actual)) {
    passed++;
    return;
  }
  if (Math.abs(actual - expected) <= tolerance) {
    passed++;
  } else {
    failed++;
    console.error(
      `  FAIL [${currentGroup}]: ${msg} — expected ~${expected} (±${tolerance}), got ${actual}`
    );
  }
}

function assertNaN(actual: number, msg: string): void {
  if (Number.isNaN(actual)) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL [${currentGroup}]: ${msg} — expected NaN, got ${actual}`);
  }
}

function assertThrows(fn: () => void, msg: string): void {
  try {
    fn();
    failed++;
    console.error(`  FAIL [${currentGroup}]: ${msg} — expected throw, got none`);
  } catch {
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Helpers to build test data
// ---------------------------------------------------------------------------

function makeFrame(angle: number, visibilities: number[]): FrameAngleData {
  return { angle, landmarkVisibilities: visibilities };
}

function makeUniformFrames(
  angles: number[],
  visibility: number,
  landmarkCount: number = 4
): FrameAngleData[] {
  return angles.map(a => makeFrame(a, Array(landmarkCount).fill(visibility)));
}

function make33Vis(overrides: Record<number, number> = {}): number[] {
  const vis = Array(33).fill(0.95);
  for (const [idx, val] of Object.entries(overrides)) {
    vis[Number(idx)] = val;
  }
  return vis;
}

// ===========================================================================
// TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. sanitizeVisibility
// ---------------------------------------------------------------------------
group('sanitizeVisibility');

assertEq(sanitizeVisibility(0.5), 0.5, 'normal value passthrough');
assertEq(sanitizeVisibility(0), 0, 'zero stays zero');
assertEq(sanitizeVisibility(1), 1, 'one stays one');
assertEq(sanitizeVisibility(-0.5), 0, 'negative clamped to 0');
assertEq(sanitizeVisibility(-100), 0, 'large negative clamped to 0');
assertEq(sanitizeVisibility(1.5), 1, 'above 1 clamped to 1');
assertEq(sanitizeVisibility(100), 1, 'large positive clamped to 1');
assertEq(sanitizeVisibility(NaN), 0, 'NaN → 0');
assertEq(sanitizeVisibility(Infinity), 0, 'Infinity → 0');
assertEq(sanitizeVisibility(-Infinity), 0, '-Infinity → 0');
assertEq(sanitizeVisibility(undefined), 0, 'undefined → 0');
assertEq(sanitizeVisibility(null), 0, 'null → 0');
assertEq(sanitizeVisibility(0.001), 0.001, 'tiny positive preserved');
assertEq(sanitizeVisibility(0.999), 0.999, 'near-one preserved');

// ---------------------------------------------------------------------------
// 2. computeFrameWeight
// ---------------------------------------------------------------------------
group('computeFrameWeight');

// Basic
assertEq(computeFrameWeight([0.9, 0.8, 0.7, 0.6]), 0.6, 'min of 4 visibilities');
assertEq(computeFrameWeight([1.0, 1.0]), 1.0, 'all perfect → 1.0');
assertEq(computeFrameWeight([0.5, 0.5, 0.5]), 0.5, 'all equal → that value');
assertEq(computeFrameWeight([0.9, 0.9, 0.05]), 0, 'one below threshold → 0');
assertEq(computeFrameWeight([0.09]), 0, 'single below threshold → 0');
assertEq(computeFrameWeight([0.1]), 0.1, 'exactly at threshold → included');
assertEq(computeFrameWeight([0.11]), 0.11, 'just above threshold → included');
assertEq(computeFrameWeight([]), 0, 'empty array → 0');

// Threshold boundary
assertEq(computeFrameWeight([0.99, 0.99, 0.099]), 0, '0.099 < 0.1 → excluded');
assertEq(computeFrameWeight([0.99, 0.99, 0.100]), 0.100, '0.100 = 0.1 → included');
assert(computeFrameWeight([0.99, 0.99, 0.101]) > 0, '0.101 > 0.1 → included');

// NaN/bad values in landmarks
assertEq(computeFrameWeight([0.9, NaN, 0.8]), 0, 'NaN landmark → weight 0 (sanitized to 0)');
assertEq(computeFrameWeight([0.9, -1, 0.8]), 0, 'negative landmark → weight 0');

// Min selection
assertEq(computeFrameWeight([0.3, 0.9, 0.8, 0.7]), 0.3, 'picks min correctly');
assertEq(computeFrameWeight([0.9, 0.8, 0.7, 0.2]), 0.2, 'min at end');
assertEq(computeFrameWeight([0.15, 0.9, 0.9, 0.9]), 0.15, 'min at start');

// ---------------------------------------------------------------------------
// 3. simpleMean
// ---------------------------------------------------------------------------
group('simpleMean');

assertApprox(simpleMean([10, 20, 30]), 20, 0.001, 'simple 3-value mean');
assertApprox(simpleMean([5]), 5, 0.001, 'single value');
assertApprox(simpleMean([0, 100]), 50, 0.001, 'two values');
assertNaN(simpleMean([]), 'empty array → NaN');
assertApprox(simpleMean([33.3, 33.3, 33.3]), 33.3, 0.001, 'uniform values');
assertApprox(simpleMean([-10, 10]), 0, 0.001, 'negative and positive');

// ---------------------------------------------------------------------------
// 4. weightedMean
// ---------------------------------------------------------------------------
group('weightedMean');

// Basic weighted mean
{
  const { result, fellBack } = weightedMean([10, 20], [1, 1]);
  assertApprox(result, 15, 0.001, 'equal weights → simple mean');
  assertEq(fellBack, false, 'equal weights → no fallback');
}
{
  const { result, fellBack } = weightedMean([10, 20], [1, 3]);
  assertApprox(result, 17.5, 0.001, 'weighted toward higher weight');
  assertEq(fellBack, false, 'no fallback');
}
{
  const { result, fellBack } = weightedMean([10, 20], [3, 1]);
  assertApprox(result, 12.5, 0.001, 'weighted toward first');
  assertEq(fellBack, false, 'no fallback');
}
{
  const { result, fellBack } = weightedMean([10, 20], [1, 0]);
  assertApprox(result, 10, 0.001, 'zero weight → only first counts');
  assertEq(fellBack, false, 'no fallback (one weight nonzero)');
}
{
  const { result, fellBack } = weightedMean([10, 20], [0, 1]);
  assertApprox(result, 20, 0.001, 'zero weight → only second counts');
  assertEq(fellBack, false, 'no fallback');
}

// Fallback
{
  const { result, fellBack } = weightedMean([10, 20], [0, 0]);
  assertApprox(result, 15, 0.001, 'all zero weights → falls back to simple mean');
  assertEq(fellBack, true, 'fellBack = true');
}

// Edge cases
{
  const { result } = weightedMean([42], [0.5]);
  assertApprox(result, 42, 0.001, 'single value returns that value');
}
{
  const { result } = weightedMean([], []);
  assertNaN(result, 'empty → NaN');
}

// Length mismatch throws
assertThrows(
  () => weightedMean([1, 2], [1]),
  'mismatched lengths throws'
);

// Very small weights (above EPSILON)
{
  const { result, fellBack } = weightedMean([10, 20], [0.0001, 0.0001]);
  assertApprox(result, 15, 0.001, 'tiny equal weights → simple mean equivalent');
  assertEq(fellBack, false, 'tiny weights above EPSILON → no fallback');
}

// 5-frame weighted mean (realistic scenario)
{
  const angles = [34.0, 34.5, 35.0, 34.2, 33.8];
  const weights = [0.9, 0.85, 0.3, 0.88, 0.92];
  const { result } = weightedMean(angles, weights);
  // Manual: (34*0.9 + 34.5*0.85 + 35*0.3 + 34.2*0.88 + 33.8*0.92) / (0.9+0.85+0.3+0.88+0.92)
  // = (30.6 + 29.325 + 10.5 + 30.096 + 31.096) / 3.85
  // = 131.617 / 3.85 = 34.1863...
  assertApprox(result, 34.1863, 0.01, '5-frame realistic weighted mean');
}

// ---------------------------------------------------------------------------
// 5. computeMetricWeighting — core scenarios from handoff
// ---------------------------------------------------------------------------
group('computeMetricWeighting — all visible');

// Scenario 1: All landmarks fully visible → weighted ≈ unweighted within 0.001°
{
  const frames = makeUniformFrames([34.0, 34.5, 35.0, 34.2, 33.8], 1.0, 4);
  const r = computeMetricWeighting(frames);
  assertApprox(r.weightedValue, r.unweightedValue, 0.001,
    'all vis=1.0 → weighted matches unweighted');
  assertApprox(r.delta, 0, 0.001, 'delta ≈ 0');
  assertEq(r.framesUsed, 5, '5 frames used');
  assertEq(r.framesExcluded, 0, '0 excluded');
  assertApprox(r.avgWeight, 1.0, 0.001, 'avg weight = 1.0');
  assertApprox(r.minWeight, 1.0, 0.001, 'min weight = 1.0');
  assertEq(r.applied, true, 'applied = true');
}

// Scenario 1b: High but not perfect visibility → still nearly identical
{
  const frames = makeUniformFrames([30, 31, 32], 0.95, 2);
  const r = computeMetricWeighting(frames);
  assertApprox(r.weightedValue, r.unweightedValue, 0.001,
    'uniform 0.95 → weighted ≈ unweighted');
}

group('computeMetricWeighting — partial occlusion');

// Scenario 2: One frame with occluded landmark → result shifts toward visible frames
{
  const frames = [
    makeFrame(34.0, [0.9, 0.9, 0.9, 0.9]),  // weight = 0.9
    makeFrame(35.0, [0.9, 0.9, 0.9, 0.3]),  // weight = 0.3
    makeFrame(34.0, [0.9, 0.9, 0.9, 0.9]),  // weight = 0.9
  ];
  const r = computeMetricWeighting(frames);
  // Unweighted: (34 + 35 + 34) / 3 = 34.333...
  // Weighted: (34*0.9 + 35*0.3 + 34*0.9) / (0.9+0.3+0.9) = (30.6+10.5+30.6)/2.1 = 71.7/2.1 = 34.143
  assertApprox(r.unweightedValue, 34.333, 0.01, 'unweighted mean correct');
  assertApprox(r.weightedValue, 34.143, 0.01, 'weighted shifts away from occluded frame');
  assert(r.weightedValue < r.unweightedValue, 'weighted < unweighted (away from outlier)');
  assertEq(r.framesUsed, 3, 'all 3 frames used (0.3 > 0.1)');
  assertEq(r.applied, true, 'applied');
}

// Scenario 2b: Strong occlusion on middle frame (angle outlier)
{
  const frames = [
    makeFrame(34.0, [0.95, 0.95, 0.95, 0.95]),
    makeFrame(40.0, [0.95, 0.95, 0.95, 0.12]),  // outlier, low vis
    makeFrame(34.0, [0.95, 0.95, 0.95, 0.95]),
  ];
  const r = computeMetricWeighting(frames);
  // Outlier at 40° is down-weighted to 0.12
  assert(Math.abs(r.weightedValue - 34.0) < Math.abs(r.unweightedValue - 34.0),
    'weighted closer to true value than unweighted');
}

group('computeMetricWeighting — all low visibility (fallback)');

// Scenario 3: All frames below threshold → fallback to unweighted
{
  const frames = makeUniformFrames([34, 35, 36], 0.05, 4);
  const r = computeMetricWeighting(frames);
  assertApprox(r.weightedValue, 35, 0.001, 'falls back to unweighted mean = 35');
  assertApprox(r.unweightedValue, 35, 0.001, 'unweighted = 35');
  assertEq(r.framesExcluded, 3, 'all 3 excluded');
  assertEq(r.framesUsed, 0, '0 used');
  assertEq(r.applied, false, 'applied = false (fallback)');
}

// Scenario 3b: Mix of below-threshold, all excluded
{
  const frames = [
    makeFrame(30, [0.09, 0.5, 0.5, 0.5]),  // min = 0.09 → excluded
    makeFrame(35, [0.5, 0.5, 0.04, 0.5]),   // min = 0.04 → excluded
    makeFrame(40, [0.5, 0.5, 0.5, 0.01]),   // min = 0.01 → excluded
  ];
  const r = computeMetricWeighting(frames);
  assertApprox(r.weightedValue, 35, 0.001, 'fallback to unweighted = 35');
  assertEq(r.applied, false, 'applied = false');
  assertEq(r.framesExcluded, 3, 'all excluded');
}

group('computeMetricWeighting — threshold exclusion');

// Scenario 4: Visibility below threshold → frame excluded entirely
{
  const frames = [
    makeFrame(34.0, [0.9, 0.9, 0.9, 0.9]),  // included
    makeFrame(50.0, [0.9, 0.9, 0.9, 0.05]), // EXCLUDED (0.05 < 0.1)
    makeFrame(34.0, [0.9, 0.9, 0.9, 0.9]),  // included
  ];
  const r = computeMetricWeighting(frames);
  // Only frames 0 and 2 count (both 34.0, weight 0.9)
  assertApprox(r.weightedValue, 34.0, 0.001, 'excluded frame has zero influence');
  assertEq(r.framesUsed, 2, '2 frames used');
  assertEq(r.framesExcluded, 1, '1 frame excluded');
  assertEq(r.applied, true, 'applied');
  // Unweighted includes the excluded frame's angle
  assertApprox(r.unweightedValue, (34 + 50 + 34) / 3, 0.01, 'unweighted includes all');
}

group('computeMetricWeighting — min selection');

// Scenario 5: Mixed visibility → min picks worst
{
  const frames = [
    makeFrame(30, [0.9, 0.2, 0.8, 0.7]),  // min = 0.2
    makeFrame(30, [0.3, 0.9, 0.9, 0.9]),  // min = 0.3
  ];
  const r = computeMetricWeighting(frames);
  assertApprox(r.minWeight, 0.2, 0.001, 'min weight = 0.2');
  assertApprox(r.avgWeight, 0.25, 0.001, 'avg weight = (0.2+0.3)/2 = 0.25');
}

group('computeMetricWeighting — single frame');

// Scenario 6: Single frame → returns angle directly
{
  const frames = [makeFrame(42.5, [0.9, 0.8])];
  const r = computeMetricWeighting(frames);
  assertApprox(r.weightedValue, 42.5, 0.001, 'single frame → angle directly');
  assertApprox(r.unweightedValue, 42.5, 0.001, 'unweighted same');
  assertApprox(r.delta, 0, 0.001, 'delta = 0');
  assertEq(r.framesUsed, 1, '1 frame used');
  assertEq(r.applied, false, 'not applied (nothing to weight against)');
}

// Single frame with low visibility — still returns it
{
  const frames = [makeFrame(42.5, [0.05])];
  const r = computeMetricWeighting(frames);
  assertApprox(r.weightedValue, 42.5, 0.001, 'single frame even if low vis');
  assertEq(r.framesUsed, 1, 'still used');
}

group('computeMetricWeighting — NaN visibility');

// Scenario 7: NaN visibility → treated as 0 → excluded
{
  const frames = [
    makeFrame(34, [0.9, 0.9, NaN, 0.9]),   // NaN → sanitized to 0 → excluded
    makeFrame(35, [0.9, 0.9, 0.9, 0.9]),   // included
  ];
  const r = computeMetricWeighting(frames);
  assertApprox(r.weightedValue, 35, 0.001, 'NaN frame excluded, only frame2 counts');
  assertEq(r.framesExcluded, 1, '1 excluded (NaN)');
  assertEq(r.framesUsed, 1, '1 used');
}

group('computeMetricWeighting — empty frames');

// Scenario 8: Empty frame array → NaN, not crash
{
  const r = computeMetricWeighting([]);
  assertNaN(r.weightedValue, 'empty → NaN weighted');
  assertNaN(r.unweightedValue, 'empty → NaN unweighted');
  assertEq(r.framesUsed, 0, '0 used');
  assertEq(r.framesExcluded, 0, '0 excluded');
  assertEq(r.applied, false, 'not applied');
}

// ---------------------------------------------------------------------------
// 6. Monotonicity — higher visibility → more influence
// ---------------------------------------------------------------------------
group('monotonicity — visibility influence');

// As the occluded frame's visibility increases, its angle has more pull
{
  const baseAngle = 34.0;
  const outlierAngle = 40.0;
  let prevWeighted = baseAngle; // at vis=0, outlier has no pull

  // Test visibility from 0.0 to 1.0 in steps of 0.05
  let monotonic = true;
  const steps: number[] = [];
  for (let vis = 0.0; vis <= 1.0; vis += 0.05) {
    const frames = [
      makeFrame(baseAngle, [0.95, 0.95, 0.95, 0.95]),
      makeFrame(outlierAngle, [0.95, 0.95, 0.95, vis]),
      makeFrame(baseAngle, [0.95, 0.95, 0.95, 0.95]),
    ];
    const r = computeMetricWeighting(frames);
    steps.push(r.weightedValue);

    // Once above threshold, increasing visibility should pull toward outlier
    if (vis >= MIN_VISIBILITY_THRESHOLD + 0.05) {
      // Check: as vis goes up, weighted value should move toward outlierAngle (increase)
      // Allow tiny floating point tolerance
      if (r.weightedValue < prevWeighted - 0.0001) {
        monotonic = false;
      }
    }
    if (vis >= MIN_VISIBILITY_THRESHOLD) {
      prevWeighted = r.weightedValue;
    }
  }
  assert(monotonic, 'weighted value monotonically moves toward outlier as its visibility increases');
  passed++; // count the overall check
}

// Per-step monotonicity across 21 visibility levels for 7 metrics
{
  let totalChecks = 0;
  let monotonePasses = 0;

  for (const metricKey of ALL_METRIC_KEYS) {
    const numLandmarks = METRIC_LANDMARKS[metricKey].length;
    let prevResult = -Infinity;

    for (let vis = 0.15; vis <= 1.0; vis += 0.05) {
      // Frame 1: angle 30, all visible. Frame 2: angle 40, last landmark = vis
      const vis1 = Array(numLandmarks).fill(0.95);
      const vis2 = Array(numLandmarks).fill(0.95);
      vis2[vis2.length - 1] = vis; // vary last landmark

      const frames = [
        makeFrame(30, vis1),
        makeFrame(40, vis2),
      ];
      const r = computeMetricWeighting(frames);

      totalChecks++;
      if (r.weightedValue >= prevResult - 0.0001) {
        monotonePasses++;
      }
      prevResult = r.weightedValue;
    }
  }
  assert(monotonePasses === totalChecks,
    `per-metric monotonicity: ${monotonePasses}/${totalChecks} passed`);
}

// ---------------------------------------------------------------------------
// 7. Continuity — small visibility change → small result change
// ---------------------------------------------------------------------------
group('continuity');

{
  let totalChecks = 0;
  let continuityPasses = 0;
  const MAX_JUMP = 0.5; // max 0.5° change per 0.01 visibility step

  for (const metricKey of ALL_METRIC_KEYS) {
    const numLandmarks = METRIC_LANDMARKS[metricKey].length;
    let prevResult: number | null = null;

    for (let vis = 0.10; vis <= 1.0; vis += 0.01) {
      const vis1 = Array(numLandmarks).fill(0.95);
      const vis2 = Array(numLandmarks).fill(0.95);
      vis2[vis2.length - 1] = vis;

      const frames = [
        makeFrame(30, vis1),
        makeFrame(40, vis2),
        makeFrame(30, vis1),
      ];
      const r = computeMetricWeighting(frames);

      if (prevResult !== null) {
        totalChecks++;
        if (Math.abs(r.weightedValue - prevResult) <= MAX_JUMP) {
          continuityPasses++;
        }
      }
      prevResult = r.weightedValue;
    }
  }
  assert(continuityPasses === totalChecks,
    `continuity: ${continuityPasses}/${totalChecks} (max ${0.5}° jump per 0.01 vis step)`);
}

// ---------------------------------------------------------------------------
// 8. Symmetry — same vis values in different order → same weight
// ---------------------------------------------------------------------------
group('symmetry');

{
  const frames1 = [
    makeFrame(30, [0.9, 0.3, 0.8, 0.5]),
    makeFrame(35, [0.5, 0.9, 0.3, 0.8]),
  ];
  const frames2 = [
    makeFrame(30, [0.3, 0.9, 0.5, 0.8]),
    makeFrame(35, [0.8, 0.5, 0.9, 0.3]),
  ];
  const r1 = computeMetricWeighting(frames1);
  const r2 = computeMetricWeighting(frames2);
  // Both have min vis [0.3, 0.3] → same weights → same result
  assertApprox(r1.weightedValue, r2.weightedValue, 0.001,
    'same min visibilities in different order → same result');
}

// ---------------------------------------------------------------------------
// 9. computeVisibilityWeighting — full swing
// ---------------------------------------------------------------------------
group('computeVisibilityWeighting — full swing');

{
  const metricFrames: Record<string, FrameAngleData[]> = {
    spineAngle: makeUniformFrames([34, 35, 36], 0.9, 4),
    shoulderTilt: makeUniformFrames([10, 11, 12], 0.95, 2),
    hipSpreadDelta: [
      makeFrame(40, [0.9, 0.05]),  // excluded
      makeFrame(42, [0.9, 0.9]),   // included
      makeFrame(41, [0.9, 0.9]),   // included
    ],
  };
  const r = computeVisibilityWeighting(metricFrames);

  assertEq(r.applied, true, 'applied = true (at least one metric)');
  assertEq(r.version, TABLE_VERSION, 'version matches');
  assert('spineAngle' in r.metrics, 'spineAngle present');
  assert('shoulderTilt' in r.metrics, 'shoulderTilt present');
  assert('hipSpreadDelta' in r.metrics, 'hipSpreadDelta present');
  assertEq(r.metrics.hipSpreadDelta.framesExcluded, 1, 'hipSpreadDelta: 1 excluded');
  assertEq(r.metrics.hipSpreadDelta.framesUsed, 2, 'hipSpreadDelta: 2 used');
}

// All metrics fallback → applied = false
{
  const metricFrames: Record<string, FrameAngleData[]> = {
    spineAngle: makeUniformFrames([34], 0.9, 4), // single frame → applied=false
    shoulderTilt: makeUniformFrames([10], 0.9, 2), // single frame
  };
  const r = computeVisibilityWeighting(metricFrames);
  assertEq(r.applied, false, 'all single-frame → applied = false overall');
}

// Empty map
{
  const r = computeVisibilityWeighting({});
  assertEq(r.applied, false, 'empty map → applied = false');
  assertEq(Object.keys(r.metrics).length, 0, 'no metrics');
}

// ---------------------------------------------------------------------------
// 10. buildFrameAngleData — adapter
// ---------------------------------------------------------------------------
group('buildFrameAngleData');

{
  const angles = [34, 35, 36];
  const vis = [
    make33Vis({ 11: 0.9, 12: 0.8, 23: 0.7, 24: 0.3 }),
    make33Vis({ 11: 0.95, 12: 0.95, 23: 0.95, 24: 0.95 }),
    make33Vis({ 11: 0.85, 12: 0.85, 23: 0.85, 24: 0.05 }),
  ];
  const result = buildFrameAngleData(angles, vis, 'spineAngle');

  assertEq(result.length, 3, '3 frames');
  // Frame 0: landmarks 11,12,23,24 → vis [0.9, 0.8, 0.7, 0.3]
  assertApprox(result[0].landmarkVisibilities[0], 0.9, 0.001, 'frame0 L11 = 0.9');
  assertApprox(result[0].landmarkVisibilities[1], 0.8, 0.001, 'frame0 L12 = 0.8');
  assertApprox(result[0].landmarkVisibilities[2], 0.7, 0.001, 'frame0 L23 = 0.7');
  assertApprox(result[0].landmarkVisibilities[3], 0.3, 0.001, 'frame0 L24 = 0.3');
  assertApprox(result[0].angle, 34, 0.001, 'frame0 angle');

  // Frame 2: L24 = 0.05
  assertApprox(result[2].landmarkVisibilities[3], 0.05, 0.001, 'frame2 L24 = 0.05');
}

// Different metric uses different landmarks
{
  const angles = [90];
  const vis = [make33Vis({ 12: 0.7, 14: 0.3, 16: 0.5 })];
  const result = buildFrameAngleData(angles, vis, 'rightElbowAngle');
  // rightElbowAngle: landmarks [12, 14, 16]
  assertEq(result[0].landmarkVisibilities.length, 3, 'rightElbow uses 3 landmarks');
  assertApprox(result[0].landmarkVisibilities[0], 0.7, 0.001, 'L12');
  assertApprox(result[0].landmarkVisibilities[1], 0.3, 0.001, 'L14');
  assertApprox(result[0].landmarkVisibilities[2], 0.5, 0.001, 'L16');
}

// Length mismatch throws
assertThrows(
  () => buildFrameAngleData([1, 2], [make33Vis()], 'spineAngle'),
  'angle/vis length mismatch throws'
);

// Unknown metric throws
assertThrows(
  () => buildFrameAngleData([1], [make33Vis()], 'fakeMetric' as GatedMetricKey),
  'unknown metric throws'
);

// Landmark index out of range → returns 0
{
  const shortVis = [Array(10).fill(0.9)]; // only 10 entries, but L11 needed
  const result = buildFrameAngleData([30], shortVis, 'spineAngle');
  // L11, L12, L23, L24 all out of range → visibility 0
  assertApprox(result[0].landmarkVisibilities[0], 0, 0.001, 'out-of-range → 0');
}

// ---------------------------------------------------------------------------
// 11. isGatedMetricKey
// ---------------------------------------------------------------------------
group('isGatedMetricKey');

assertEq(isGatedMetricKey('spineAngle'), true, 'spineAngle is gated');
assertEq(isGatedMetricKey('shoulderTilt'), true, 'shoulderTilt is gated');
assertEq(isGatedMetricKey('hipSpreadDelta'), true, 'hipSpreadDelta is gated');
assertEq(isGatedMetricKey('leftElbowAngle'), true, 'leftElbowAngle is gated');
assertEq(isGatedMetricKey('rightElbowAngle'), true, 'rightElbowAngle is gated');
assertEq(isGatedMetricKey('leftKneeAngle'), true, 'leftKneeAngle is gated');
assertEq(isGatedMetricKey('rightKneeAngle'), true, 'rightKneeAngle is gated');
assertEq(isGatedMetricKey('fakeMetric'), false, 'fakeMetric is not gated');
assertEq(isGatedMetricKey(''), false, 'empty string not gated');
assertEq(isGatedMetricKey('SPINEANGLE'), false, 'case sensitive');

// ---------------------------------------------------------------------------
// 12. Constants & table integrity
// ---------------------------------------------------------------------------
group('constants integrity');

assertEq(typeof TABLE_VERSION, 'string', 'TABLE_VERSION is string');
assert(TABLE_VERSION.length > 0, 'TABLE_VERSION non-empty');
assertEq(MIN_VISIBILITY_THRESHOLD, 0.1, 'threshold = 0.1');
assert(EPSILON > 0, 'EPSILON > 0');
assert(EPSILON < 0.001, 'EPSILON is tiny');

// METRIC_LANDMARKS has all 7 metrics
assertEq(ALL_METRIC_KEYS.length, 7, '7 metric keys');
assert(ALL_METRIC_KEYS.includes('spineAngle'), 'includes spineAngle');
assert(ALL_METRIC_KEYS.includes('shoulderTilt'), 'includes shoulderTilt');
assert(ALL_METRIC_KEYS.includes('hipSpreadDelta'), 'includes hipSpreadDelta');
assert(ALL_METRIC_KEYS.includes('leftElbowAngle'), 'includes leftElbowAngle');
assert(ALL_METRIC_KEYS.includes('rightElbowAngle'), 'includes rightElbowAngle');
assert(ALL_METRIC_KEYS.includes('leftKneeAngle'), 'includes leftKneeAngle');
assert(ALL_METRIC_KEYS.includes('rightKneeAngle'), 'includes rightKneeAngle');

// Landmark indices correct
assertEq(LANDMARK.LEFT_SHOULDER, 11, 'L_SHOULDER = 11');
assertEq(LANDMARK.RIGHT_SHOULDER, 12, 'R_SHOULDER = 12');
assertEq(LANDMARK.LEFT_ELBOW, 13, 'L_ELBOW = 13');
assertEq(LANDMARK.RIGHT_ELBOW, 14, 'R_ELBOW = 14');
assertEq(LANDMARK.LEFT_WRIST, 15, 'L_WRIST = 15');
assertEq(LANDMARK.RIGHT_WRIST, 16, 'R_WRIST = 16');
assertEq(LANDMARK.LEFT_HIP, 23, 'L_HIP = 23');
assertEq(LANDMARK.RIGHT_HIP, 24, 'R_HIP = 24');
assertEq(LANDMARK.LEFT_KNEE, 25, 'L_KNEE = 25');
assertEq(LANDMARK.RIGHT_KNEE, 26, 'R_KNEE = 26');
assertEq(LANDMARK.LEFT_ANKLE, 27, 'L_ANKLE = 27');
assertEq(LANDMARK.RIGHT_ANKLE, 28, 'R_ANKLE = 28');

// Each metric has at least 2 landmarks
for (const key of ALL_METRIC_KEYS) {
  assert(METRIC_LANDMARKS[key].length >= 2, `${key} has >= 2 landmarks`);
  // All landmark indices are valid (0-32)
  for (const idx of METRIC_LANDMARKS[key]) {
    assert(idx >= 0 && idx <= 32, `${key} landmark ${idx} in valid range`);
  }
}

// Specific landmark counts per metric
assertEq(METRIC_LANDMARKS.spineAngle.length, 4, 'spineAngle uses 4 landmarks');
assertEq(METRIC_LANDMARKS.shoulderTilt.length, 2, 'shoulderTilt uses 2 landmarks');
assertEq(METRIC_LANDMARKS.hipSpreadDelta.length, 2, 'hipSpreadDelta uses 2 landmarks');
assertEq(METRIC_LANDMARKS.leftElbowAngle.length, 3, 'leftElbowAngle uses 3 landmarks');
assertEq(METRIC_LANDMARKS.rightElbowAngle.length, 3, 'rightElbowAngle uses 3 landmarks');
assertEq(METRIC_LANDMARKS.leftKneeAngle.length, 3, 'leftKneeAngle uses 3 landmarks');
assertEq(METRIC_LANDMARKS.rightKneeAngle.length, 3, 'rightKneeAngle uses 3 landmarks');

// ---------------------------------------------------------------------------
// 13. Immutability — inputs not mutated
// ---------------------------------------------------------------------------
group('immutability');

{
  const frames: FrameAngleData[] = [
    { angle: 34, landmarkVisibilities: [0.9, 0.8, 0.7, 0.6] },
    { angle: 36, landmarkVisibilities: [0.95, 0.95, 0.95, 0.95] },
  ];
  const anglesBefore = frames.map(f => f.angle);
  const visBefore = frames.map(f => [...f.landmarkVisibilities]);

  computeMetricWeighting(frames);

  for (let i = 0; i < frames.length; i++) {
    assertEq(frames[i].angle, anglesBefore[i], `frame ${i} angle not mutated`);
    for (let j = 0; j < frames[i].landmarkVisibilities.length; j++) {
      assertEq(
        frames[i].landmarkVisibilities[j],
        visBefore[i][j],
        `frame ${i} vis[${j}] not mutated`
      );
    }
  }
}

// buildFrameAngleData input immutability
{
  const angles = [30, 35];
  const vis = [make33Vis(), make33Vis()];
  const anglesCopy = [...angles];
  const visCopy = vis.map(v => [...v]);

  buildFrameAngleData(angles, vis, 'spineAngle');

  for (let i = 0; i < angles.length; i++) {
    assertEq(angles[i], anglesCopy[i], `buildFrameAngleData angle ${i} not mutated`);
    for (let j = 0; j < vis[i].length; j++) {
      assertEq(vis[i][j], visCopy[i][j], `buildFrameAngleData vis[${i}][${j}] not mutated`);
    }
  }
}

// METRIC_LANDMARKS is frozen
{
  (METRIC_LANDMARKS as any).newKey = [1, 2];
  assert(!('newKey' in METRIC_LANDMARKS), 'METRIC_LANDMARKS is frozen (assignment ignored)');
}

// ---------------------------------------------------------------------------
// 14. Realistic multi-metric swing scenario
// ---------------------------------------------------------------------------
group('realistic swing scenario');

{
  // Simulated swing: 5 frames, face-on angle, trail hip partially occluded on frames 2-3
  const spineFrames: FrameAngleData[] = [
    makeFrame(32.0, [0.95, 0.93, 0.91, 0.90]),  // all good
    makeFrame(33.0, [0.94, 0.92, 0.90, 0.88]),  // all good
    makeFrame(38.0, [0.93, 0.91, 0.89, 0.15]),  // trail hip occluded → weight 0.15
    makeFrame(39.0, [0.92, 0.90, 0.88, 0.08]),  // trail hip below threshold → EXCLUDED
    makeFrame(32.5, [0.95, 0.93, 0.91, 0.92]),  // all good
  ];

  const shoulderFrames: FrameAngleData[] = [
    makeFrame(5.0, [0.95, 0.93]),
    makeFrame(5.5, [0.94, 0.92]),
    makeFrame(5.2, [0.93, 0.91]),
    makeFrame(5.8, [0.92, 0.90]),
    makeFrame(5.1, [0.95, 0.93]),
  ];

  const r = computeVisibilityWeighting({
    spineAngle: spineFrames,
    shoulderTilt: shoulderFrames,
  });

  // Spine: frame 3 (39°) excluded, frame 2 (38°) down-weighted to 0.15
  const spine = r.metrics.spineAngle;
  assertEq(spine.framesExcluded, 1, 'spine: 1 frame excluded');
  assertEq(spine.framesUsed, 4, 'spine: 4 frames used');
  assert(spine.applied, 'spine: weighting applied');
  // Weighted value should be closer to 32-33 range than unweighted
  assert(spine.weightedValue < spine.unweightedValue,
    'spine: weighted pulls away from occluded outliers');

  // Shoulders: all visible, nearly uniform → tiny delta
  const shoulder = r.metrics.shoulderTilt;
  assertEq(shoulder.framesExcluded, 0, 'shoulder: none excluded');
  assertEq(shoulder.framesUsed, 5, 'shoulder: all used');
  assert(Math.abs(shoulder.delta) < 0.1, 'shoulder: delta < 0.1° (all visible)');

  assertEq(r.applied, true, 'overall applied = true');
}

// ---------------------------------------------------------------------------
// 15. Boundary precision — threshold at exactly 0.1
// ---------------------------------------------------------------------------
group('threshold boundary precision');

{
  // Test visibility values around the 0.1 threshold
  const testVals = [0.09, 0.099, 0.0999, 0.1, 0.1001, 0.101, 0.11];
  const expectedIncluded = [false, false, false, true, true, true, true];

  for (let i = 0; i < testVals.length; i++) {
    const w = computeFrameWeight([0.9, 0.9, 0.9, testVals[i]]);
    const isIncluded = w > 0;
    assertEq(isIncluded, expectedIncluded[i],
      `vis=${testVals[i]} → ${expectedIncluded[i] ? 'included' : 'excluded'}`);
  }
}

// ---------------------------------------------------------------------------
// 16. Weight correctness — verify exact math
// ---------------------------------------------------------------------------
group('exact weight math');

{
  // 3 frames with known weights, verify the weighted mean exactly
  const frames = [
    makeFrame(10, [0.8, 0.5]),  // weight = min(0.8, 0.5) = 0.5
    makeFrame(20, [0.6, 0.3]),  // weight = min(0.6, 0.3) = 0.3
    makeFrame(30, [0.9, 0.7]),  // weight = min(0.9, 0.7) = 0.7
  ];
  const r = computeMetricWeighting(frames);

  // Expected: (10*0.5 + 20*0.3 + 30*0.7) / (0.5 + 0.3 + 0.7)
  //         = (5 + 6 + 21) / 1.5 = 32 / 1.5 = 21.333...
  assertApprox(r.weightedValue, 21.3333, 0.01, 'exact weighted mean');
  assertApprox(r.unweightedValue, 20, 0.001, 'unweighted = 20');
  assertApprox(r.avgWeight, (0.5 + 0.3 + 0.7) / 3, 0.001, 'avg weight = 0.5');
  assertApprox(r.minWeight, 0.3, 0.001, 'min weight = 0.3');
}

// ---------------------------------------------------------------------------
// 17. Delta sign correctness
// ---------------------------------------------------------------------------
group('delta sign');

{
  // Outlier above mean, down-weighted → weighted < unweighted → delta negative
  const frames = [
    makeFrame(30, [0.9, 0.9]),
    makeFrame(50, [0.9, 0.2]),  // outlier, low vis
    makeFrame(30, [0.9, 0.9]),
  ];
  const r = computeMetricWeighting(frames);
  assert(r.delta < 0, 'outlier above → delta negative (weighted pulled down)');
}

{
  // Outlier below mean, down-weighted → weighted > unweighted → delta positive
  const frames = [
    makeFrame(30, [0.9, 0.9]),
    makeFrame(10, [0.9, 0.2]),  // outlier below, low vis
    makeFrame(30, [0.9, 0.9]),
  ];
  const r = computeMetricWeighting(frames);
  assert(r.delta > 0, 'outlier below → delta positive (weighted pulled up)');
}

// ---------------------------------------------------------------------------
// 18. Large frame counts (stress test)
// ---------------------------------------------------------------------------
group('stress test — many frames');

{
  // 100 frames, all with perfect visibility
  const frames = makeUniformFrames(
    Array.from({ length: 100 }, (_, i) => 30 + Math.sin(i) * 2),
    0.95,
    4
  );
  const r = computeMetricWeighting(frames);
  assertEq(r.framesUsed, 100, '100 frames used');
  assertEq(r.framesExcluded, 0, '0 excluded');
  assert(Number.isFinite(r.weightedValue), 'finite result');
  assert(Math.abs(r.delta) < 0.5, 'small delta with uniform visibility');
}

// 100 frames, alternating high/low visibility
{
  const frames: FrameAngleData[] = Array.from({ length: 100 }, (_, i) => {
    const vis = i % 2 === 0 ? 0.9 : 0.05; // alternate included/excluded
    return makeFrame(30 + i * 0.1, [vis, 0.9, 0.9, 0.9]);
  });
  const r = computeMetricWeighting(frames);
  assertEq(r.framesUsed, 50, '50 frames used (even indices)');
  assertEq(r.framesExcluded, 50, '50 frames excluded (odd indices)');
  assert(r.applied, 'applied with 50 valid frames');
}

// ---------------------------------------------------------------------------
// 19. Consistent with unweighted when all weights equal
// ---------------------------------------------------------------------------
group('equal weights = simple mean');

{
  for (const uniformVis of [0.2, 0.5, 0.75, 0.99, 1.0]) {
    const angles = [10, 20, 30, 40, 50];
    const frames = makeUniformFrames(angles, uniformVis, 3);
    const r = computeMetricWeighting(frames);
    if (uniformVis >= MIN_VISIBILITY_THRESHOLD) {
      assertApprox(r.weightedValue, r.unweightedValue, 0.001,
        `uniform vis=${uniformVis} → weighted = unweighted`);
    }
  }
}

// ---------------------------------------------------------------------------
// 20. Integration: buildFrameAngleData → computeMetricWeighting
// ---------------------------------------------------------------------------
group('end-to-end: build → compute');

{
  const angles = [34, 36, 38, 35, 33];
  const vis = [
    make33Vis({ 11: 0.9, 12: 0.9, 23: 0.9, 24: 0.9 }),
    make33Vis({ 11: 0.9, 12: 0.9, 23: 0.9, 24: 0.3 }),
    make33Vis({ 11: 0.9, 12: 0.9, 23: 0.9, 24: 0.05 }), // excluded
    make33Vis({ 11: 0.9, 12: 0.9, 23: 0.9, 24: 0.85 }),
    make33Vis({ 11: 0.9, 12: 0.9, 23: 0.9, 24: 0.92 }),
  ];

  const frameData = buildFrameAngleData(angles, vis, 'spineAngle');
  const r = computeMetricWeighting(frameData);

  assertEq(r.framesUsed, 4, 'e2e: 4 used');
  assertEq(r.framesExcluded, 1, 'e2e: 1 excluded (L24=0.05)');
  assert(r.applied, 'e2e: applied');
  assert(Number.isFinite(r.weightedValue), 'e2e: finite result');
  // Frame 2 (angle=38, L24=0.05) excluded → weighted pulled away from 38
  assert(r.weightedValue < r.unweightedValue,
    'e2e: excluding high-angle occluded frame pulls weighted down');
}

// ===========================================================================
// Summary
// ===========================================================================

console.log('');
console.log('═══════════════════════════════════════');
console.log(`  Task 11 — visibilityWeighting tests`);
console.log(`  PASSED: ${passed}`);
console.log(`  FAILED: ${failed}`);
console.log(`  TOTAL:  ${passed + failed}`);
console.log('═══════════════════════════════════════');

if (failed > 0) {
  process.exit(1);
}
