/**
 * confidenceScore.test.ts — SCR-0b-0 getMetricConfidence shape + default tests
 *
 * Run: npx tsx packages/domain/swing/confidenceScore.test.ts
 * NOT Jest. Custom assert harness matching lib/visibilityWeighting.test.ts.
 *
 * Coverage (getMetricConfidence only):
 *   (a) full data — both signals present, both values returned
 *   (b) visibility = null → visibilityConfidence defaults to 1
 *   (c) visibility.metrics[metric] absent → visibilityConfidence defaults to 1
 *   (d) cameraWeights[metric] undefined → SKIPPED (type forbids; see note below)
 *   (e) hipSpreadDelta key — function executes normally (HC2 unaffected)
 *
 * No assertions on aggregation / multiplication / combination math (HC4).
 */

import { getMetricConfidence } from './confidenceScore';
import type { GatedMetricKey, VisibilityWeightingResult } from './visibilityWeighting';
import type { MetricConfidenceWeights } from './cameraAngle';

// ---------------------------------------------------------------------------
// Test harness (matches lib/visibilityWeighting.test.ts:44-68)
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

// ---------------------------------------------------------------------------
// Fixtures (shape copied from cameraAngle.ts:5-14 + visibilityWeighting.ts:119-146)
// ---------------------------------------------------------------------------

function makeCameraWeights(overrides: Partial<MetricConfidenceWeights> = {}): MetricConfidenceWeights {
  return {
    spineAngle: 1,
    leftElbowAngle: 1,
    rightElbowAngle: 1,
    leftKneeAngle: 1,
    rightKneeAngle: 1,
    hipSpreadDelta: 1,
    shoulderTilt: 1,
    tempo: 1,
    ...overrides,
  };
}

function makeVisibility(
  metricsOverrides: Record<string, { avgWeight: number }> = {},
): VisibilityWeightingResult {
  const metrics: Record<string, {
    weightedValue: number;
    unweightedValue: number;
    delta: number;
    framesUsed: number;
    framesExcluded: number;
    avgWeight: number;
    minWeight: number;
    applied: boolean;
  }> = {};
  for (const [key, val] of Object.entries(metricsOverrides)) {
    metrics[key] = {
      weightedValue: 30,
      unweightedValue: 30,
      delta: 0,
      framesUsed: 5,
      framesExcluded: 0,
      avgWeight: val.avgWeight,
      minWeight: val.avgWeight,
      applied: true,
    };
  }
  return {
    applied: Object.keys(metrics).length > 0,
    version: 'test',
    metrics,
  };
}

// ===========================================================================
// TESTS — getMetricConfidence
// ===========================================================================

// ---------------------------------------------------------------------------
// (a) Full data — both signals present, returns both values verbatim
// ---------------------------------------------------------------------------
group('(a) full data');

{
  const metric: GatedMetricKey = 'spineAngle';
  const cameraWeights = makeCameraWeights({ spineAngle: 0.8 });
  const visibility = makeVisibility({ spineAngle: { avgWeight: 0.6 } });

  const r = getMetricConfidence(metric, cameraWeights, visibility);

  assertEq(r.visibilityConfidence, 0.6, '(a) visibilityConfidence = 0.6 from avgWeight');
  assertEq(r.cameraConfidence, 0.8, '(a) cameraConfidence = 0.8 from cameraWeights');
  // Shape integrity: exactly two keys, both numbers
  assertEq(Object.keys(r).length, 2, '(a) result has exactly 2 keys');
  assertEq(typeof r.visibilityConfidence, 'number', '(a) visibilityConfidence is number');
  assertEq(typeof r.cameraConfidence, 'number', '(a) cameraConfidence is number');
}

// ---------------------------------------------------------------------------
// (b) visibility = null → visibilityConfidence defaults to 1
// ---------------------------------------------------------------------------
group('(b) visibility null');

{
  const metric: GatedMetricKey = 'spineAngle';
  const cameraWeights = makeCameraWeights({ spineAngle: 0.8 });

  const r = getMetricConfidence(metric, cameraWeights, null);

  assertEq(r.visibilityConfidence, 1, '(b) null visibility → visibilityConfidence defaults to 1');
  assertEq(r.cameraConfidence, 0.8, '(b) cameraConfidence still read from cameraWeights');
}

// ---------------------------------------------------------------------------
// (c) visibility.metrics[metric] absent → visibilityConfidence defaults to 1
// ---------------------------------------------------------------------------
group('(c) metric absent from visibility.metrics');

{
  const metric: GatedMetricKey = 'leftElbowAngle';
  const cameraWeights = makeCameraWeights({ leftElbowAngle: 0.5 });
  // visibility result with empty metrics map — leftElbowAngle key is absent
  const visibility = makeVisibility({});

  const r = getMetricConfidence(metric, cameraWeights, visibility);

  assertEq(r.visibilityConfidence, 1, '(c) absent metric key → visibilityConfidence defaults to 1');
  assertEq(r.cameraConfidence, 0.5, '(c) cameraConfidence still read');
}

// Sub-case: visibility present but for a DIFFERENT metric → still defaults
{
  const metric: GatedMetricKey = 'leftElbowAngle';
  const cameraWeights = makeCameraWeights({ leftElbowAngle: 0.5 });
  // visibility populated for spineAngle, NOT leftElbowAngle
  const visibility = makeVisibility({ spineAngle: { avgWeight: 0.7 } });

  const r = getMetricConfidence(metric, cameraWeights, visibility);

  assertEq(r.visibilityConfidence, 1,
    '(c) other-metric data does not leak — defaults to 1 for queried metric');
  assertEq(r.cameraConfidence, 0.5, '(c) cameraConfidence still 0.5');
}

// ---------------------------------------------------------------------------
// (d) cameraWeights[metric] undefined — SKIPPED
//
// MetricConfidenceWeights (cameraAngle.ts:5-14) declares all 8 fields as
// required `number` — the type forbids undefined values. Reaching the
// `?? 1` branch on cameraConfidence requires bypassing the type system
// (`as any`), which the spec explicitly forbids. The defensive fallback
// in confidenceScore.ts:319 remains as a runtime guard but is unreachable
// from any type-correct caller.
// ---------------------------------------------------------------------------
group('(d) cameraWeights undefined — skipped (type forbids)');
// No assertions; this group is documentation-only.

// ---------------------------------------------------------------------------
// (e) hipSpreadDelta key — function executes normally
//   Confirms HC2: getMetricConfidence accepts hipSpreadDelta even though
//   ANGLE_METRIC_KEYS at scoring.ts:6-9 does NOT iterate it. The exposure
//   surface and the scoring-iteration set are independent.
// ---------------------------------------------------------------------------
group('(e) hipSpreadDelta executes normally');

{
  const metric: GatedMetricKey = 'hipSpreadDelta';
  const cameraWeights = makeCameraWeights({ hipSpreadDelta: 0.2 });
  const visibility = makeVisibility({ hipSpreadDelta: { avgWeight: 0.55 } });

  const r = getMetricConfidence(metric, cameraWeights, visibility);

  // Shape unchanged
  assertEq(Object.keys(r).length, 2, '(e) hipSpreadDelta result has 2 keys');
  assert('visibilityConfidence' in r, '(e) visibilityConfidence key present');
  assert('cameraConfidence' in r, '(e) cameraConfidence key present');
  // Values pass through verbatim — function does not special-case hipSpreadDelta
  assertEq(r.visibilityConfidence, 0.55, '(e) hipSpreadDelta visibilityConfidence = 0.55');
  assertEq(r.cameraConfidence, 0.2, '(e) hipSpreadDelta cameraConfidence = 0.2');
}

// hipSpreadDelta with null visibility — defaults still apply
{
  const metric: GatedMetricKey = 'hipSpreadDelta';
  const cameraWeights = makeCameraWeights({ hipSpreadDelta: 0.2 });

  const r = getMetricConfidence(metric, cameraWeights, null);

  assertEq(r.visibilityConfidence, 1, '(e) hipSpreadDelta + null → visibility defaults to 1');
  assertEq(r.cameraConfidence, 0.2, '(e) hipSpreadDelta cameraConfidence preserved');
}

// ===========================================================================
// Summary
// ===========================================================================

console.log('');
console.log('═══════════════════════════════════════');
console.log(`  SCR-0b-0 — getMetricConfidence tests`);
console.log(`  PASSED: ${passed}`);
console.log(`  FAILED: ${failed}`);
console.log(`  TOTAL:  ${passed + failed}`);
console.log('═══════════════════════════════════════');

if (failed > 0) {
  process.exit(1);
}
