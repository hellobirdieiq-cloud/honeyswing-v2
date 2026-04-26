/**
 * angleGating.test.ts — Test suite for Task 9 (Angle-Aware Tip Gating)
 *
 * Run: npx tsx lib/angleGating.test.ts
 * Runner: custom assert harness (NOT Jest), same as Tasks 5, 7, 8, 10.
 *
 * v2: Added interpolation tests, table sync, immutability, type guard,
 *     TABLE_VERSION, getBucketAccuracy, order preservation.
 */

import {
  classifyAngle,
  interpolateAccuracy,
  getBucketAccuracy,
  getThreshold,
  checkMetric,
  shouldShowMetric,
  computeAngleGating,
  filterMetricsByAngle,
  isGatedMetric,
  ACCURACY_TABLE,
  THRESHOLDS,
  BUCKET_BOUNDARIES,
  BUCKET_MIDPOINTS,
  EXEMPT_METRICS,
  ALL_GATED_METRICS,
  TABLE_VERSION,
  type AngleBucket,
  type GatedMetric,
} from '../packages/domain/swing/angleGating';

// ---------------------------------------------------------------------------
// Test Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let currentGroup = '';

function group(name: string) {
  currentGroup = name;
  console.log(`\n--- ${name} ---`);
}

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: [${currentGroup}] ${label}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string) {
  const ok = actual === expected;
  if (!ok) {
    console.error(`  FAIL: [${currentGroup}] ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
  assert(ok, label);
}

function assertApprox(actual: number, expected: number, tolerance: number, label: string) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) {
    console.error(`  FAIL: [${currentGroup}] ${label} — got ${actual}, expected ${expected} ±${tolerance}`);
  }
  assert(ok, label);
}

// ---------------------------------------------------------------------------
// Tests: TABLE_VERSION
// ---------------------------------------------------------------------------

group('TABLE_VERSION');

assertEq(typeof TABLE_VERSION, 'number', 'TABLE_VERSION is a number');
assert(TABLE_VERSION >= 1, 'TABLE_VERSION >= 1');
assert(Number.isInteger(TABLE_VERSION), 'TABLE_VERSION is an integer');

// ---------------------------------------------------------------------------
// Tests: isGatedMetric type guard
// ---------------------------------------------------------------------------

group('isGatedMetric type guard');

assertEq(isGatedMetric('spineAngle'), true, 'spineAngle is gated');
assertEq(isGatedMetric('shoulderTilt'), true, 'shoulderTilt is gated');
assertEq(isGatedMetric('hipSpreadDelta'), true, 'hipSpreadDelta is gated');
assertEq(isGatedMetric('leftElbowAngle'), true, 'leftElbowAngle is gated');
assertEq(isGatedMetric('rightElbowAngle'), true, 'rightElbowAngle is gated');
assertEq(isGatedMetric('leftKneeAngle'), true, 'leftKneeAngle is gated');
assertEq(isGatedMetric('rightKneeAngle'), true, 'rightKneeAngle is gated');
assertEq(isGatedMetric('tempo'), false, 'tempo is NOT gated');
assertEq(isGatedMetric('tempoRatio'), false, 'tempoRatio is NOT gated');
assertEq(isGatedMetric('gripQuality'), false, 'gripQuality is NOT gated');
assertEq(isGatedMetric(''), false, 'empty string is NOT gated');

// ---------------------------------------------------------------------------
// Tests: classifyAngle
// ---------------------------------------------------------------------------

group('classifyAngle — bucket boundaries');

assertEq(classifyAngle(0), 'face_on', '0° → face_on');
assertEq(classifyAngle(10), 'face_on', '10° → face_on');
assertEq(classifyAngle(19), 'face_on', '19° → face_on');
assertEq(classifyAngle(19.99), 'face_on', '19.99° → face_on');
assertEq(classifyAngle(20), 'oblique', '20° → oblique (boundary)');
assertEq(classifyAngle(35), 'oblique', '35° → oblique');
assertEq(classifyAngle(45), 'oblique', '45° → oblique');
assertEq(classifyAngle(54.99), 'oblique', '54.99° → oblique');
assertEq(classifyAngle(55), 'dtl', '55° → dtl (boundary)');
assertEq(classifyAngle(65), 'dtl', '65° → dtl');
assertEq(classifyAngle(80), 'dtl', '80° → dtl');
assertEq(classifyAngle(90), 'dtl', '90° → dtl');

group('classifyAngle — edge cases');

assertEq(classifyAngle(-10), 'face_on', 'negative → face_on (clamp)');
assertEq(classifyAngle(-0.001), 'face_on', 'tiny negative → face_on');
assertEq(classifyAngle(100), 'dtl', '>90° → dtl (clamp)');
assertEq(classifyAngle(180), 'dtl', '180° → dtl (clamp)');
assertEq(classifyAngle(NaN), 'face_on', 'NaN → face_on (safe default)');
assertEq(classifyAngle(Infinity), 'face_on', 'Infinity → face_on (not finite)');
assertEq(classifyAngle(-Infinity), 'face_on', '-Infinity → face_on (not finite)');

// ---------------------------------------------------------------------------
// Tests: interpolateAccuracy
// ---------------------------------------------------------------------------

group('interpolateAccuracy — at bucket midpoints (exact table values)');

// At midpoints, interpolation returns exact table values
assertEq(interpolateAccuracy('spineAngle', 10), 0.95, 'spineAngle@10° (face_on mid) = 0.95');
assertEq(interpolateAccuracy('spineAngle', 37.5), 0.85, 'spineAngle@37.5° (oblique mid) = 0.85');
assertEq(interpolateAccuracy('spineAngle', 72.5), 0.70, 'spineAngle@72.5° (dtl mid) = 0.70');

assertEq(interpolateAccuracy('shoulderTilt', 10), 0.90, 'shoulderTilt@10° = 0.90');
assertEq(interpolateAccuracy('shoulderTilt', 37.5), 0.75, 'shoulderTilt@37.5° = 0.75');
assertEq(interpolateAccuracy('shoulderTilt', 72.5), 0.58, 'shoulderTilt@72.5° = 0.58');

group('interpolateAccuracy — clamped regions');

// Below face_on midpoint → clamped to face_on value
assertEq(interpolateAccuracy('shoulderTilt', 0), 0.90, 'shoulderTilt@0° = 0.90 (clamped)');
assertEq(interpolateAccuracy('shoulderTilt', 5), 0.90, 'shoulderTilt@5° = 0.90 (clamped)');
assertEq(interpolateAccuracy('shoulderTilt', 10), 0.90, 'shoulderTilt@10° = 0.90 (boundary)');

// Above dtl midpoint → clamped to dtl value
assertEq(interpolateAccuracy('shoulderTilt', 72.5), 0.58, 'shoulderTilt@72.5° = 0.58 (boundary)');
assertEq(interpolateAccuracy('shoulderTilt', 80), 0.58, 'shoulderTilt@80° = 0.58 (clamped)');
assertEq(interpolateAccuracy('shoulderTilt', 90), 0.58, 'shoulderTilt@90° = 0.58 (clamped)');

group('interpolateAccuracy — smooth interpolation (no cliffs)');

// The key improvement over v1: no accuracy cliff at bucket boundaries.
// shoulderTilt at 20° (the old cliff point):
//   v1 bucket approach: 0.75 (instant drop from 0.90 at 19.99°)
//   v2 interpolation:   ~0.845 (smooth decline)
const st20 = interpolateAccuracy('shoulderTilt', 20)!;
assertApprox(st20, 0.845, 0.005, 'shoulderTilt@20° ≈ 0.845 (smooth, not 0.75 cliff)');
assert(st20 < 0.90, 'shoulderTilt@20° < face_on value');
assert(st20 > 0.75, 'shoulderTilt@20° > oblique value (interpolated between)');

// Halfway between face_on and oblique midpoints: (10 + 37.5) / 2 = 23.75°
//   shoulderTilt: lerp(0.90, 0.75, 0.5) = 0.825
const st_half_fo_ob = interpolateAccuracy('shoulderTilt', 23.75)!;
assertApprox(st_half_fo_ob, 0.825, 0.001, 'shoulderTilt@23.75° = 0.825 (midpoint of face_on↔oblique)');

// Halfway between oblique and dtl midpoints: (37.5 + 72.5) / 2 = 55°
//   shoulderTilt: lerp(0.75, 0.58, 0.5) = 0.665
const st_half_ob_dt = interpolateAccuracy('shoulderTilt', 55)!;
assertApprox(st_half_ob_dt, 0.665, 0.001, 'shoulderTilt@55° = 0.665 (midpoint of oblique↔dtl)');

group('interpolateAccuracy — monotonic decrease');

// Accuracy should decrease monotonically from 0° to 90°
for (const metric of ALL_GATED_METRICS) {
  let prev = interpolateAccuracy(metric, 0)!;
  for (let angle = 1; angle <= 90; angle++) {
    const curr = interpolateAccuracy(metric, angle)!;
    assert(curr <= prev + 0.0001, `${metric}: accuracy at ${angle}° (${curr.toFixed(4)}) <= at ${angle - 1}° (${prev.toFixed(4)})`);
    prev = curr;
  }
}

group('interpolateAccuracy — continuity (no large jumps)');

// Between consecutive degrees, accuracy should never jump more than 2%
for (const metric of ALL_GATED_METRICS) {
  for (let angle = 0; angle < 90; angle++) {
    const a1 = interpolateAccuracy(metric, angle)!;
    const a2 = interpolateAccuracy(metric, angle + 1)!;
    const jump = Math.abs(a2 - a1);
    assert(jump < 0.02, `${metric}: |acc(${angle}°) - acc(${angle + 1}°)| = ${jump.toFixed(4)} < 0.02`);
  }
}

group('interpolateAccuracy — unknown/exempt metrics');

assertEq(interpolateAccuracy('tempo', 45), null, 'tempo → null');
assertEq(interpolateAccuracy('unknownMetric', 45), null, 'unknown → null');
assertEq(interpolateAccuracy('', 45), null, 'empty string → null');

group('interpolateAccuracy — non-finite angles');

assertEq(interpolateAccuracy('spineAngle', NaN), 0.95, 'NaN → face_on value');
assertEq(interpolateAccuracy('spineAngle', Infinity), 0.95, 'Infinity → face_on value');
assertEq(interpolateAccuracy('spineAngle', -Infinity), 0.95, '-Infinity → face_on value');

// ---------------------------------------------------------------------------
// Tests: getBucketAccuracy (raw table lookup)
// ---------------------------------------------------------------------------

group('getBucketAccuracy — raw table values');

assertEq(getBucketAccuracy('spineAngle', 'face_on'), 0.95, 'spineAngle face_on = 0.95');
assertEq(getBucketAccuracy('spineAngle', 'oblique'), 0.85, 'spineAngle oblique = 0.85');
assertEq(getBucketAccuracy('spineAngle', 'dtl'), 0.70, 'spineAngle dtl = 0.70');
assertEq(getBucketAccuracy('shoulderTilt', 'face_on'), 0.90, 'shoulderTilt face_on = 0.90');
assertEq(getBucketAccuracy('shoulderTilt', 'oblique'), 0.75, 'shoulderTilt oblique = 0.75');
assertEq(getBucketAccuracy('shoulderTilt', 'dtl'), 0.58, 'shoulderTilt dtl = 0.58');
assertEq(getBucketAccuracy('tempo', 'face_on'), null, 'tempo → null');
assertEq(getBucketAccuracy('unknown', 'dtl'), null, 'unknown → null');

// ---------------------------------------------------------------------------
// Tests: getThreshold
// ---------------------------------------------------------------------------

group('getThreshold — known metrics');

assertEq(getThreshold('spineAngle'), 0.60, 'spineAngle threshold = 0.60');
assertEq(getThreshold('shoulderTilt'), 0.85, 'shoulderTilt threshold = 0.85');
assertEq(getThreshold('hipSpreadDelta'), 0.60, 'hipSpreadDelta threshold = 0.60');
assertEq(getThreshold('leftElbowAngle'), 0.70, 'leftElbow threshold = 0.70');
assertEq(getThreshold('rightElbowAngle'), 0.70, 'rightElbow threshold = 0.70');
assertEq(getThreshold('leftKneeAngle'), 0.70, 'leftKnee threshold = 0.70');
assertEq(getThreshold('rightKneeAngle'), 0.70, 'rightKnee threshold = 0.70');

group('getThreshold — unknown/exempt');

assertEq(getThreshold('tempo'), null, 'tempo → null');
assertEq(getThreshold('whatever'), null, 'unknown → null');
assertEq(getThreshold(''), null, 'empty → null');

// ---------------------------------------------------------------------------
// Tests: checkMetric
// ---------------------------------------------------------------------------

group('checkMetric — suppression with interpolated accuracy');

// shoulderTilt from deep DTL (72.5°+): accuracy = 0.58 (clamped) < 0.85 → suppressed
const stDTL = checkMetric('shoulderTilt', 75)!;
assert(stDTL !== null, 'shoulderTilt@75° returns result');
assertEq(stDTL.suppressed, true, 'shoulderTilt@75° suppressed');
assertApprox(stDTL.accuracy, 0.58, 0.001, 'shoulderTilt@75° accuracy ≈ 0.58 (clamped dtl)');
assertEq(stDTL.threshold, 0.85, 'shoulderTilt@75° threshold = 0.85');
assertEq(stDTL.bucket, 'dtl', 'shoulderTilt@75° bucket = dtl');

// shoulderTilt from oblique (45°): interpolated accuracy < 0.85 → suppressed
const stObl = checkMetric('shoulderTilt', 45)!;
assert(stObl !== null, 'shoulderTilt@45° returns result');
assertEq(stObl.suppressed, true, 'shoulderTilt@45° suppressed');
assert(stObl.accuracy < 0.85, 'shoulderTilt@45° accuracy below threshold');
assert(stObl.accuracy > 0.58, 'shoulderTilt@45° accuracy above dtl floor');

// shoulderTilt from face-on center (10°): accuracy = 0.90 >= 0.85 → NOT suppressed
const stFace = checkMetric('shoulderTilt', 10)!;
assert(stFace !== null, 'shoulderTilt@10° returns result');
assertEq(stFace.suppressed, false, 'shoulderTilt@10° NOT suppressed');
assertEq(stFace.accuracy, 0.90, 'shoulderTilt@10° accuracy = 0.90');

// spineAngle from DTL: interpolated accuracy well above 0.60 → NOT suppressed
const spDTL = checkMetric('spineAngle', 75)!;
assertEq(spDTL.suppressed, false, 'spineAngle@75° NOT suppressed');
assert(spDTL.accuracy >= 0.60, 'spineAngle@75° accuracy above threshold');

// hipSpreadDelta from deep DTL: clamped accuracy = 0.65 >= 0.60 → NOT suppressed
const hipDTL = checkMetric('hipSpreadDelta', 80)!;
assertEq(hipDTL.suppressed, false, 'hipSpreadDelta@80° NOT suppressed');

// leftElbowAngle from DTL: clamped accuracy = 0.80 >= 0.70 → NOT suppressed
const leDTL = checkMetric('leftElbowAngle', 80)!;
assertEq(leDTL.suppressed, false, 'leftElbow@80° NOT suppressed');

// leftKneeAngle from DTL: clamped accuracy = 0.75 >= 0.70 → NOT suppressed
const lkDTL = checkMetric('leftKneeAngle', 80)!;
assertEq(lkDTL.suppressed, false, 'leftKnee@80° NOT suppressed');

group('checkMetric — exempt metrics return null');

assertEq(checkMetric('tempo', 65), null, 'tempo → null (exempt)');
assertEq(checkMetric('tempoRatio', 10), null, 'tempoRatio → null (exempt)');
assertEq(checkMetric('backswingTime', 45), null, 'backswingTime → null (exempt)');
assertEq(checkMetric('downswingTime', 80), null, 'downswingTime → null (exempt)');

group('checkMetric — unknown metrics return null');

assertEq(checkMetric('gripQuality', 30), null, 'gripQuality → null (unknown)');
assertEq(checkMetric('swingPlane', 65), null, 'swingPlane → null (unknown)');
assertEq(checkMetric('', 45), null, 'empty string → null');

group('checkMetric — NaN angle');

const stNaN = checkMetric('shoulderTilt', NaN)!;
assert(stNaN !== null, 'shoulderTilt@NaN returns result');
assertEq(stNaN.bucket, 'face_on', 'shoulderTilt@NaN → face_on (safe)');
assertEq(stNaN.suppressed, false, 'shoulderTilt@NaN NOT suppressed (uses face_on accuracy)');

// ---------------------------------------------------------------------------
// Tests: shouldShowMetric
// ---------------------------------------------------------------------------

group('shouldShowMetric — convenience API');

assertEq(shouldShowMetric('shoulderTilt', 75), false, 'shoulderTilt@75° → false (DTL)');
assertEq(shouldShowMetric('shoulderTilt', 45), false, 'shoulderTilt@45° → false (oblique)');
assertEq(shouldShowMetric('shoulderTilt', 10), true, 'shoulderTilt@10° → true (face_on center)');
assertEq(shouldShowMetric('shoulderTilt', 5), true, 'shoulderTilt@5° → true (face_on clamped)');
assertEq(shouldShowMetric('spineAngle', 80), true, 'spineAngle@80° → true');
assertEq(shouldShowMetric('tempo', 80), true, 'tempo@80° → true (exempt)');
assertEq(shouldShowMetric('unknownMetric', 65), true, 'unknown@65° → true (not gated)');

// ---------------------------------------------------------------------------
// Tests: computeAngleGating — full swing result
// ---------------------------------------------------------------------------

group('computeAngleGating — DTL swing (75°)');

const dtlResult = computeAngleGating(75);
assertEq(dtlResult.tableVersion, TABLE_VERSION, 'DTL: tableVersion present');
assertEq(dtlResult.cameraAngleDeg, 75, 'DTL: cameraAngleDeg = 75');
assertEq(dtlResult.bucket, 'dtl', 'DTL: bucket = dtl');
assert(dtlResult.suppressed.includes('shoulderTilt'), 'DTL: shoulderTilt suppressed');
assertEq(dtlResult.suppressed.length, 1, 'DTL: only shoulderTilt suppressed');
assertEq(dtlResult.passed.length, 6, 'DTL: 6 metrics passed');
assert(dtlResult.passed.includes('spineAngle'), 'DTL: spineAngle passed');
assert(dtlResult.passed.includes('hipSpreadDelta'), 'DTL: hipSpreadDelta passed');
assert(dtlResult.passed.includes('leftElbowAngle'), 'DTL: leftElbow passed');
assert(dtlResult.passed.includes('rightElbowAngle'), 'DTL: rightElbow passed');
assert(dtlResult.passed.includes('leftKneeAngle'), 'DTL: leftKnee passed');
assert(dtlResult.passed.includes('rightKneeAngle'), 'DTL: rightKnee passed');

// Check details
assert('shoulderTilt' in dtlResult.details, 'DTL: shoulderTilt in details');
assertEq(dtlResult.details['shoulderTilt'].suppressed, true, 'DTL detail: shoulderTilt suppressed');
assertEq(dtlResult.details['spineAngle'].suppressed, false, 'DTL detail: spineAngle not suppressed');

group('computeAngleGating — face-on swing (5°)');

const faceResult = computeAngleGating(5);
assertEq(faceResult.bucket, 'face_on', 'face-on: bucket = face_on');
assertEq(faceResult.suppressed.length, 0, 'face-on: nothing suppressed');
assertEq(faceResult.passed.length, 7, 'face-on: all 7 metrics pass');

group('computeAngleGating — oblique swing (45°)');

const oblResult = computeAngleGating(45);
assertEq(oblResult.bucket, 'oblique', 'oblique: bucket = oblique');
assert(oblResult.suppressed.includes('shoulderTilt'), 'oblique: shoulderTilt suppressed');
assertEq(oblResult.suppressed.length, 1, 'oblique: only shoulderTilt suppressed');
assertEq(oblResult.passed.length, 6, 'oblique: 6 metrics pass');

group('computeAngleGating — with custom metric subset');

const customResult = computeAngleGating(75, ['spineAngle', 'shoulderTilt', 'tempo']);
assertEq(customResult.suppressed.length, 1, 'custom: 1 suppressed');
assert(customResult.suppressed.includes('shoulderTilt'), 'custom: shoulderTilt suppressed');
assert(customResult.passed.includes('tempo'), 'custom: tempo passed (exempt)');
assert(customResult.passed.includes('spineAngle'), 'custom: spineAngle passed');
assert(!('tempo' in customResult.details), 'custom: tempo NOT in details (exempt)');
assertEq(customResult.tableVersion, TABLE_VERSION, 'custom: tableVersion present');

group('computeAngleGating — NaN angle (safe default)');

const nanResult = computeAngleGating(NaN);
assertEq(nanResult.bucket, 'face_on', 'NaN: defaults to face_on');
assertEq(nanResult.suppressed.length, 0, 'NaN: nothing suppressed');

group('computeAngleGating — extreme angles');

const zeroResult = computeAngleGating(0);
assertEq(zeroResult.suppressed.length, 0, '0°: nothing suppressed');

const ninetyResult = computeAngleGating(90);
assertEq(ninetyResult.suppressed.length, 1, '90°: 1 suppressed');
assert(ninetyResult.suppressed.includes('shoulderTilt'), '90°: shoulderTilt suppressed');

group('computeAngleGating — empty metric list');

const emptyResult = computeAngleGating(45, []);
assertEq(emptyResult.suppressed.length, 0, 'empty input: 0 suppressed');
assertEq(emptyResult.passed.length, 0, 'empty input: 0 passed');
assertEq(Object.keys(emptyResult.details).length, 0, 'empty input: 0 details');

// ---------------------------------------------------------------------------
// Tests: filterMetricsByAngle
// ---------------------------------------------------------------------------

group('filterMetricsByAngle');

const allMetrics = ['spineAngle', 'shoulderTilt', 'hipSpreadDelta', 'tempo', 'leftElbowAngle'];

const filteredDTL = filterMetricsByAngle(allMetrics, 75);
assert(!filteredDTL.includes('shoulderTilt'), 'DTL filter: shoulderTilt removed');
assert(filteredDTL.includes('spineAngle'), 'DTL filter: spineAngle kept');
assert(filteredDTL.includes('tempo'), 'DTL filter: tempo kept (exempt)');
assert(filteredDTL.includes('hipSpreadDelta'), 'DTL filter: hipSpreadDelta kept');
assertEq(filteredDTL.length, 4, 'DTL filter: 4 metrics remain');

const filteredFace = filterMetricsByAngle(allMetrics, 5);
assertEq(filteredFace.length, 5, 'face-on filter: all 5 metrics remain');

const filteredEmpty = filterMetricsByAngle([], 75);
assertEq(filteredEmpty.length, 0, 'empty input → empty output');

group('filterMetricsByAngle — order preservation');

const orderedInput = ['leftKneeAngle', 'tempo', 'spineAngle', 'shoulderTilt', 'hipSpreadDelta'];
const orderedOutput = filterMetricsByAngle(orderedInput, 75);
// shoulderTilt removed, rest should preserve order
assertEq(orderedOutput[0], 'leftKneeAngle', 'order preserved: index 0');
assertEq(orderedOutput[1], 'tempo', 'order preserved: index 1');
assertEq(orderedOutput[2], 'spineAngle', 'order preserved: index 2');
assertEq(orderedOutput[3], 'hipSpreadDelta', 'order preserved: index 3');
assertEq(orderedOutput.length, 4, 'order preserved: length correct');

group('filterMetricsByAngle — does not mutate input');

const inputCopy = [...allMetrics];
filterMetricsByAngle(allMetrics, 75);
assertEq(allMetrics.length, inputCopy.length, 'input array length unchanged');
for (let i = 0; i < inputCopy.length; i++) {
  assertEq(allMetrics[i], inputCopy[i], `input[${i}] unchanged`);
}

// ---------------------------------------------------------------------------
// Tests: Table sync — ALL_GATED_METRICS ↔ ACCURACY_TABLE ↔ THRESHOLDS
// ---------------------------------------------------------------------------

group('Table sync — ALL_GATED_METRICS matches ACCURACY_TABLE keys');

const tableKeys = Object.keys(ACCURACY_TABLE).sort();
const allGatedSorted = [...ALL_GATED_METRICS].sort();
assertEq(tableKeys.length, allGatedSorted.length, 'same count');
for (let i = 0; i < tableKeys.length; i++) {
  assertEq(tableKeys[i], allGatedSorted[i], `key ${i}: ${tableKeys[i]} matches`);
}

group('Table sync — ACCURACY_TABLE keys match THRESHOLDS keys');

const threshKeys = Object.keys(THRESHOLDS).sort();
assertEq(tableKeys.length, threshKeys.length, 'same count');
for (let i = 0; i < tableKeys.length; i++) {
  assertEq(tableKeys[i], threshKeys[i], `key ${i}: ${tableKeys[i]} matches`);
}

group('Table sync — every metric in ACCURACY_TABLE has all 3 buckets');

const buckets: AngleBucket[] = ['face_on', 'oblique', 'dtl'];
for (const metric of ALL_GATED_METRICS) {
  for (const bucket of buckets) {
    const acc = getBucketAccuracy(metric, bucket);
    assert(acc !== null, `${metric}.${bucket} exists`);
    assert(typeof acc === 'number', `${metric}.${bucket} is a number`);
    assert(acc! >= 0 && acc! <= 1, `${metric}.${bucket} in [0,1]: ${acc}`);
  }
}

group('Table sync — every THRESHOLD is in [0, 1]');

for (const metric of ALL_GATED_METRICS) {
  const t = getThreshold(metric)!;
  assert(t >= 0 && t <= 1, `${metric} threshold in [0,1]: ${t}`);
}

// ---------------------------------------------------------------------------
// Tests: Accuracy table physics sanity
// ---------------------------------------------------------------------------

group('Accuracy: face_on >= oblique >= dtl (physics: accuracy degrades with angle)');

for (const metric of ALL_GATED_METRICS) {
  const fo = getBucketAccuracy(metric, 'face_on')!;
  const ob = getBucketAccuracy(metric, 'oblique')!;
  const dt = getBucketAccuracy(metric, 'dtl')!;
  assert(fo >= ob, `${metric}: face_on (${fo}) >= oblique (${ob})`);
  assert(ob >= dt, `${metric}: oblique (${ob}) >= dtl (${dt})`);
}

group('Accuracy: thresholds are reachable (face_on accuracy >= threshold)');

// Every metric should be showable from face-on
for (const metric of ALL_GATED_METRICS) {
  const fo = getBucketAccuracy(metric, 'face_on')!;
  const th = getThreshold(metric)!;
  assert(fo >= th, `${metric}: face_on (${fo}) >= threshold (${th})`);
}

group('Accuracy: shoulder tilt has highest threshold (most dangerous false tip)');

const stThreshold = getThreshold('shoulderTilt')!;
for (const metric of ALL_GATED_METRICS) {
  const th = getThreshold(metric)!;
  assert(stThreshold >= th, `shoulderTilt threshold (${stThreshold}) >= ${metric} threshold (${th})`);
}

// ---------------------------------------------------------------------------
// Tests: Immutability — frozen tables
// ---------------------------------------------------------------------------

group('Immutability — tables are frozen');

assert(Object.isFrozen(ACCURACY_TABLE), 'ACCURACY_TABLE is frozen');
assert(Object.isFrozen(THRESHOLDS), 'THRESHOLDS is frozen');
assert(Object.isFrozen(BUCKET_BOUNDARIES), 'BUCKET_BOUNDARIES is frozen');
assert(Object.isFrozen(BUCKET_MIDPOINTS), 'BUCKET_MIDPOINTS is frozen');
assert(Object.isFrozen(ALL_GATED_METRICS), 'ALL_GATED_METRICS is frozen');

// Inner objects of ACCURACY_TABLE should also be frozen
for (const metric of ALL_GATED_METRICS) {
  assert(Object.isFrozen(ACCURACY_TABLE[metric]), `ACCURACY_TABLE.${metric} is frozen`);
}

// Mutation attempts should silently fail (strict mode throws, sloppy ignores)
try {
  (THRESHOLDS as any)['spineAngle'] = 0.99;
} catch (_) { /* expected in strict mode */ }
assertEq(getThreshold('spineAngle'), 0.60, 'THRESHOLDS mutation had no effect');

// ---------------------------------------------------------------------------
// Tests: Validation scenarios from handoff doc
// ---------------------------------------------------------------------------

group('Validation: DTL swings (55-90°) suppress shoulder tilt');

for (const angle of [55, 60, 65, 70, 75, 80, 85, 90]) {
  assertEq(shouldShowMetric('shoulderTilt', angle), false,
    `shoulderTilt@${angle}° suppressed`);
}

group('Validation: Face-on swings (0-19°) show ALL metrics');

// With interpolation, face_on accuracy degrades smoothly.
// At 19°, shoulderTilt accuracy ≈ 0.851 (just above 0.85 threshold).
for (const metric of ALL_GATED_METRICS) {
  assertEq(shouldShowMetric(metric, 0), true, `${metric}@0° shown`);
  assertEq(shouldShowMetric(metric, 5), true, `${metric}@5° shown`);
  assertEq(shouldShowMetric(metric, 10), true, `${metric}@10° shown`);
  assertEq(shouldShowMetric(metric, 19), true, `${metric}@19° shown`);
}

group('Validation: 45° swings suppress shoulderTilt, show everything else');

for (const metric of ALL_GATED_METRICS) {
  if (metric === 'shoulderTilt') {
    assertEq(shouldShowMetric(metric, 45), false, `${metric}@45° suppressed`);
  } else {
    assertEq(shouldShowMetric(metric, 45), true, `${metric}@45° shown`);
  }
}

// ---------------------------------------------------------------------------
// Tests: Interpolation suppression boundary for shoulderTilt
// ---------------------------------------------------------------------------

group('shoulderTilt suppression boundary (interpolation)');

// With interpolation, shoulderTilt threshold crossing is smooth:
//   accuracy = lerp(0.90, 0.75, (angle - 10) / 27.5)
//   Set accuracy = 0.85 → (angle - 10) / 27.5 = 1/3 → angle ≈ 19.17°
// So at 19° it's just above 0.85, at 20° it's just below.
assertEq(shouldShowMetric('shoulderTilt', 19), true, 'shoulderTilt@19° shown (just above threshold)');
assertEq(shouldShowMetric('shoulderTilt', 20), false, 'shoulderTilt@20° suppressed (just below threshold)');

// Verify the exact accuracy values near the boundary
const acc19 = interpolateAccuracy('shoulderTilt', 19)!;
const acc20 = interpolateAccuracy('shoulderTilt', 20)!;
assert(acc19 >= 0.85, `shoulderTilt@19° accuracy (${acc19.toFixed(4)}) >= 0.85`);
assert(acc20 < 0.85, `shoulderTilt@20° accuracy (${acc20.toFixed(4)}) < 0.85`);

// The gap between them should be small (smooth transition, not a cliff)
const gap = acc19 - acc20;
assert(gap < 0.01, `gap between 19° and 20° is ${gap.toFixed(4)} (< 0.01, smooth)`);

// ---------------------------------------------------------------------------
// Tests: Angle sweep — spineAngle never suppressed
// ---------------------------------------------------------------------------

group('Angle sweep: spineAngle never suppressed (0-90° every degree)');

for (let angle = 0; angle <= 90; angle++) {
  assertEq(shouldShowMetric('spineAngle', angle), true,
    `spineAngle@${angle}° → shown`);
}

// ---------------------------------------------------------------------------
// Tests: Angle sweep — all metrics at every 10°
// ---------------------------------------------------------------------------

group('Angle sweep: all metrics at 10° increments');

const expectedSuppressions: Record<number, string[]> = {
  0:  [],
  10: [],
  20: ['shoulderTilt'],
  30: ['shoulderTilt'],
  40: ['shoulderTilt'],
  50: ['shoulderTilt'],
  60: ['shoulderTilt'],
  70: ['shoulderTilt'],
  80: ['shoulderTilt'],
  90: ['shoulderTilt'],
};

for (const [angleStr, expected] of Object.entries(expectedSuppressions)) {
  const angle = Number(angleStr);
  const result = computeAngleGating(angle);
  assertEq(result.suppressed.length, expected.length,
    `@${angle}°: ${expected.length} suppressed`);
  for (const metric of expected) {
    assert(result.suppressed.includes(metric),
      `@${angle}°: ${metric} suppressed`);
  }
}

// ---------------------------------------------------------------------------
// Tests: Constants sanity
// ---------------------------------------------------------------------------

group('Constants sanity');

assertEq(BUCKET_BOUNDARIES.FACE_ON_MAX, 20, 'FACE_ON_MAX = 20');
assertEq(BUCKET_BOUNDARIES.OBLIQUE_MAX, 55, 'OBLIQUE_MAX = 55');
assertEq(BUCKET_MIDPOINTS.face_on, 10, 'face_on midpoint = 10');
assertEq(BUCKET_MIDPOINTS.oblique, 37.5, 'oblique midpoint = 37.5');
assertEq(BUCKET_MIDPOINTS.dtl, 72.5, 'dtl midpoint = 72.5');
assertEq(ALL_GATED_METRICS.length, 7, '7 gated metrics');
assert(EXEMPT_METRICS.has('tempo'), 'tempo is exempt');
assert(EXEMPT_METRICS.has('tempoRatio'), 'tempoRatio is exempt');
assert(EXEMPT_METRICS.has('backswingTime'), 'backswingTime is exempt');
assert(EXEMPT_METRICS.has('downswingTime'), 'downswingTime is exempt');
assert(!EXEMPT_METRICS.has('spineAngle'), 'spineAngle is NOT exempt');

// Midpoints are within their respective bucket ranges
assert(BUCKET_MIDPOINTS.face_on < BUCKET_BOUNDARIES.FACE_ON_MAX,
  'face_on midpoint is within face_on bucket');
assert(BUCKET_MIDPOINTS.oblique >= BUCKET_BOUNDARIES.FACE_ON_MAX &&
       BUCKET_MIDPOINTS.oblique < BUCKET_BOUNDARIES.OBLIQUE_MAX,
  'oblique midpoint is within oblique bucket');
assert(BUCKET_MIDPOINTS.dtl >= BUCKET_BOUNDARIES.OBLIQUE_MAX,
  'dtl midpoint is within dtl bucket');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n========================================`);
console.log(`  Task 9 — Angle Gating Tests (v2)`);
console.log(`  Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
}
