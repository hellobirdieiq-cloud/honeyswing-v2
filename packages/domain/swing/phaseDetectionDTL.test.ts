/**
 * phaseDetectionDTL.test.ts — Synthetic tests for the DTL angle-specific
 * phase detector. Run with:
 *   npx --yes tsx packages/domain/swing/phaseDetectionDTL.test.ts
 *
 * Builds minimal PoseFrame + SwingTrailPoint sequences that exercise each
 * rule's success branch (and at least one fallback branch) without relying
 * on disk fixtures. End-to-end validation against the 8 real swings lives
 * in scripts/validate-phase-rules.ts.
 */

import { createEmptyJoints, type JointName, type NormalizedJoint, type PoseFrame, type PoseSequence } from "../../pose/PoseTypes";
import type { SwingTrailPoint } from "./phaseDetection";
import { detectDTLPhases } from "./phaseDetectionDTL";

let passed = 0;
let failed = 0;
function group(name: string): void { console.log(`\n── ${name} ──`); }
function assert(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}`); failed++; }
}

const FPS = 120;
const FRAME_DT_MS = 1000 / FPS;

function joint(name: JointName, x: number, y: number, z: number | undefined = 0, confidence = 0.99): NormalizedJoint {
  return { name, x, y, ...(z != null ? { z } : {}), confidence };
}

function emptyFrame(timestampMs: number): PoseFrame {
  return { timestampMs, joints: createEmptyJoints(), frameWidth: 1, frameHeight: 1 };
}

/** Build a synthetic DTL swing: still address → hip rotation → top → impact → finish. */
function buildDTLSwing(opts: {
  totalFrames: number;
  addressEnd: number;
  topFrame: number;
  impactFrame: number;
}): { sequence: PoseSequence; trail: SwingTrailPoint[] } {
  const { totalFrames, addressEnd, topFrame, impactFrame } = opts;
  const frames: PoseFrame[] = [];
  const trail: SwingTrailPoint[] = [];

  for (let i = 0; i < totalFrames; i++) {
    const f = emptyFrame(i * FRAME_DT_MS);

    // Hips: still during address, spreading + drifting after addressEnd.
    const post = Math.max(0, i - addressEnd);
    const hipSpread = 0.15 + post * 0.002;
    const hipMid = 0.5 + post * 0.0015;
    const lhx = hipMid + hipSpread / 2;
    const rhx = hipMid - hipSpread / 2;
    f.joints.leftHip = joint("leftHip", lhx, 0.6, 0, 0.99);
    f.joints.rightHip = joint("rightHip", rhx, 0.6, 0, 0.99);
    f.joints.leftKnee = joint("leftKnee", lhx, 0.78, 0, 0.99);
    f.joints.rightKnee = joint("rightKnee", rhx, 0.78, 0, 0.99);
    f.joints.leftAnkle = joint("leftAnkle", lhx, 0.95, 0, 0.99);
    f.joints.rightAnkle = joint("rightAnkle", rhx, 0.95, 0, 0.99);
    f.joints.leftShoulder = joint("leftShoulder", hipMid + 0.08, 0.35, 0, 0.99);
    f.joints.rightShoulder = joint("rightShoulder", hipMid - 0.08, 0.35, 0, 0.99);
    f.joints.nose = joint("nose", 0.5 + post * 0.0001, 0.2, 0, 0.99);

    // Wrist midpoint traces a swing-shaped arc — used by trail.
    // Address-hold: still. Backswing (addressEnd → topFrame): leadX decreases, y rises mildly.
    // Downswing (topFrame → impactFrame): leadX increases past start, y dips low at impact.
    // Follow-through: motion decelerates to near-zero.
    let leadX = 0.55;
    let leadY = 0.55;
    let trailX = 0.45;
    let trailY = 0.55;

    if (i <= addressEnd) {
      leadX = 0.55;
      leadY = 0.55;
    } else if (i <= topFrame) {
      const t = (i - addressEnd) / Math.max(1, topFrame - addressEnd);
      leadX = 0.55 - t * 0.18;
      leadY = 0.55 - t * 0.20;
      trailX = 0.45 - t * 0.16;
      trailY = 0.55 - t * 0.20;
    } else if (i <= impactFrame) {
      const t = (i - topFrame) / Math.max(1, impactFrame - topFrame);
      leadX = 0.37 + t * 0.20;
      leadY = 0.35 + t * 0.30;
      trailX = 0.29 + t * 0.20;
      trailY = 0.35 + t * 0.30;
    } else {
      const t = Math.min(1, (i - impactFrame) / 30);
      leadX = 0.57 + t * 0.02;
      leadY = 0.65 - t * 0.05;
      trailX = 0.49 + t * 0.02;
      trailY = 0.65 - t * 0.05;
    }

    f.joints.leftWrist = joint("leftWrist", leadX, leadY, 0, 0.99);
    f.joints.rightWrist = joint("rightWrist", trailX, trailY, 0, 0.99);

    frames.push(f);
    trail.push({
      x: (leadX + trailX) / 2,
      y: (leadY + trailY) / 2,
      timestamp: i * FRAME_DT_MS,
      leadX,
      leadY,
      trailX,
      trailY,
    });
  }

  return {
    sequence: { frames, source: "synthetic-dtl", metadata: { fps: FPS } },
    trail,
  };
}

// ---------------------------------------------------------------------------
// T1 — happy path: each rule returns a frame in the expected band
// ---------------------------------------------------------------------------
group("T1. Happy-path DTL swing → 5 phases detected, no fallback");
{
  const { sequence, trail } = buildDTLSwing({
    totalFrames: 180,
    addressEnd: 30,
    topFrame: 80,
    impactFrame: 110,
  });

  const result = detectDTLPhases({ canonical: sequence, trail, msPerFrame: FRAME_DT_MS });

  assert(result.fallbackGate == null, "T1: no fallback gate fired");
  assert(result.phases.length === 5, `T1: 5 phases returned (got ${result.phases.length})`);
  assert(result.ruleDebug.detector === "dtl", "T1: detector tag = dtl");

  const phaseByName = (n: string) => result.phases.find((p) => p.phase === n);
  const top = phaseByName("top");
  const impact = phaseByName("impact");
  const takeaway = phaseByName("takeaway");
  assert(top != null && top.index > 30 && top.index < 100, `T1: top within (30,100) (got ${top?.index})`);
  assert(impact != null && impact.index > (top?.index ?? 0), `T1: impact > top (got top=${top?.index}, impact=${impact?.index})`);
  assert(takeaway != null && takeaway.index < (top?.index ?? Infinity), `T1: takeaway < top (got takeaway=${takeaway?.index}, top=${top?.index})`);
}

// ---------------------------------------------------------------------------
// T2 — Phase 0 fires (swing_start surfaced in ruleDebug)
// ---------------------------------------------------------------------------
group("T2. Phase 0 fires → swing_start_frame populated");
{
  const { sequence, trail } = buildDTLSwing({
    totalFrames: 180,
    addressEnd: 30,
    topFrame: 80,
    impactFrame: 110,
  });

  const result = detectDTLPhases({ canonical: sequence, trail, msPerFrame: FRAME_DT_MS });

  assert(
    result.ruleDebug.swing_start_frame != null,
    `T2: swing_start_frame populated (got ${result.ruleDebug.swing_start_frame})`,
  );
  assert(
    result.ruleDebug.reliability.swing_start === "high" || result.ruleDebug.reliability.swing_start === "medium",
    `T2: swing_start reliability is high or medium (got ${result.ruleDebug.reliability.swing_start})`,
  );
  // swing_start should land at or just before the addressEnd boundary.
  const ss = result.ruleDebug.swing_start_frame ?? -1;
  assert(ss >= 25 && ss <= 50, `T2: swing_start within (25,50) (got ${ss})`);
}

// ---------------------------------------------------------------------------
// T3 — Phase 1 (true_address) window scan
// ---------------------------------------------------------------------------
group("T3. Phase 1 window scan returns frame in still-address region");
{
  const { sequence, trail } = buildDTLSwing({
    totalFrames: 180,
    addressEnd: 30,
    topFrame: 80,
    impactFrame: 110,
  });

  const result = detectDTLPhases({ canonical: sequence, trail, msPerFrame: FRAME_DT_MS });

  const ta = result.ruleDebug.true_address_frame;
  assert(ta != null, `T3: true_address_frame populated (got ${ta})`);
  // scanEnd = topIdx - 20 = 60, so true_address is at most 60.
  assert((ta ?? -1) <= 60, `T3: true_address ≤ top - 20 (got ${ta})`);
  assert((ta ?? -1) >= 7, `T3: true_address >= window size - 1 (got ${ta})`);
}

// ---------------------------------------------------------------------------
// T4 — Phase 0 fallback: hips never rotate → swing_start_frame = null,
// reliability = low. (Trail still moves, so top/impact still detect.)
// ---------------------------------------------------------------------------
group("T4. No hip rotation → swing_start fallback to low reliability");
{
  const { sequence, trail } = buildDTLSwing({
    totalFrames: 180,
    addressEnd: 30,
    topFrame: 80,
    impactFrame: 110,
  });
  // Zero out hip movement entirely.
  for (const f of sequence.frames) {
    f.joints.leftHip = joint("leftHip", 0.6, 0.6);
    f.joints.rightHip = joint("rightHip", 0.4, 0.6);
  }

  const result = detectDTLPhases({ canonical: sequence, trail, msPerFrame: FRAME_DT_MS });
  assert(
    result.ruleDebug.swing_start_frame == null,
    `T4: swing_start_frame null when hips static (got ${result.ruleDebug.swing_start_frame})`,
  );
  assert(
    result.ruleDebug.reliability.swing_start === "low",
    `T4: swing_start reliability=low (got ${result.ruleDebug.reliability.swing_start})`,
  );
}

// ---------------------------------------------------------------------------
// T5 — too-short input returns points_too_short
// ---------------------------------------------------------------------------
group("T5. Short capture → points_too_short fallback gate");
{
  const { sequence, trail } = buildDTLSwing({
    totalFrames: 5,
    addressEnd: 0,
    topFrame: 2,
    impactFrame: 4,
  });
  const result = detectDTLPhases({ canonical: sequence, trail, msPerFrame: FRAME_DT_MS });
  assert(result.fallbackGate === "points_too_short", `T5: got ${result.fallbackGate}`);
  assert(result.phases.length === 0, `T5: empty phases (got ${result.phases.length})`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"═".repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(55)}`);
if (failed > 0) {
  console.log("⚠️  SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("✅ All phaseDetectionDTL tests passed");
}
