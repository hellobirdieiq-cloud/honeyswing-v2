/**
 * lowerBodyIdentity.test.ts — Synthetic tests for the Layer-0 identity pass.
 * Run with:
 *   npx --yes tsx packages/domain/swing/lowerBodyIdentity.test.ts
 *
 * Covers: clean pass-through, single/sustained swap correction, whole-unit
 * relabeling (hip+heel+foot move with knee+ankle), collapse abstain-and-hold,
 * weak-vote hysteresis, lead-in backfill + low_confidence_baseline flag,
 * mirrored s0=+1 fixture (lefty-by-construction — corpus is all righty),
 * idempotency, purity, and null-baseline no-op.
 * End-to-end validation against real swings lives in scripts/identity-validate.ts.
 */

import {
  createEmptyJoints,
  type JointName,
  type PoseFrame,
} from "../../pose/PoseTypes";
import {
  correctLowerBodyIdentity,
  countIdentityCrossings,
  toIdentityDebug,
} from "./lowerBodyIdentity";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function group(name: string): void { console.log(`\n── ${name} ──`); }
function assert(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}`); failed++; }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Righty-like layout (s0 = −1): left side at high x. */
const NORMAL_X: Partial<Record<JointName, number>> = {
  leftHip: 0.55, rightHip: 0.45,
  leftKnee: 0.6, rightKnee: 0.4,
  leftAnkle: 0.62, rightAnkle: 0.38,
  leftHeel: 0.63, rightHeel: 0.37,
  leftFootIndex: 0.65, rightFootIndex: 0.35,
  leftWrist: 0.7, rightWrist: 0.3, // upper body — must never move
};

/** NORMAL_X with every lower-body pair's values exchanged. */
const SWAPPED_X: Partial<Record<JointName, number>> = {
  leftHip: 0.45, rightHip: 0.55,
  leftKnee: 0.4, rightKnee: 0.6,
  leftAnkle: 0.38, rightAnkle: 0.62,
  leftHeel: 0.37, rightHeel: 0.63,
  leftFootIndex: 0.35, rightFootIndex: 0.65,
  leftWrist: 0.7, rightWrist: 0.3,
};

/** One-leg collapse: separation 0.007 < VOTE_SEPARATION_MIN → abstain. */
const COLLAPSED_X: Partial<Record<JointName, number>> = {
  leftHip: 0.46, rightHip: 0.45,
  leftKnee: 0.405, rightKnee: 0.4,
  leftAnkle: 0.402, rightAnkle: 0.4,
  leftHeel: 0.4, rightHeel: 0.4,
  leftFootIndex: 0.4, rightFootIndex: 0.4,
  leftWrist: 0.7, rightWrist: 0.3,
};

/** Weak OPPOSING vote: sum +0.025 — valid at 0.02 tier, below 0.04 decision tier. */
const WEAK_OPPOSING_X: Partial<Record<JointName, number>> = {
  leftHip: 0.45, rightHip: 0.46,
  leftKnee: 0.4, rightKnee: 0.415,
  leftAnkle: 0.4, rightAnkle: 0.41,
  leftHeel: 0.4, rightHeel: 0.41,
  leftFootIndex: 0.4, rightFootIndex: 0.41,
  leftWrist: 0.7, rightWrist: 0.3,
};

/** Mirrored layout (lefty-like / opposite camera, s0 = +1). */
const MIRRORED_NORMAL_X: Partial<Record<JointName, number>> = {
  leftHip: 0.45, rightHip: 0.55,
  leftKnee: 0.4, rightKnee: 0.6,
  leftAnkle: 0.38, rightAnkle: 0.62,
  leftHeel: 0.37, rightHeel: 0.63,
  leftFootIndex: 0.35, rightFootIndex: 0.65,
  leftWrist: 0.3, rightWrist: 0.7,
};
const MIRRORED_SWAPPED_X: Partial<Record<JointName, number>> = {
  leftHip: 0.55, rightHip: 0.45,
  leftKnee: 0.6, rightKnee: 0.4,
  leftAnkle: 0.62, rightAnkle: 0.38,
  leftHeel: 0.63, rightHeel: 0.37,
  leftFootIndex: 0.65, rightFootIndex: 0.35,
  leftWrist: 0.3, rightWrist: 0.7,
};

function makeFrame(i: number, xs: Partial<Record<JointName, number>>, conf = 0.8): PoseFrame {
  const joints = createEmptyJoints();
  for (const [name, x] of Object.entries(xs) as [JointName, number][]) {
    joints[name] = { name, x, y: 0.5, confidence: conf };
  }
  return { timestampMs: i * 16.7, joints, frameWidth: 1920, frameHeight: 1080 };
}

function makeStream(layouts: Partial<Record<JointName, number>>[]): PoseFrame[] {
  return layouts.map((xs, i) => makeFrame(i, xs));
}

function repeat<T>(item: T, n: number): T[] {
  return Array.from({ length: n }, () => item);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

group("#1 clean stream — pass-through");
{
  const frames = makeStream(repeat(NORMAL_X, 30));
  const r = correctLowerBodyIdentity(frames);
  assert(r.swappedFrames.length === 0, "no frames swapped");
  assert(r.baselineSign === -1, "baselineSign = -1");
  assert(deepEqual(r.baselineMargin, { tally: -15, votes: 15 }), "margin {tally:-15, votes:15}");
  assert(r.lowConfidenceBaseline === false, "lowConfidenceBaseline false");
  assert(r.frames.every((f, i) => f === frames[i]), "unswapped frames passed by reference");
}

group("#2 single-frame swap — whole-unit correction");
{
  const layouts = [...repeat(NORMAL_X, 20), SWAPPED_X, ...repeat(NORMAL_X, 9)];
  const frames = makeStream(layouts);
  const r = correctLowerBodyIdentity(frames);
  assert(deepEqual(r.swappedFrames, [20]), "swappedFrames = [20]");
  const f20 = r.frames[20];
  assert(f20.joints.leftKnee?.x === 0.6 && f20.joints.rightKnee?.x === 0.4, "knees restored");
  assert(f20.joints.leftAnkle?.x === 0.62 && f20.joints.rightAnkle?.x === 0.38, "ankles restored");
  assert(f20.joints.leftHip?.x === 0.55 && f20.joints.rightHip?.x === 0.45, "hips relabeled with unit");
  assert(f20.joints.leftHeel?.x === 0.63 && f20.joints.leftFootIndex?.x === 0.65, "heel+foot relabeled with unit");
  assert(f20.joints.leftKnee?.name === "leftKnee" && f20.joints.rightKnee?.name === "rightKnee", "name fields rewritten");
  assert(f20.joints.leftWrist?.x === 0.7 && f20.joints.rightWrist?.x === 0.3, "upper body untouched");
}

group("#3 sustained swap run — corrected stream has zero crossings");
{
  const layouts = [...repeat(NORMAL_X, 20), ...repeat(SWAPPED_X, 10), ...repeat(NORMAL_X, 10)];
  const frames = makeStream(layouts);
  const r = correctLowerBodyIdentity(frames);
  assert(deepEqual(r.swappedFrames, [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]), "f20-29 swapped");
  assert(countIdentityCrossings(frames, -1) === 10, "raw crossings = 10");
  assert(countIdentityCrossings(r.frames, -1) === 0, "corrected crossings = 0");
}

group("#4 collapse inside a swap run — abstain holds the swap decision");
{
  const layouts = [
    ...repeat(NORMAL_X, 10),
    ...repeat(SWAPPED_X, 5),    // f10-14
    ...repeat(COLLAPSED_X, 2),  // f15-16 abstain → hold swap
    ...repeat(SWAPPED_X, 3),    // f17-19
    ...repeat(NORMAL_X, 10),
  ];
  const r = correctLowerBodyIdentity(makeStream(layouts));
  assert(deepEqual(r.swappedFrames, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]), "f10-19 swapped incl. held collapse f15-16");
}

group("#5 collapse outside a swap run — abstain holds normal, frames untouched");
{
  const layouts = [...repeat(NORMAL_X, 10), ...repeat(COLLAPSED_X, 5), ...repeat(NORMAL_X, 10)];
  const frames = makeStream(layouts);
  const r = correctLowerBodyIdentity(frames);
  assert(r.swappedFrames.length === 0, "no frames swapped");
  assert(r.frames[12] === frames[12], "collapse frames passed by reference");
}

group("#6 weak opposing vote — below decision tier, never flips state");
{
  const layouts = [...repeat(NORMAL_X, 10), WEAK_OPPOSING_X, ...repeat(NORMAL_X, 9)];
  const frames = makeStream(layouts);
  const r = correctLowerBodyIdentity(frames);
  assert(r.swappedFrames.length === 0, "weak vote at f10 did not swap");
  assert(r.frames[10] === frames[10], "weak frame passed by reference");
}

group("#7 lead-in backfill + low_confidence_baseline");
{
  // f0-4 collapsed (abstain), f5-9 swapped, f10-24 normal.
  // Baseline window = first 15 valid votes = 5×(+1) + 10×(−1) → tally −5/15:
  // s0=−1 still correct, but weak majority → flag. First decision-grade vote
  // (f5) is a swap → backfill f0-4 with the swap decision.
  const layouts = [...repeat(COLLAPSED_X, 5), ...repeat(SWAPPED_X, 5), ...repeat(NORMAL_X, 15)];
  const r = correctLowerBodyIdentity(makeStream(layouts));
  assert(r.baselineSign === -1, "s0 = -1 survives weak majority");
  assert(deepEqual(r.baselineMargin, { tally: -5, votes: 15 }), "margin {tally:-5, votes:15}");
  assert(r.lowConfidenceBaseline === true, "low_confidence_baseline fires below 0.5");
  assert(deepEqual(r.swappedFrames, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), "lead-in f0-4 backfilled with first decision");
  const debug = toIdentityDebug(r);
  assert(debug.low_confidence_baseline === true, "debug payload carries low_confidence_baseline");
}

group("#8 mirrored fixture (s0 = +1) — lefty/opposite-camera by construction");
{
  const layouts = [...repeat(MIRRORED_NORMAL_X, 20), ...repeat(MIRRORED_SWAPPED_X, 5), ...repeat(MIRRORED_NORMAL_X, 5)];
  const frames = makeStream(layouts);
  const r = correctLowerBodyIdentity(frames);
  assert(r.baselineSign === 1, "baselineSign = +1");
  assert(deepEqual(r.swappedFrames, [20, 21, 22, 23, 24]), "mirrored swap run corrected");
  assert(countIdentityCrossings(r.frames, 1) === 0, "corrected crossings = 0");
}

group("#9 idempotency — second application is a no-op");
{
  const layouts = [
    ...repeat(NORMAL_X, 10),
    ...repeat(SWAPPED_X, 5),
    ...repeat(COLLAPSED_X, 2),
    ...repeat(SWAPPED_X, 3),
    ...repeat(NORMAL_X, 10),
  ];
  const once = correctLowerBodyIdentity(makeStream(layouts));
  const twice = correctLowerBodyIdentity(once.frames);
  assert(twice.swappedFrames.length === 0, "second pass swaps nothing");
  assert(deepEqual(once.frames, twice.frames), "second pass output deep-equals first");
}

group("#10 purity + null baseline");
{
  const frames = makeStream([...repeat(NORMAL_X, 5), ...repeat(SWAPPED_X, 5)]);
  const snapshot = JSON.stringify(frames);
  correctLowerBodyIdentity(frames);
  assert(JSON.stringify(frames) === snapshot, "input frames never mutated");

  const allCollapsed = makeStream(repeat(COLLAPSED_X, 20));
  const r = correctLowerBodyIdentity(allCollapsed);
  assert(r.baselineSign === null, "all-abstain stream → baselineSign null");
  assert(r.swappedFrames.length === 0 && r.frames.every((f, i) => f === allCollapsed[i]), "null baseline → untouched");
}

group("#11 D5 — marginal baseline stays idempotent under re-application");
{
  // Per-pair (right − left) delta on the vote pairs (knee + ankle): sum = 2d,
  // separation = 2|d|.  d = ±0.05 → strong (sep 0.10); d = +0.015 → weak
  // (sep 0.03, valid at VOTE_SEPARATION_MIN 0.02 but below DECISION 0.04).
  const layoutD = (d: number): Partial<Record<JointName, number>> => ({
    leftHip: 0.46, rightHip: 0.46 + d,
    leftKnee: 0.45, rightKnee: 0.45 + d,
    leftAnkle: 0.45, rightAnkle: 0.45 + d,
    leftHeel: 0.44, rightHeel: 0.44 + d,
    leftFootIndex: 0.43, rightFootIndex: 0.43 + d,
    leftWrist: 0.3, rightWrist: 0.7,
  });
  const S_PLUS = layoutD(+0.05);   // strong +1
  const S_MINUS = layoutD(-0.05);  // strong −1
  const W_PLUS = layoutD(+0.015);  // weak +1 (counts at 0.02, abstains at 0.04)

  // f0 strong+1 · f1–5 strong−1 · f6–13 weak+1 (swept into the swap run) ·
  // f14 strong+1.  At the WEAK tally (pre-fix computeBaseline): +5/15 → s0=+1,
  // low_confidence; the correction swaps f1–13, whose weak votes then negate,
  // so re-tallying weak gives −1 → the baseline FLIPS and f(f(x)) ≠ f(x).
  // At DECISION grade (the fix) only the 7 strong votes count: tally −3 →
  // s0=−1 stably, the correction swaps just {0,14}, and re-application swaps
  // nothing.  Pre-fix this fixture returned baselineSign 1→−1, swapped
  // {1..13}→{0..14}, idempotent=false; the assertions below are the post-fix
  // contract.
  const marginal = makeStream([
    S_PLUS,
    S_MINUS, S_MINUS, S_MINUS, S_MINUS, S_MINUS,
    W_PLUS, W_PLUS, W_PLUS, W_PLUS, W_PLUS, W_PLUS, W_PLUS, W_PLUS,
    S_PLUS,
  ]);

  const once = correctLowerBodyIdentity(marginal);
  const twice = correctLowerBodyIdentity(once.frames);

  assert(once.lowConfidenceBaseline === true, "marginal path exercised (low_confidence_baseline)");
  assert(once.baselineSign === -1, "baseline tallied at decision grade → s0 = -1 (stable, not the weak +1)");
  assert(deepEqual(once.swappedFrames, [0, 14]), "first pass swaps only the two decision-grade contradictions {0,14}");
  assert(twice.swappedFrames.length === 0, "second pass swaps nothing (pre-fix swapped all 15)");
  assert(twice.baselineSign === once.baselineSign, "baseline sign does not flip on re-application (pre-fix flipped +1→-1)");
  assert(deepEqual(once.frames, twice.frames), "f(f(x)) === f(x) on the marginal baseline");
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
