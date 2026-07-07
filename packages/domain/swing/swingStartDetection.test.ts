/**
 * swingStartDetection.test.ts — Tests for detectSwingStart (DTL V3).
 *
 * Run with: npx --yes tsx packages/domain/swing/swingStartDetection.test.ts
 */

import { detectSwingStart } from './swingStartDetection';
import { createEmptyJoints, type JointName, type PoseFrame } from '../../pose/PoseTypes';

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

const FRAME_DT_MS = 1000 / 120; // 120 fps capture

type Pt = { x: number; y: number };

type FrameSpec = {
  shoulderL: Pt;
  shoulderR: Pt;
  hipL: Pt;
  hipR: Pt;
  kneeL: Pt;
  ankleL: Pt;
  nose: Pt;
};

// Stable golf address pose. calculateGolfAngles → spine=14°, leftKnee=169°.
const STABLE: FrameSpec = {
  shoulderL: { x: 0.45, y: 0.30 },
  shoulderR: { x: 0.55, y: 0.30 },
  hipL: { x: 0.40, y: 0.50 },
  hipR: { x: 0.50, y: 0.50 },
  kneeL: { x: 0.42, y: 0.70 },
  ankleL: { x: 0.40, y: 0.90 },
  nose: { x: 0.50, y: 0.20 },
};

// Mid-takeaway pose. calculateGolfAngles → spine=19°, leftKnee=152°.
const MOTION: FrameSpec = {
  shoulderL: { x: 0.46, y: 0.30 },
  shoulderR: { x: 0.56, y: 0.30 },
  hipL: { x: 0.38, y: 0.50 },
  hipR: { x: 0.50, y: 0.50 },
  kneeL: { x: 0.44, y: 0.70 },
  ankleL: { x: 0.40, y: 0.90 },
  nose: { x: 0.50, y: 0.20 }, // overridden per-frame in motion sequence
};

function makeFrame(idx: number, spec: FrameSpec, noseXOverride?: number): PoseFrame {
  const joints = createEmptyJoints();
  const set = (name: JointName, p: Pt): void => {
    joints[name] = { name, x: p.x, y: p.y, confidence: 0.95 };
  };
  set('leftShoulder', spec.shoulderL);
  set('rightShoulder', spec.shoulderR);
  set('leftHip', spec.hipL);
  set('rightHip', spec.hipR);
  set('leftKnee', spec.kneeL);
  set('leftAnkle', spec.ankleL);
  set('nose', noseXOverride != null ? { x: noseXOverride, y: spec.nose.y } : spec.nose);
  return {
    timestampMs: idx * FRAME_DT_MS,
    joints,
    frameWidth: 1080,
    frameHeight: 1920,
  };
}

// ---------------------------------------------------------------------------
// T1 — DTL HIGH: stable window 21..28, transitional 29, motion 30+
// ---------------------------------------------------------------------------
group('T1. DTL HIGH path — clean stillness then takeaway');
{
  const N = 50;
  const frames: PoseFrame[] = [];
  for (let i = 0; i < N; i++) {
    if (i <= 28) {
      // Stable window (frames 0..28). All windows ending at E ∈ [7..28] pass criteria.
      frames.push(makeFrame(i, STABLE));
    } else if (i === 29) {
      // Transitional: spine/knee unchanged, but |Δ noseX|=0.008 > 0.006 so window E=29 fails head criterion.
      frames.push(makeFrame(i, STABLE, 0.508));
    } else {
      // Motion: spine=19, knee=152, nose drifting positive each frame.
      const noseX = 0.515 + (i - 30) * 0.010;
      frames.push(makeFrame(i, MOTION, noseX));
    }
  }
  // phases.top=48 → address scan starts at E = 48-20 = 28 (latest allowed E).
  const result = detectSwingStart(frames, { address: 0, top: 48 }, false, 'dtl');

  assertEq(result.trueAddressFrame, 28, 'T1: trueAddressFrame is the latest stable E');
  assertEq(result.trueSwingStartFrame, 30, 'T1: trueSwingStartFrame is first 2-of-3 motion frame');
  assertEq(result.reliability, 'HIGH', 'T1: reliability HIGH when both detected');
}

// ---------------------------------------------------------------------------
// T2 — LOW fallback: no stable window
// ---------------------------------------------------------------------------
group('T2. No stable window → LOW, preserves phases.address');
{
  const N = 50;
  const frames: PoseFrame[] = [];
  for (let i = 0; i < N; i++) {
    // Alternate stable/motion every frame: any 8-frame window has spineRange = 5 > 1.5°.
    const spec = i % 2 === 0 ? STABLE : MOTION;
    frames.push(makeFrame(i, spec, 0.50 + (i % 2) * 0.02));
  }
  const result = detectSwingStart(frames, { address: 5, top: 48 }, false, 'dtl');

  assertEq(result.trueAddressFrame, 5, 'T2: falls back to phases.address');
  assertEq(result.trueSwingStartFrame, 6, 'T2: trueSwingStartFrame = phases.address + 1');
  assertEq(result.reliability, 'LOW', 'T2: reliability LOW when no stable window');
}

// ---------------------------------------------------------------------------
// T3 — Front camera stub: returns LOW without scanning
// ---------------------------------------------------------------------------
group('T3. Front camera → LOW stub mirroring phases.address');
{
  const frames: PoseFrame[] = [];
  for (let i = 0; i < 50; i++) frames.push(makeFrame(i, STABLE));
  const result = detectSwingStart(frames, { address: 7, top: 40 }, false, 'face_on');

  assertEq(result.trueAddressFrame, 7, 'T3: trueAddressFrame mirrors phases.address');
  assertEq(result.trueSwingStartFrame, 8, 'T3: trueSwingStartFrame = phases.address + 1');
  assertEq(result.reliability, 'HIGH', 'T3: face-on returns HIGH (trusts phase-detected address)');
}

// ---------------------------------------------------------------------------
// T4 — D3 regression, low fps (~48fps → startWin=2): consistency check derived
// from the rate window. Pre-fix, the hardcoded deltas[2] read was undefined at
// startWin=2, making detection structurally unsatisfiable → always LOW.
// ---------------------------------------------------------------------------
group('T4. D3 low-fps (~48fps, startWin=2) — start detection is satisfiable');
{
  const MS_48FPS = 21; // ≈47.6fps → startWin = max(1, round(50/21)) = 2
  const N = 50;
  const frames: PoseFrame[] = [];
  for (let i = 0; i < N; i++) {
    if (i <= 28) {
      frames.push(makeFrame(i, STABLE));
    } else {
      frames.push(makeFrame(i, MOTION, 0.515 + (i - 29) * 0.010));
    }
  }
  // top=45 → eStart = 45 - round(333/21)=16 → 29 (motion) fails, E=28 is address.
  const result = detectSwingStart(frames, { address: 0, top: 45 }, false, 'dtl', MS_48FPS);

  assertEq(result.trueAddressFrame, 28, 'T4: trueAddressFrame at the last stable frame');
  assertEq(result.trueSwingStartFrame, 29, 'T4: swing start detected at first motion frame');
  assertEq(result.reliability, 'HIGH', 'T4: reliability HIGH (pre-fix this was always LOW at ≤~48fps)');
}

// ---------------------------------------------------------------------------
// T5 — D3 at 120fps (startWin=6): the FULL window must be consistent. Pre-fix
// only deltas[0..2] were checked, so 3 consistent frames followed by reversal
// slipped through; now the whole 6-frame window gates detection.
// ---------------------------------------------------------------------------
group('T5. D3 120fps (startWin=6) — full-window consistency');
{
  const MS_120FPS = 1000 / 120; // startWin = round(50/8.33) = 6
  const N = 110;

  // 5a: genuinely consistent motion → detected.
  const consistent: PoseFrame[] = [];
  for (let i = 0; i < N; i++) {
    if (i <= 59) consistent.push(makeFrame(i, STABLE));
    else consistent.push(makeFrame(i, MOTION, 0.515 + (i - 60) * 0.010));
  }
  // top=100 → eStart = 100 - round(333/8.33)=40 → 60 (motion) fails, E=59 is address.
  const r1 = detectSwingStart(consistent, { address: 0, top: 100 }, false, 'dtl', MS_120FPS);
  assertEq(r1.trueAddressFrame, 59, 'T5a: trueAddressFrame at the last stable frame');
  assertEq(r1.trueSwingStartFrame, 60, 'T5a: consistent 6-frame motion detected');
  assertEq(r1.reliability, 'HIGH', 'T5a: reliability HIGH for sustained motion');

  // 5b: only 3 consistent frames then oscillation — pre-fix (deltas[0..2] only)
  // this DETECTED at F=60; the full-window check must reject every window.
  const jittery: PoseFrame[] = [];
  for (let i = 0; i < N; i++) {
    if (i <= 59) jittery.push(makeFrame(i, STABLE));
    else if (i <= 62) jittery.push(makeFrame(i, MOTION, 0.515 + (i - 60) * 0.010));
    else jittery.push(i % 2 === 0 ? makeFrame(i, STABLE) : makeFrame(i, MOTION, 0.52));
  }
  const r2 = detectSwingStart(jittery, { address: 0, top: 100 }, false, 'dtl', MS_120FPS);
  assertEq(r2.reliability, 'LOW', 'T5b: 3-frame blip + oscillation is NOT a swing start at 120fps');
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
  console.log('✅ All swingStartDetection tests passed');
}
