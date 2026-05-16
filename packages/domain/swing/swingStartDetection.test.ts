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
