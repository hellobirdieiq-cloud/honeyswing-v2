/**
 * canonicalTransform.test.ts — Tests for the canonical mirror M
 * (x → 1−x + bilateral label swap). M carries no handedness policy;
 * the mirror flag is decided at the analysisPipeline call site
 * (mirrorToCanonical = !isLeftHanded — see canonicalTransform.ts docs).
 *
 * Run with: npx --yes tsx packages/domain/swing/canonicalTransform.test.ts
 */

import { toCanonicalFrame, toCanonicalSequence } from './canonicalTransform';
import { calculateGolfAngles, Z_RANGE_THRESHOLD } from './angles';
import { analyzePoseSequence } from './analysisPipeline';
import type {
  JointName,
  NormalizedJoint,
  PoseFrame,
  PoseSequence,
} from '../../pose/PoseTypes';

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

function approxEq(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------------------
// Joint fixtures (inline — no imports from other test files)
// ---------------------------------------------------------------------------

const ALL_JOINT_NAMES: JointName[] = [
  'nose',
  'leftEyeInner', 'leftEye', 'leftEyeOuter',
  'rightEyeInner', 'rightEye', 'rightEyeOuter',
  'leftEar', 'rightEar',
  'mouthLeft', 'mouthRight',
  'leftShoulder', 'rightShoulder',
  'leftElbow', 'rightElbow',
  'leftWrist', 'rightWrist',
  'leftPinky', 'rightPinky',
  'leftIndex', 'rightIndex',
  'leftThumb', 'rightThumb',
  'leftHip', 'rightHip',
  'leftKnee', 'rightKnee',
  'leftAnkle', 'rightAnkle',
  'leftHeel', 'rightHeel',
  'leftFootIndex', 'rightFootIndex',
];

/** All bilateral name pairs in canonicalTransform.ts (mirror of BILATERAL_PAIRS). */
const BILATERAL_PAIRS_LOCAL: [JointName, JointName][] = [
  ['leftEyeInner', 'rightEyeInner'],
  ['leftEye', 'rightEye'],
  ['leftEyeOuter', 'rightEyeOuter'],
  ['leftEar', 'rightEar'],
  ['mouthLeft', 'mouthRight'],
  ['leftShoulder', 'rightShoulder'],
  ['leftElbow', 'rightElbow'],
  ['leftWrist', 'rightWrist'],
  ['leftPinky', 'rightPinky'],
  ['leftIndex', 'rightIndex'],
  ['leftThumb', 'rightThumb'],
  ['leftHip', 'rightHip'],
  ['leftKnee', 'rightKnee'],
  ['leftAnkle', 'rightAnkle'],
  ['leftHeel', 'rightHeel'],
  ['leftFootIndex', 'rightFootIndex'],
];

function makeJoint(
  name: JointName,
  x: number,
  y: number,
  z: number,
  confidence = 0.95,
): NormalizedJoint {
  return { name, x, y, z, confidence };
}

function emptyJoints(): Record<JointName, NormalizedJoint | undefined> {
  const out = {} as Record<JointName, NormalizedJoint | undefined>;
  for (const n of ALL_JOINT_NAMES) out[n] = undefined;
  return out;
}

/**
 * A static RH-pose frame with all 33 joints filled.
 * x deliberately asymmetric across the body so that mirroring is observable.
 * z values are spaced to cross Z_RANGE_THRESHOLD when joints span the body.
 */
function makeRHFrame(timestampMs: number): PoseFrame {
  const joints = emptyJoints();
  joints.nose            = makeJoint('nose',            0.50, 0.10, 0.000);
  joints.leftEyeInner    = makeJoint('leftEyeInner',    0.48, 0.09, 0.001);
  joints.leftEye         = makeJoint('leftEye',         0.47, 0.09, 0.001);
  joints.leftEyeOuter    = makeJoint('leftEyeOuter',    0.46, 0.09, 0.001);
  joints.rightEyeInner   = makeJoint('rightEyeInner',   0.52, 0.09, 0.001);
  joints.rightEye        = makeJoint('rightEye',        0.53, 0.09, 0.001);
  joints.rightEyeOuter   = makeJoint('rightEyeOuter',   0.54, 0.09, 0.001);
  joints.leftEar         = makeJoint('leftEar',         0.45, 0.10, 0.010);
  joints.rightEar        = makeJoint('rightEar',        0.55, 0.10, 0.010);
  joints.mouthLeft       = makeJoint('mouthLeft',       0.48, 0.12, 0.000);
  joints.mouthRight      = makeJoint('mouthRight',      0.52, 0.12, 0.000);
  // Shoulders: trail side (right) slightly forward at address; lead (left) back.
  joints.leftShoulder    = makeJoint('leftShoulder',    0.35, 0.25, -0.020);
  joints.rightShoulder   = makeJoint('rightShoulder',   0.62, 0.27,  0.030);
  // Elbows bent toward the ball at address.
  joints.leftElbow       = makeJoint('leftElbow',       0.30, 0.40, -0.010);
  joints.rightElbow      = makeJoint('rightElbow',      0.68, 0.42,  0.020);
  // Wrists meeting at the grip.
  joints.leftWrist       = makeJoint('leftWrist',       0.45, 0.55,  0.000);
  joints.rightWrist      = makeJoint('rightWrist',      0.55, 0.56,  0.010);
  joints.leftPinky       = makeJoint('leftPinky',       0.44, 0.57,  0.005);
  joints.rightPinky      = makeJoint('rightPinky',      0.56, 0.58,  0.015);
  joints.leftIndex       = makeJoint('leftIndex',       0.45, 0.58,  0.004);
  joints.rightIndex      = makeJoint('rightIndex',      0.55, 0.59,  0.014);
  joints.leftThumb       = makeJoint('leftThumb',       0.46, 0.56,  0.003);
  joints.rightThumb      = makeJoint('rightThumb',      0.54, 0.57,  0.013);
  joints.leftHip         = makeJoint('leftHip',         0.40, 0.60, -0.005);
  joints.rightHip        = makeJoint('rightHip',        0.60, 0.61,  0.005);
  joints.leftKnee        = makeJoint('leftKnee',        0.40, 0.75, -0.003);
  joints.rightKnee       = makeJoint('rightKnee',       0.60, 0.76,  0.003);
  joints.leftAnkle       = makeJoint('leftAnkle',       0.40, 0.90, -0.001);
  joints.rightAnkle      = makeJoint('rightAnkle',      0.60, 0.91,  0.001);
  joints.leftHeel        = makeJoint('leftHeel',        0.38, 0.92, -0.001);
  joints.rightHeel       = makeJoint('rightHeel',       0.62, 0.93,  0.001);
  joints.leftFootIndex   = makeJoint('leftFootIndex',   0.42, 0.95, -0.001);
  joints.rightFootIndex  = makeJoint('rightFootIndex',  0.58, 0.96,  0.001);
  return {
    timestampMs,
    joints,
    frameWidth: 1080,
    frameHeight: 1920,
  };
}

/**
 * Manually build a mirror-image of an RH frame as if a real LH golfer were
 * captured. Same logic as toCanonicalFrame but used as ground truth here so
 * the test does not rely on the function it is verifying.
 */
function manualMirror(frame: PoseFrame): PoseFrame {
  const swapMap = new Map<JointName, JointName>();
  for (const [a, b] of BILATERAL_PAIRS_LOCAL) {
    swapMap.set(a, b);
    swapMap.set(b, a);
  }
  const mirrored = emptyJoints();
  for (const name of ALL_JOINT_NAMES) {
    const j = frame.joints[name];
    if (!j) continue;
    const target = swapMap.get(name) ?? name;
    mirrored[target] = {
      name: target,
      x: 1.0 - j.x,
      y: j.y,
      z: j.z,
      confidence: j.confidence,
    };
  }
  return {
    timestampMs: frame.timestampMs,
    joints: mirrored,
    frameWidth: frame.frameWidth,
    frameHeight: frame.frameHeight,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — Identity: toCanonicalFrame(frame, false) returns frame unchanged
// ---------------------------------------------------------------------------
console.log('\n=== canonicalTransform tests ===');
group('1. Identity (isLeftHanded=false)');
{
  const frame = makeRHFrame(0);
  const out = toCanonicalFrame(frame, false);
  assertEq(out, frame, 'T1.0: returns the same reference');
  assertEq(out.timestampMs, frame.timestampMs, 'T1.1: timestampMs unchanged');
  assertEq(out.frameWidth, frame.frameWidth, 'T1.2: frameWidth unchanged');
  assertEq(out.frameHeight, frame.frameHeight, 'T1.3: frameHeight unchanged');
  let allEqual = true;
  for (const name of ALL_JOINT_NAMES) {
    const a = frame.joints[name];
    const b = out.joints[name];
    if (a === undefined && b === undefined) continue;
    if (!a || !b) { allEqual = false; break; }
    if (a.x !== b.x || a.y !== b.y || a.z !== b.z || a.confidence !== b.confidence || a.name !== b.name) {
      allEqual = false;
      break;
    }
  }
  assert(allEqual, 'T1.4: every joint field identical to input');
}

// ---------------------------------------------------------------------------
// Test 2 — Bilateral swap: every pair swapped, x = 1 - x, y/z/confidence kept
// ---------------------------------------------------------------------------
group('2. Bilateral swap (isLeftHanded=true)');
{
  const frame = makeRHFrame(0);
  const out = toCanonicalFrame(frame, true);

  // Bilateral pairs: canonical[A] should equal mirror(original[B]) and vice versa.
  let pairsOk = true;
  for (const [a, b] of BILATERAL_PAIRS_LOCAL) {
    const origA = frame.joints[a];
    const origB = frame.joints[b];
    const outA = out.joints[a];
    const outB = out.joints[b];
    if (!origA || !origB || !outA || !outB) { pairsOk = false; break; }
    // outA should hold mirror of origB:
    if (!approxEq(outA.x, 1.0 - origB.x, 1e-12)) { pairsOk = false; break; }
    if (outA.y !== origB.y) { pairsOk = false; break; }
    if (outA.z !== origB.z) { pairsOk = false; break; }
    if (outA.confidence !== origB.confidence) { pairsOk = false; break; }
    if (outA.name !== a) { pairsOk = false; break; }
    // outB should hold mirror of origA:
    if (!approxEq(outB.x, 1.0 - origA.x, 1e-12)) { pairsOk = false; break; }
    if (outB.y !== origA.y) { pairsOk = false; break; }
    if (outB.z !== origA.z) { pairsOk = false; break; }
    if (outB.confidence !== origA.confidence) { pairsOk = false; break; }
    if (outB.name !== b) { pairsOk = false; break; }
  }
  assert(pairsOk, 'T2.0: every bilateral pair swapped, x = 1 - x, y/z/confidence preserved');

  // Non-bilateral joint (nose): name stays, x = 1 - x, y/z/confidence preserved.
  const origNose = frame.joints.nose!;
  const outNose = out.joints.nose!;
  assertEq(outNose.name, 'nose', 'T2.1: nose name unchanged (no bilateral pair)');
  assert(approxEq(outNose.x, 1.0 - origNose.x, 1e-12), 'T2.2: nose x mirrored');
  assertEq(outNose.y, origNose.y, 'T2.3: nose y preserved');
  assertEq(outNose.z, origNose.z, 'T2.4: nose z preserved');
  assertEq(outNose.confidence, origNose.confidence, 'T2.5: nose confidence preserved');

  // Confirm bilateral coverage is complete: every joint that has a pair entry
  // appears in the swap, and joints without a pair are unchanged in position
  // only (x still mirrored). Build set of paired names.
  const pairedNames = new Set<JointName>();
  for (const [a, b] of BILATERAL_PAIRS_LOCAL) {
    pairedNames.add(a);
    pairedNames.add(b);
  }
  let nonPairedOk = true;
  for (const name of ALL_JOINT_NAMES) {
    if (pairedNames.has(name)) continue;
    const orig = frame.joints[name];
    const o = out.joints[name];
    if (!orig || !o) continue;
    if (o.name !== name) { nonPairedOk = false; break; }
    if (!approxEq(o.x, 1.0 - orig.x, 1e-12)) { nonPairedOk = false; break; }
    if (o.y !== orig.y || o.z !== orig.z || o.confidence !== orig.confidence) {
      nonPairedOk = false;
      break;
    }
  }
  assert(nonPairedOk, 'T2.6: non-paired joints (nose) keep name, x mirrored, y/z/confidence preserved');
}

// ---------------------------------------------------------------------------
// Test 3 — Double-mirror idempotency
// ---------------------------------------------------------------------------
group('3. Double-mirror idempotency');
{
  const seq: PoseSequence = {
    frames: [makeRHFrame(0), makeRHFrame(33), makeRHFrame(66)],
    source: 'test',
  };
  const once = toCanonicalSequence(seq, true);
  const twice = toCanonicalSequence(once, true);

  let ok = true;
  for (let f = 0; f < seq.frames.length; f++) {
    const a = seq.frames[f];
    const b = twice.frames[f];
    if (a.timestampMs !== b.timestampMs) { ok = false; break; }
    for (const name of ALL_JOINT_NAMES) {
      const ja = a.joints[name];
      const jb = b.joints[name];
      if (ja === undefined && jb === undefined) continue;
      if (!ja || !jb) { ok = false; break; }
      if (!approxEq(ja.x, jb.x, 1e-10)) { ok = false; break; }
      if (!approxEq(ja.y, jb.y, 1e-10)) { ok = false; break; }
      if (ja.z !== undefined && jb.z !== undefined && !approxEq(ja.z, jb.z, 1e-10)) { ok = false; break; }
      if ((ja.confidence ?? 0) !== (jb.confidence ?? 0)) { ok = false; break; }
      if (ja.name !== jb.name) { ok = false; break; }
    }
    if (!ok) break;
  }
  assert(ok, 'T3.0: toCanonicalSequence twice returns input within 1e-10 tolerance');
}

// ---------------------------------------------------------------------------
// Test 4 — Z-sign: angle outputs invariant under x-mirror when z range > threshold
// ---------------------------------------------------------------------------
group('4. Z-sign behavior under x-mirror');
{
  const frame = makeRHFrame(0);
  // Sanity check: this fixture's joints span z values > Z_RANGE_THRESHOLD so
  // the 3D-aware path in angles.ts will trigger.
  const zs: number[] = [];
  for (const n of ALL_JOINT_NAMES) {
    const j = frame.joints[n];
    if (j?.z != null && Number.isFinite(j.z)) zs.push(j.z);
  }
  const zRange = Math.max(...zs) - Math.min(...zs);
  assert(zRange > Z_RANGE_THRESHOLD,
    `T4.0: synthetic frame z range (${zRange.toFixed(3)}) exceeds Z_RANGE_THRESHOLD (${Z_RANGE_THRESHOLD})`);

  const orig = calculateGolfAngles(frame);
  const mirrored = calculateGolfAngles(toCanonicalFrame(frame, true));

  // Under x-reflection + name swap: canonical leftElbow holds original rightElbow
  // data (x flipped, y/z preserved). Reflection is an isometry — the angle at the
  // mirrored elbow must equal the angle at the original right elbow.
  let match = true;
  const TOL = 0.01; // degrees

  // The pipeline's metric semantics: in canonical (RH) space, leftX = lead, rightX = trail.
  // For an LH golfer mirrored to canonical, canonical.leftElbow = original.rightElbow.
  // Therefore mirrored.leftElbowAngle should equal orig.rightElbowAngle, and vice versa.
  if (orig.leftElbowAngle == null || mirrored.rightElbowAngle == null) match = false;
  else if (!approxEq(orig.leftElbowAngle, mirrored.rightElbowAngle, TOL)) match = false;

  if (orig.rightElbowAngle == null || mirrored.leftElbowAngle == null) match = false;
  else if (!approxEq(orig.rightElbowAngle, mirrored.leftElbowAngle, TOL)) match = false;

  if (orig.leftKneeAngle == null || mirrored.rightKneeAngle == null) match = false;
  else if (!approxEq(orig.leftKneeAngle, mirrored.rightKneeAngle, TOL)) match = false;

  if (orig.rightKneeAngle == null || mirrored.leftKneeAngle == null) match = false;
  else if (!approxEq(orig.rightKneeAngle, mirrored.leftKneeAngle, TOL)) match = false;

  // Spine: midpoint-based, invariant under mirror+swap (midpoint is the same point
  // mirrored). atan2 with |dy|-based reference yields the same magnitude.
  if (orig.spineAngle == null || mirrored.spineAngle == null) match = false;
  else if (!approxEq(orig.spineAngle, mirrored.spineAngle, TOL)) match = false;

  if (match) {
    // z pass-through verified synthetic — confirm with real LH capture at clinic.
    assert(true, 'T4.1: z pass-through preserves angles under mirror within 0.01° (verified synthetic)');
  } else {
    assert(false, 'T4.1: z pass-through DOES NOT preserve angles under mirror — STOP and surface');
    console.log('         orig.leftElbowAngle  =', orig.leftElbowAngle,  '  mirrored.rightElbowAngle =', mirrored.rightElbowAngle);
    console.log('         orig.rightElbowAngle =', orig.rightElbowAngle, '  mirrored.leftElbowAngle  =', mirrored.leftElbowAngle);
    console.log('         orig.leftKneeAngle   =', orig.leftKneeAngle,   '  mirrored.rightKneeAngle  =', mirrored.rightKneeAngle);
    console.log('         orig.rightKneeAngle  =', orig.rightKneeAngle,  '  mirrored.leftKneeAngle   =', mirrored.leftKneeAngle);
    console.log('         orig.spineAngle      =', orig.spineAngle,      '  mirrored.spineAngle      =', mirrored.spineAngle);
  }
}

// ---------------------------------------------------------------------------
// Test 5 — Angle invariance: full-pipeline RH vs LH-mirrored produce same canonical angles
// ---------------------------------------------------------------------------
group('5. analyzePoseSequence angle invariance (RH vs LH-mirrored)');
{
  // Short static sequence — forces mid_frame_fallback path in analysisPipeline.
  // Phase detection requires >= 6 trail points; this gives 10 frames so trail is
  // built. shouldFallback fires on frames.length < 20, so analyzePoseSequence
  // uses calculateGolfAngles(midFrame), which is the cleanest place to assert
  // angle invariance under canonical mirror.
  const rhFrames: PoseFrame[] = [];
  for (let i = 0; i < 10; i++) rhFrames.push(makeRHFrame(i * 33));
  const lhFrames = rhFrames.map(manualMirror);

  const rhSeq: PoseSequence = { frames: rhFrames, source: 'test' };
  const lhSeq: PoseSequence = { frames: lhFrames, source: 'test' };

  const rhResult = analyzePoseSequence(rhSeq, false);
  const lhResult = analyzePoseSequence(lhSeq, true);

  const rhA = rhResult.angles;
  const lhA = lhResult.angles;

  assert(!!rhA && !!lhA, 'T5.0: both analyses produced angle outputs');

  if (rhA && lhA) {
    const TOL = 1.0; // degrees, per spec
    const checks: { key: 'spineAngle' | 'leftElbowAngle' | 'rightElbowAngle'; label: string }[] = [
      { key: 'spineAngle',      label: 'T5.1: spineAngle matches within 1°' },
      { key: 'leftElbowAngle',  label: 'T5.2: leftElbowAngle matches within 1°' },
      { key: 'rightElbowAngle', label: 'T5.3: rightElbowAngle matches within 1°' },
    ];
    for (const c of checks) {
      const a = rhA[c.key];
      const b = lhA[c.key];
      if (a == null || b == null) {
        assert(false, `${c.label} (one side null: rh=${a}, lh=${b})`);
      } else {
        assert(approxEq(a, b, TOL), `${c.label} (rh=${a}, lh=${b})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All canonicalTransform tests passed');
}
