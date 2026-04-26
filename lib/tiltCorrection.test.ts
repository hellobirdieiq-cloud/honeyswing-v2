/**
 * tiltCorrection.test.ts — Test suite for Task 10 (Phone Gyroscope Tilt Correction)
 *
 * Run: npx tsx lib/tiltCorrection.test.ts
 * (NOT Jest — this repo's Jest/Babel doesn't support TypeScript syntax)
 *
 * Uses custom assert/assertEq/assertApprox harness, same as Tasks 5, 7, 8.
 */

import {
  computePhoneTilt,
  correctForPhoneTilt,
  applyTiltCorrection,
  isFiniteNumber,
  MIN_TILT_DEG,
  MAX_TILT_DEG,
  MIN_GRAVITY_G,
  MAX_GRAVITY_G,
  MIN_SAMPLE_COUNT,
  MAX_PITCH_STDDEV,
  TRIM_FRACTION,
  type GravityReading,
  type PhoneTilt,
  type TiltCorrectionInput,
} from '../packages/domain/swing/tiltCorrection';

// ─── Test Harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let currentGroup = '';

function group(name: string) {
  currentGroup = name;
  console.log(`\n── ${name} ──`);
}

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL [${currentGroup}]: ${msg}`);
  }
}

function assertEq(actual: unknown, expected: unknown, msg: string) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL [${currentGroup}]: ${msg} — expected ${expected}, got ${actual}`);
  }
}

function assertApprox(actual: number, expected: number, tolerance: number, msg: string) {
  const diff = Math.abs(actual - expected);
  if (diff <= tolerance) {
    passed++;
  } else {
    failed++;
    console.error(
      `  FAIL [${currentGroup}]: ${msg} — expected ~${expected} ±${tolerance}, got ${actual} (diff=${diff.toFixed(4)})`
    );
  }
}

// ─── Gravity Helpers ─────────────────────────────────────────────────────────

/** Build gravity reading for a phone tilted forward by pitchDeg (scale=1.0 G default) */
function gravityForPitch(pitchDeg: number, scale: number = 1.0): GravityReading {
  const rad = (pitchDeg * Math.PI) / 180;
  return {
    x: 0,
    y: -scale * Math.cos(rad),
    z: scale * Math.sin(rad),
  };
}

/** Build gravity reading with both pitch and roll */
function gravityForPitchRoll(pitchDeg: number, rollDeg: number, scale: number = 1.0): GravityReading {
  const pRad = (pitchDeg * Math.PI) / 180;
  const rRad = (rollDeg * Math.PI) / 180;
  return {
    x: scale * Math.sin(rRad) * Math.cos(pRad),
    y: -scale * Math.cos(rRad) * Math.cos(pRad),
    z: scale * Math.sin(pRad),
  };
}

/** Create N identical gravity readings */
function nReadings(pitchDeg: number, count: number, scale: number = 1.0): GravityReading[] {
  return Array.from({ length: count }, () => gravityForPitch(pitchDeg, scale));
}

/** Seeded PRNG (deterministic across runs). Returns function returning 0..1 */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Add Gaussian noise to a gravity reading using provided PRNG */
function addNoise(r: GravityReading, noiseStd: number, rng: () => number): GravityReading {
  const u1 = rng(), u2 = rng(), u3 = rng();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const z1 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
  const z2 = Math.sqrt(-2 * Math.log(u3)) * Math.cos(2 * Math.PI * u2);
  return { x: r.x + z0 * noiseStd, y: r.y + z1 * noiseStd, z: r.z + z2 * noiseStd };
}

/** Create N noisy readings with deterministic RNG */
function noisyReadings(pitchDeg: number, count: number, noiseStd: number, seed: number = 42): GravityReading[] {
  const rng = seededRandom(seed);
  const base = gravityForPitch(pitchDeg);
  return Array.from({ length: count }, () => addNoise(base, noiseStd, rng));
}

/** Helper: construct PhoneTilt object */
function tilt(pitchDeg: number, opts?: Partial<PhoneTilt>): PhoneTilt {
  return {
    pitchDeg,
    rollDeg: opts?.rollDeg ?? 0,
    sampleCount: opts?.sampleCount ?? 50,
    pitchStdDev: opts?.pitchStdDev ?? 0.5,
    rejectedCount: opts?.rejectedCount ?? 0,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// ============================================================================
// isFiniteNumber helper
// ============================================================================

group('isFiniteNumber');
{
  assertEq(isFiniteNumber(5), true, '5 is finite');
  assertEq(isFiniteNumber(0), true, '0 is finite');
  assertEq(isFiniteNumber(-3.14), true, '-3.14 is finite');
  assertEq(isFiniteNumber(NaN), false, 'NaN');
  assertEq(isFiniteNumber(Infinity), false, 'Infinity');
  assertEq(isFiniteNumber(-Infinity), false, '-Infinity');
  assertEq(isFiniteNumber(null), false, 'null');
  assertEq(isFiniteNumber(undefined), false, 'undefined');
  assertEq(isFiniteNumber('5'), false, 'string');
}

// ============================================================================
// computePhoneTilt — basic pitch detection
// ============================================================================

group('computePhoneTilt — vertical phone');
{
  const t = computePhoneTilt(nReadings(0, 5));
  assert(t !== null, 'non-null');
  assertApprox(t!.pitchDeg, 0, 0.1, '0° pitch');
  assertApprox(t!.rollDeg, 0, 0.1, '0° roll');
  assertEq(t!.sampleCount, 5, 'sampleCount');
  assertEq(t!.rejectedCount, 0, 'no rejections');
}

group('computePhoneTilt — forward tilt sweep');
{
  const angles = [3, 5, 7, 10, 12, 15, 18, 20, 23, 25, 28, 29];
  for (const deg of angles) {
    const t = computePhoneTilt(nReadings(deg, 5));
    assert(t !== null, `${deg}° non-null`);
    assertApprox(t!.pitchDeg, deg, 0.5, `${deg}° detected`);
  }
}

group('computePhoneTilt — backward tilt');
{
  const t1 = computePhoneTilt(nReadings(-10, 5));
  assertApprox(t1!.pitchDeg, -10, 0.5, '-10° backward');

  const t2 = computePhoneTilt(nReadings(-20, 5));
  assertApprox(t2!.pitchDeg, -20, 0.5, '-20° backward');
}

group('computePhoneTilt — roll detection');
{
  const reading = gravityForPitchRoll(0, 10);
  const t = computePhoneTilt(Array(5).fill(reading));
  assertApprox(t!.rollDeg, 10, 1.0, '10° right roll');
  assertApprox(t!.pitchDeg, 0, 1.0, 'no pitch');
}

group('computePhoneTilt — combined pitch and roll');
{
  const reading = gravityForPitchRoll(15, 8);
  const t = computePhoneTilt(Array(5).fill(reading));
  assertApprox(t!.pitchDeg, 15, 1.5, '15° pitch with roll');
  assertApprox(t!.rollDeg, 8, 1.5, '8° roll with pitch');
}

// ============================================================================
// computePhoneTilt — scale independence (G's vs m/s²)
// ============================================================================

group('computePhoneTilt — scale independence');
{
  const tG = computePhoneTilt(nReadings(15, 10, 1.0));
  const tMS = computePhoneTilt(nReadings(15, 10, 9.81));
  assert(tG !== null && tMS !== null, 'both non-null');
  assertApprox(tG!.pitchDeg, tMS!.pitchDeg, 0.5, 'same pitch regardless of scale');
}

{
  // Scale detection uses median of first N — verify with mixed first readings
  // First reading at anomalous magnitude (3 G's), rest normal
  const anomalous: GravityReading = { x: 0, y: -3.0, z: 0 };
  const normal = nReadings(15, 9);
  // The median of first 5 magnitudes: [3.0, 1.0, 1.0, 1.0, 1.0] → median=1.0 → G scale
  const t = computePhoneTilt([anomalous, ...normal]);
  // anomalous reading gets magnitude-rejected, rest produce ~15°
  assert(t !== null, 'survives anomalous first reading');
  assertApprox(t!.pitchDeg, 15, 1.0, 'correct despite bad first sample');
}

// ============================================================================
// computePhoneTilt — averaging
// ============================================================================

group('computePhoneTilt — averaging');
{
  const readings = [...nReadings(10, 5), ...nReadings(20, 5)];
  const t = computePhoneTilt(readings);
  assert(t !== null, 'non-null');
  assertApprox(t!.pitchDeg, 15, 1.5, 'averaged ≈ 15°');
  assertEq(t!.sampleCount, 10, 'sampleCount = 10');
}

// ============================================================================
// computePhoneTilt — gravity magnitude rejection
// ============================================================================

group('computePhoneTilt — gravity magnitude rejection');
{
  // High-G reading rejected
  const highG: GravityReading = { x: 0, y: -1.5, z: 0 };
  const ok = nReadings(10, 5);
  const t = computePhoneTilt([highG, ...ok]);
  assertEq(t!.rejectedCount, 1, 'rejected 1 high-G');
  assertEq(t!.sampleCount, 5, '5 valid');
  assertApprox(t!.pitchDeg, 10, 0.5, 'pitch from valid only');
}

{
  // Low-G reading rejected
  const lowG: GravityReading = { x: 0, y: -0.5, z: 0 };
  const ok = nReadings(12, 5);
  const t = computePhoneTilt([lowG, lowG, ...ok]);
  assertEq(t!.rejectedCount, 2, 'rejected 2 low-G');
  assertEq(t!.sampleCount, 5, '5 valid');
}

{
  // ALL bad magnitude → null
  const bad: GravityReading[] = [
    { x: 0, y: -2.0, z: 0 },
    { x: 0, y: -0.3, z: 0 },
    { x: 5, y: -5, z: 5 },
  ];
  assertEq(computePhoneTilt(bad), null, 'all bad → null');
}

{
  // Exact boundaries accepted
  const exactMin: GravityReading = { x: 0, y: -MIN_GRAVITY_G, z: 0 };
  const exactMax: GravityReading = { x: 0, y: -MAX_GRAVITY_G, z: 0 };
  const ok = nReadings(10, 3);
  const t = computePhoneTilt([exactMin, exactMax, ...ok]);
  assertEq(t!.rejectedCount, 0, 'exact boundaries accepted');
}

// ============================================================================
// computePhoneTilt — minimum sample count
// ============================================================================

group('computePhoneTilt — minimum sample count');
{
  // Exactly MIN_SAMPLE_COUNT → accepted
  const t1 = computePhoneTilt(nReadings(15, MIN_SAMPLE_COUNT));
  assert(t1 !== null, `${MIN_SAMPLE_COUNT} readings → non-null`);
  assertApprox(t1!.pitchDeg, 15, 0.5, 'correct pitch');
}

{
  // Below MIN_SAMPLE_COUNT → null
  const t2 = computePhoneTilt(nReadings(15, MIN_SAMPLE_COUNT - 1));
  assertEq(t2, null, `${MIN_SAMPLE_COUNT - 1} readings → null`);
}

{
  // Many readings but most rejected → falls below MIN_SAMPLE_COUNT → null
  const badMag: GravityReading = { x: 0, y: -2.0, z: 0 };
  const ok = nReadings(15, MIN_SAMPLE_COUNT - 1);
  const t3 = computePhoneTilt([...Array(20).fill(badMag), ...ok]);
  assertEq(t3, null, 'many readings but too few valid → null');
}

// ============================================================================
// computePhoneTilt — trimmed mean
// ============================================================================

group('computePhoneTilt — trimmed mean outlier rejection');
{
  // 18 normal readings at 15°, 2 outliers (valid magnitude but extreme pitch)
  const normal = nReadings(15, 18);
  const outlierHigh = gravityForPitch(45);
  const outlierLow = gravityForPitch(-15);
  const all = [...normal, outlierHigh, outlierLow];
  const t = computePhoneTilt(all);
  assertApprox(t!.pitchDeg, 15, 2.0, 'trimmed mean resists outliers');
}

group('computePhoneTilt — trimmed mean on small arrays');
{
  // 3 readings: trimCount = floor(3 * 0.10) = 0 → no trim, full mean
  const t3 = computePhoneTilt(nReadings(10, 3));
  assertApprox(t3!.pitchDeg, 10, 0.5, '3 readings → no trim, still accurate');

  // 4 readings: trimCount = floor(4 * 0.10) = 0 → no trim
  const t4 = computePhoneTilt(nReadings(12, 4));
  assertApprox(t4!.pitchDeg, 12, 0.5, '4 readings → no trim');

  // 10 readings: trimCount = floor(10 * 0.10) = 1 → trim 1 from each end
  const t10 = computePhoneTilt(nReadings(15, 10));
  assertApprox(t10!.pitchDeg, 15, 0.5, '10 readings → trim 1 from each end');
}

// ============================================================================
// computePhoneTilt — variance tracking
// ============================================================================

group('computePhoneTilt — variance tracking');
{
  // Stable readings → low stdDev
  const stable = computePhoneTilt(nReadings(15, 20));
  assertApprox(stable!.pitchStdDev, 0, 0.1, 'stable → stdDev ≈ 0');

  // Jittery readings → high stdDev
  const jittery = computePhoneTilt([
    ...nReadings(10, 5),
    ...nReadings(20, 5),
    ...nReadings(5, 5),
    ...nReadings(25, 5),
  ]);
  assert(jittery!.pitchStdDev > 3, `jittery stdDev > 3° (got ${jittery!.pitchStdDev})`);
}

// ============================================================================
// computePhoneTilt — edge cases
// ============================================================================

group('computePhoneTilt — edge cases');
{
  assertEq(computePhoneTilt([]), null, 'empty → null');
  assertEq(computePhoneTilt(null as any), null, 'null → null');
  assertEq(computePhoneTilt(undefined as any), null, 'undefined → null');
  assertEq(computePhoneTilt([{ x: NaN, y: NaN, z: NaN }]), null, 'all NaN → null');
  assertEq(computePhoneTilt([{ x: Infinity, y: -1, z: 0 }]), null, 'Infinity → null');

  // Mix of valid, NaN, and bad-magnitude — uses only good readings
  const readings: GravityReading[] = [
    { x: NaN, y: NaN, z: NaN },
    ...nReadings(15, 4),
    { x: Infinity, y: -1, z: 0 },
    { x: 0, y: -2.0, z: 0 }, // bad magnitude
  ];
  const t = computePhoneTilt(readings);
  assert(t !== null, 'mixed garbage → still gets result');
  assertApprox(t!.pitchDeg, 15, 0.5, 'correct from valid readings');
  assertEq(t!.sampleCount, 4, '4 valid samples');
  assertEq(t!.rejectedCount, 1, '1 magnitude rejection (NaN/Inf pre-filtered)');
}

// ============================================================================
// computePhoneTilt — realistic scenario (90 noisy readings)
// ============================================================================

group('computePhoneTilt — realistic 90-sample scenario');
{
  const readings = noisyReadings(15, 90, 0.02, 42);
  const t = computePhoneTilt(readings);
  assert(t !== null, 'non-null');
  assertApprox(t!.pitchDeg, 15, 2.0, 'noisy 15° detected within 2°');
  assert(t!.sampleCount >= 80, `most survive (${t!.sampleCount}/90)`);
  assert(t!.pitchStdDev < 3, `noise reasonable (${t!.pitchStdDev}°)`);
}

// ============================================================================
// correctForPhoneTilt — no tilt / insufficient / high variance / below / above
// ============================================================================

group('correctForPhoneTilt — no tilt data');
{
  const result = correctForPhoneTilt({ spineAngle: 20, shoulderTilt: 8 }, null);
  assertEq(result.corrected.spineAngle, 20, 'spine unchanged');
  assertEq(result.corrected.shoulderTilt, 8, 'shoulder unchanged');
  assertEq(result.debug.correctionApplied, false, 'not applied');
  assertEq(result.debug.reason, 'no_tilt_data', 'reason');
  assertEq(result.debug.sampleCount, 0, 'sampleCount = 0');
}

group('correctForPhoneTilt — NaN pitch');
{
  const result = correctForPhoneTilt(
    { spineAngle: 20 },
    tilt(NaN)
  );
  assertEq(result.corrected.spineAngle, 20, 'unchanged');
  assertEq(result.debug.reason, 'no_tilt_data', 'reason');
}

group('correctForPhoneTilt — insufficient samples');
{
  const result = correctForPhoneTilt(
    { spineAngle: 20 },
    tilt(15, { sampleCount: MIN_SAMPLE_COUNT - 1 })
  );
  assertEq(result.corrected.spineAngle, 20, 'unchanged');
  assertEq(result.debug.correctionApplied, false, 'not applied');
  assertEq(result.debug.reason, 'insufficient_samples', 'reason');
}

{
  // Exactly MIN_SAMPLE_COUNT → proceeds past this guard
  const result = correctForPhoneTilt(
    { spineAngle: 20 },
    tilt(15, { sampleCount: MIN_SAMPLE_COUNT })
  );
  assertEq(result.debug.correctionApplied, true, 'exact MIN_SAMPLE_COUNT → applied');
}

group('correctForPhoneTilt — high variance');
{
  const result = correctForPhoneTilt(
    { spineAngle: 20 },
    tilt(15, { pitchStdDev: MAX_PITCH_STDDEV + 0.01 })
  );
  assertEq(result.corrected.spineAngle, 20, 'unchanged');
  assertEq(result.debug.correctionApplied, false, 'not applied');
  assertEq(result.debug.reason, 'high_variance', 'reason');
}

{
  // Exactly at MAX_PITCH_STDDEV → proceeds (guard is >)
  const result = correctForPhoneTilt(
    { spineAngle: 20 },
    tilt(15, { pitchStdDev: MAX_PITCH_STDDEV })
  );
  assertEq(result.debug.correctionApplied, true, 'exact MAX_PITCH_STDDEV → applied');
}

{
  // Very high variance → skip
  const result = correctForPhoneTilt(
    { spineAngle: 20 },
    tilt(15, { pitchStdDev: 15 })
  );
  assertEq(result.debug.reason, 'high_variance', 'very high variance → skip');
}

group('correctForPhoneTilt — below MIN threshold');
{
  const result = correctForPhoneTilt(
    { spineAngle: 20, shoulderTilt: 8 },
    tilt(1.5)
  );
  assertEq(result.corrected.spineAngle, 20, 'spine unchanged');
  assertEq(result.corrected.shoulderTilt, 8, 'shoulder unchanged');
  assertEq(result.debug.reason, 'below_min_threshold', 'reason');
}

{
  const result = correctForPhoneTilt({ spineAngle: 20 }, tilt(MIN_TILT_DEG - 0.01));
  assertEq(result.debug.correctionApplied, false, 'just below MIN');
}

group('correctForPhoneTilt — above MAX threshold');
{
  const result = correctForPhoneTilt(
    { spineAngle: 20, shoulderTilt: 8 },
    tilt(35)
  );
  assertEq(result.corrected.spineAngle, 20, 'spine unchanged');
  assertEq(result.debug.reason, 'above_max_threshold', 'reason');
}

{
  const result = correctForPhoneTilt({ spineAngle: 20 }, tilt(MAX_TILT_DEG + 0.01));
  assertEq(result.debug.correctionApplied, false, 'just above MAX');
}

{
  const result = correctForPhoneTilt({ spineAngle: 20 }, tilt(-35));
  assertEq(result.debug.correctionApplied, false, 'negative beyond MAX');
}

// ============================================================================
// correctForPhoneTilt — exact boundaries
// ============================================================================

group('correctForPhoneTilt — exact boundaries');
{
  const resMin = correctForPhoneTilt({ spineAngle: 20 }, tilt(MIN_TILT_DEG));
  assertEq(resMin.debug.correctionApplied, true, `exact MIN (${MIN_TILT_DEG}°) → applied`);
  assertApprox(resMin.corrected.spineAngle!, 20 - MIN_TILT_DEG, 0.01, 'corrected by MIN');

  const resMax = correctForPhoneTilt({ spineAngle: 50 }, tilt(MAX_TILT_DEG));
  assertEq(resMax.debug.correctionApplied, true, `exact MAX (${MAX_TILT_DEG}°) → applied`);
  assertApprox(resMax.corrected.spineAngle!, 50 - MAX_TILT_DEG, 0.01, 'corrected by MAX');
}

// ============================================================================
// correctForPhoneTilt — correction math
// ============================================================================

group('correctForPhoneTilt — spine correction');
{
  const r1 = correctForPhoneTilt({ spineAngle: 25 }, tilt(15));
  assertApprox(r1.corrected.spineAngle!, 10, 0.01, '25 - 15 = 10');
  assertEq(r1.debug.corrections.spineAngle?.before, 25, 'debug before');
  assertApprox(r1.debug.corrections.spineAngle?.after!, 10, 0.01, 'debug after');

  const r2 = correctForPhoneTilt({ spineAngle: 12 }, tilt(5));
  assertApprox(r2.corrected.spineAngle!, 7, 0.01, '12 - 5 = 7');

  // Clamp to 0
  const r3 = correctForPhoneTilt({ spineAngle: 8 }, tilt(20));
  assertEq(r3.corrected.spineAngle, 0, 'clamp when tilt > measured');

  const r4 = correctForPhoneTilt({ spineAngle: 15 }, tilt(15));
  assertEq(r4.corrected.spineAngle, 0, 'exact equal → 0');
}

group('correctForPhoneTilt — negative tilt (backward)');
{
  const result = correctForPhoneTilt({ spineAngle: 5 }, tilt(-10));
  assertEq(result.debug.correctionApplied, true, 'applied');
  assertApprox(result.corrected.spineAngle!, 15, 0.01, '5 - (-10) = 15');
}

group('correctForPhoneTilt — shoulder correction');
{
  // Can go negative
  const r1 = correctForPhoneTilt({ shoulderTilt: 12 }, tilt(15));
  assertApprox(r1.corrected.shoulderTilt!, -3, 0.01, '12 - 15 = -3 (negative OK)');

  const r2 = correctForPhoneTilt({ shoulderTilt: 20 }, tilt(10));
  assertApprox(r2.corrected.shoulderTilt!, 10, 0.01, '20 - 10 = 10');
}

group('correctForPhoneTilt — both metrics');
{
  const result = correctForPhoneTilt(
    { spineAngle: 20, shoulderTilt: 8 },
    tilt(12, { rollDeg: 3, rejectedCount: 2 })
  );
  assertApprox(result.corrected.spineAngle!, 8, 0.01, 'spine: 20 - 12');
  assertApprox(result.corrected.shoulderTilt!, -4, 0.01, 'shoulder: 8 - 12');
  assertEq(result.debug.correctionApplied, true, 'applied');
  assertEq(Object.keys(result.debug.corrections).length, 2, '2 corrections');
  assertEq(result.debug.rejectedCount, 2, 'rejectedCount passed through');
}

// ============================================================================
// correctForPhoneTilt — pass-through metrics
// ============================================================================

group('correctForPhoneTilt — pass-through metrics');
{
  const metrics: TiltCorrectionInput = {
    spineAngle: 20, shoulderTilt: 8,
    leftElbowAngle: 155, rightElbowAngle: 160,
    leftKneeAngle: 170, rightKneeAngle: 168,
    hipSpreadDelta: 45, tempo: 3.2,
  };
  const result = correctForPhoneTilt(metrics, tilt(15));
  assertEq(result.corrected.leftElbowAngle, 155, 'leftElbow');
  assertEq(result.corrected.rightElbowAngle, 160, 'rightElbow');
  assertEq(result.corrected.leftKneeAngle, 170, 'leftKnee');
  assertEq(result.corrected.rightKneeAngle, 168, 'rightKnee');
  assertEq(result.corrected.hipSpreadDelta, 45, 'hipSpreadDelta');
  assertEq(result.corrected.tempo, 3.2, 'tempo');
  assert(result.corrected.spineAngle !== 20, 'spine IS changed');
  assert(result.corrected.shoulderTilt !== 8, 'shoulder IS changed');
}

// ============================================================================
// correctForPhoneTilt — null/undefined + correctionApplied semantics
// ============================================================================

group('correctForPhoneTilt — null/undefined metrics');
{
  const result = correctForPhoneTilt(
    { spineAngle: null, shoulderTilt: undefined },
    tilt(15)
  );
  assertEq(result.corrected.spineAngle, null, 'null → null');
  assertEq(result.corrected.shoulderTilt, undefined, 'undefined → undefined');
  assertEq(result.debug.correctionApplied, false, 'no correctable metrics → false');
  assertEq(result.debug.reason, 'no_correctable_metrics', 'reason');
}

{
  // One metric valid, one null → correctionApplied = true
  const result = correctForPhoneTilt(
    { spineAngle: 20, shoulderTilt: null },
    tilt(10)
  );
  assertEq(result.debug.correctionApplied, true, 'one valid metric → true');
  assertApprox(result.corrected.spineAngle!, 10, 0.01, 'spine corrected');
  assertEq(result.corrected.shoulderTilt, null, 'null stays null');
}

// ============================================================================
// correctForPhoneTilt — immutability
// ============================================================================

group('correctForPhoneTilt — immutability');
{
  const metrics: TiltCorrectionInput = { spineAngle: 25, shoulderTilt: 10 };
  correctForPhoneTilt(metrics, tilt(15));
  assertEq(metrics.spineAngle, 25, 'original spine');
  assertEq(metrics.shoulderTilt, 10, 'original shoulder');
}

// ============================================================================
// correctForPhoneTilt — debug shape + rounding
// ============================================================================

group('correctForPhoneTilt — debug shape');
{
  const result = correctForPhoneTilt(
    { spineAngle: 20 },
    tilt(10, { rollDeg: 3, sampleCount: 42, pitchStdDev: 1.23, rejectedCount: 5 })
  );
  assertEq(result.debug.phonePitchDeg, 10, 'phonePitchDeg');
  assertEq(result.debug.phoneRollDeg, 3, 'phoneRollDeg');
  assertEq(result.debug.pitchStdDev, 1.23, 'pitchStdDev');
  assertEq(result.debug.sampleCount, 42, 'sampleCount');
  assertEq(result.debug.rejectedCount, 5, 'rejectedCount');
  assertEq(result.debug.correctionApplied, true, 'correctionApplied');
  assertEq(result.debug.reason, 'corrected', 'reason');
  assert('spineAngle' in result.debug.corrections, 'has spineAngle');
  assert(!('shoulderTilt' in result.debug.corrections), 'no shoulderTilt (not provided)');
}

group('correctForPhoneTilt — debug rounding');
{
  const result = correctForPhoneTilt(
    { spineAngle: 20.333 },
    tilt(10.456789, { rollDeg: 3.789, pitchStdDev: 1.5678 })
  );
  assertEq(result.debug.phonePitchDeg, 10.46, 'pitch rounded');
  assertEq(result.debug.phoneRollDeg, 3.79, 'roll rounded');
  assertEq(result.debug.pitchStdDev, 1.57, 'stdDev rounded');
  assertEq(result.debug.corrections.spineAngle?.before, 20.33, 'before rounded');
}

// ============================================================================
// correctForPhoneTilt — monotonicity
// ============================================================================

group('correctForPhoneTilt — monotonicity');
{
  const tilts = [3, 5, 10, 15, 20, 25, 29];
  const corrected = tilts.map((t) =>
    correctForPhoneTilt({ spineAngle: 35 }, tilt(t)).corrected.spineAngle!
  );
  for (let i = 1; i < corrected.length; i++) {
    assert(corrected[i] < corrected[i - 1],
      `${tilts[i]}° → ${corrected[i]} < ${corrected[i - 1]}`);
  }
}

// ============================================================================
// correctForPhoneTilt — guard ordering
// ============================================================================

group('correctForPhoneTilt — guard ordering (high variance beats threshold checks)');
{
  // Tilt of 5° is valid, but high variance → should skip before reaching threshold check
  const result = correctForPhoneTilt(
    { spineAngle: 20 },
    tilt(5, { pitchStdDev: MAX_PITCH_STDDEV + 1, sampleCount: 50 })
  );
  assertEq(result.debug.reason, 'high_variance', 'variance gate fires before threshold');
}

{
  // Insufficient samples beats variance check
  const result = correctForPhoneTilt(
    { spineAngle: 20 },
    tilt(5, { sampleCount: 1, pitchStdDev: MAX_PITCH_STDDEV + 1 })
  );
  assertEq(result.debug.reason, 'insufficient_samples', 'sample gate fires before variance');
}

// ============================================================================
// applyTiltCorrection — convenience end-to-end
// ============================================================================

group('applyTiltCorrection — end-to-end');
{
  const result = applyTiltCorrection({ spineAngle: 25, shoulderTilt: 10 }, nReadings(15, 30));
  assertEq(result.debug.correctionApplied, true, 'applied');
  assertApprox(result.debug.phonePitchDeg, 15, 0.5, 'detected 15°');
  assertApprox(result.corrected.spineAngle!, 10, 0.5, 'spine: 25 - 15');
  assertApprox(result.corrected.shoulderTilt!, -5, 0.5, 'shoulder: 10 - 15');
}

{
  const result = applyTiltCorrection({ spineAngle: 25 }, []);
  assertEq(result.corrected.spineAngle, 25, 'empty readings → unchanged');
  assertEq(result.debug.correctionApplied, false, 'not applied');
}

// ============================================================================
// Roundtrip validation — corrected angles match level-phone within 3°
// ============================================================================

group('Roundtrip — 15° tilt');
{
  const real = 8, phoneTilt = 15;
  const result = correctForPhoneTilt({ spineAngle: real + phoneTilt }, tilt(phoneTilt));
  assertApprox(result.corrected.spineAngle!, real, 3, `spine within 3° of ${real}°`);
}

group('Roundtrip — shoulder at 20° tilt');
{
  const real = 5, phoneTilt = 20;
  const result = correctForPhoneTilt({ shoulderTilt: real + phoneTilt }, tilt(phoneTilt));
  assertApprox(result.corrected.shoulderTilt!, real, 3, `shoulder within 3° of ${real}°`);
}

group('Roundtrip — noisy end-to-end');
{
  const realSpine = 10, phoneTilt = 12;
  const readings = noisyReadings(phoneTilt, 60, 0.02, 123);
  const result = applyTiltCorrection({ spineAngle: realSpine + phoneTilt }, readings);
  assertApprox(result.corrected.spineAngle!, realSpine, 3, `noisy roundtrip within 3°`);
}

// ============================================================================
// Multiple-tilt consistency
// ============================================================================

group('Multiple-tilt consistency');
{
  const realSpine = 12;
  const tilts = [3, 5, 8, 10, 15, 20, 25];
  for (const t of tilts) {
    const result = correctForPhoneTilt({ spineAngle: realSpine + t }, tilt(t));
    assertApprox(result.corrected.spineAngle!, realSpine, 0.01, `tilt ${t}° → ≈ ${realSpine}°`);
  }
}

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${'='.repeat(50)}`);
console.log(`Task 10 — Tilt Correction Tests`);
console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failed}`);
console.log(`TOTAL:  ${passed + failed}`);
console.log(`${'='.repeat(50)}`);

if (failed > 0) {
  process.exit(1);
}
