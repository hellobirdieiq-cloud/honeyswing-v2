/**
 * keypointVeto.test.ts — Synthetic tests for the Layer-1 velocity-veto pass.
 * Run with:
 *   npx --yes tsx packages/domain/swing/keypointVeto.test.ts
 *
 * Covers acceptance tests #3 (gap-scaling recovery) and #4 (robust init).
 * End-to-end validation against the two real swings lives in
 * scripts/veto-validate.ts (acceptance #1, #2).
 */

import {
  createEmptyJoints,
  type NormalizedJoint,
  type PoseFrame,
} from "../../pose/PoseTypes";
import {
  classifyKeypointStates,
  vetoAndInterpolateKeypoints,
  PER_JOINT_THRESHOLD,
} from "./keypointVeto";

let passed = 0;
let failed = 0;
function group(name: string): void { console.log(`\n── ${name} ──`); }
function assert(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}`); failed++; }
}

const WRIST_T = PER_JOINT_THRESHOLD.leftWrist; // 0.15

/** Build a frame sequence where only leftWrist is populated (per index). null = dropout. */
function buildFrames(leftWristXs: Array<number | null>, y = 0.5): PoseFrame[] {
  return leftWristXs.map((x, i) => {
    const joints = createEmptyJoints();
    if (x !== null) {
      const j: NormalizedJoint = { name: "leftWrist", x, y, confidence: 0.95 };
      joints.leftWrist = j;
    }
    return { timestampMs: i * 16.6, joints, frameWidth: 1, frameHeight: 1 };
  });
}

// ---------------------------------------------------------------------------
// Test #3 — gap-scaling recovery
// ---------------------------------------------------------------------------
// Address (stationary) → real drift (0.08/frame) → 2-frame teleport → recovery
// that lands back on the true path. The recovery frame sits 0.24 from the last
// good position across a 3-frame gap: > the 0.15 single-frame threshold (would
// be falsely flagged) but < 3×0.15 = 0.45 (accepted thanks to gap-scaling).
group("#3 gap-scaling recovery");
{
  const xs: Array<number | null> = [];
  // frames 0..9: stationary address at x=0.30 (median seed -> 0.30)
  for (let i = 0; i < 10; i++) xs.push(0.3);
  // frames 10..14: legit drift +0.08/frame -> 0.38,0.46,0.54,0.62,0.70
  for (let i = 1; i <= 5; i++) xs.push(0.3 + 0.08 * i);
  const lastGoodX = xs[14] as number; // 0.70 at frame 14
  // frame 15 (k): teleport far off
  xs.push(lastGoodX + 0.5); // 1.20
  // frame 16 (k+1): teleport far off
  xs.push(lastGoodX + 0.55); // 1.25
  // frame 17 (k+2): recovery onto the true path (x = 0.70 + 0.08*3 = 0.94)
  xs.push(lastGoodX + 0.24); // 0.94
  // a few more on-path frames so the run is cleanly bounded
  for (let i = 4; i <= 6; i++) xs.push(lastGoodX + 0.08 * i);

  const frames = buildFrames(xs);
  const states = classifyKeypointStates(frames).leftWrist;

  const dRecovery = Math.abs((xs[17] as number) - lastGoodX);
  assert(dRecovery > WRIST_T, `recovery distance ${dRecovery.toFixed(3)} exceeds single-frame threshold ${WRIST_T}`);
  assert(dRecovery < WRIST_T * 3, `recovery distance ${dRecovery.toFixed(3)} within 3× threshold ${(WRIST_T * 3).toFixed(2)} (gap-scaled allowance)`);
  assert(states[15] === "TELEPORT", `frame 15 (k) = TELEPORT (got ${states[15]})`);
  assert(states[16] === "TELEPORT", `frame 16 (k+1) = TELEPORT (got ${states[16]})`);
  assert(states[17] === "GOOD", `frame 17 (k+2) recovery = GOOD, not falsely flagged (got ${states[17]})`);

  // The len-2 flagged run [15,16] is bounded by GOOD frames -> interpolated, not untrusted.
  const { cleanedFrames, untrustedMap } = vetoAndInterpolateKeypoints(frames);
  assert(untrustedMap.stats.interpolated >= 2, `>=2 joint-frames interpolated (got ${untrustedMap.stats.interpolated})`);
  assert((untrustedMap.byJoint.leftWrist ?? []).length === 0, "leftWrist has no untrusted frames (run was len-2)");
  // Interpolated frame 15 lands between frame14 (0.70) and frame17 (0.94) -> ~0.78
  const cx15 = cleanedFrames[15].joints.leftWrist?.x ?? NaN;
  assert(cx15 > 0.7 && cx15 < 0.94, `frame 15 interpolated onto the path (x=${cx15.toFixed(3)}), teleport removed`);
}

// ---------------------------------------------------------------------------
// Test #4 — robust init (bad frame 0 does not poison the baseline)
// ---------------------------------------------------------------------------
// frames 1..10 stationary at p=0.40; frame 0 is off at 0.80. The median over the
// first 10 frames is 0.40 (lone bad frame 0 rejected), so frame 0 is TELEPORT and
// frame 1 is GOOD. Frame 0 is an edge run with no preceding GOOD frame -> left
// UNTRUSTED with its position UNCHANGED (not interpolated).
group("#4 robust init");
{
  const P = 0.4;
  const BAD0 = 0.8;
  const xs: Array<number | null> = [BAD0];
  for (let i = 1; i <= 10; i++) xs.push(P);

  const frames = buildFrames(xs);
  const states = classifyKeypointStates(frames).leftWrist;

  // If the median had been poisoned by frame 0 (seed≈0.80), frame 0 would be GOOD
  // and frame 1 TELEPORT — asserting the opposite proves the median rejected it.
  assert(states[0] === "TELEPORT", `frame 0 (off) = TELEPORT (got ${states[0]})`);
  assert(states[1] === "GOOD", `frame 1 = GOOD — baseline not poisoned by frame 0 (got ${states[1]})`);

  const { cleanedFrames, untrustedMap } = vetoAndInterpolateKeypoints(frames);
  const x0 = cleanedFrames[0].joints.leftWrist?.x ?? NaN;
  assert(x0 === BAD0, `frame 0 position UNCHANGED at ${BAD0} (edge run untrusted, not interpolated) — got ${x0}`);
  assert((untrustedMap.byJoint.leftWrist ?? []).includes(0), "frame 0 marked untrusted in byJoint.leftWrist");
  assert(untrustedMap.stats.untrusted >= 1, `>=1 untrusted joint-frame (got ${untrustedMap.stats.untrusted})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
