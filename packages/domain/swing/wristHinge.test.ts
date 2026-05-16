/**
 * wristHinge.test.ts — Tests for computeLeadWristHinge.
 *
 * Run with: npx --yes tsx packages/domain/swing/wristHinge.test.ts
 */
import type { PoseFrame, NormalizedJoint } from "../../pose/PoseTypes";
import type { DetectedPhase } from "./phaseDetection";
import {
  computeLeadWristHinge,
  MIN_HINGE_FRAMES,
  CUPPED_THRESHOLD_DEG,
  BOWED_THRESHOLD_DEG,
} from "./wristHinge";

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

function approxEq(actual: number, expected: number, tol: number, label: string): void {
  assert(
    Math.abs(actual - expected) <= tol,
    `${label} (got ${actual.toFixed(2)}, expected ${expected}±${tol})`,
  );
}

// ---------------------------------------------------------------------------
// Frame builders
// ---------------------------------------------------------------------------

type Hinge = { elbow: [number, number]; wrist: [number, number]; index: [number, number] };

function joint(name: NormalizedJoint["name"], x: number, y: number, confidence = 0.9): NormalizedJoint {
  return { name, x, y, confidence };
}

function makeFrame(timestampMs: number, hinge: Partial<Hinge> & { indexConfidence?: number } = {}): PoseFrame {
  const joints: Partial<Record<NormalizedJoint["name"], NormalizedJoint>> = {};
  if (hinge.elbow) joints.leftElbow = joint("leftElbow", hinge.elbow[0], hinge.elbow[1]);
  if (hinge.wrist) joints.leftWrist = joint("leftWrist", hinge.wrist[0], hinge.wrist[1]);
  if (hinge.index) joints.leftIndex = joint("leftIndex", hinge.index[0], hinge.index[1], hinge.indexConfidence ?? 0.9);
  return {
    timestampMs,
    joints: joints as PoseFrame["joints"],
    frameWidth: 1280,
    frameHeight: 720,
  };
}

function makePhase(phase: DetectedPhase["phase"], index: number): DetectedPhase {
  return {
    phase,
    label: phase,
    point: { x: 0, y: 0, timestamp: index, leadX: 0, leadY: 0, trailX: 0, trailY: 0 },
    index,
    timestamp: index,
    source: "heuristic",
  };
}

/**
 * Builds a 30-frame sequence where every frame has the same elbow/wrist pose
 * (so the window-average lands on the requested hinge geometry).
 * topIdx and impactIdx control where the phases point.
 *
 * topHinge applies to frames in the top window; impactHinge applies to frames
 * in the impact window. Outside both, frames just use impactHinge (irrelevant).
 */
function buildSequence(
  topIdx: number,
  impactIdx: number,
  topHinge: Hinge,
  impactHinge: Hinge,
): PoseFrame[] {
  const frames: PoseFrame[] = [];
  for (let i = 0; i < 30; i++) {
    const useTop = Math.abs(i - topIdx) <= 3;
    const hinge = useTop ? topHinge : impactHinge;
    frames.push(makeFrame(i * 33, hinge));
  }
  return frames;
}

// Geometric helpers — forearm along +x with elbow at origin keeps the math easy.
const FOREARM: Pick<Hinge, "elbow" | "wrist"> = { elbow: [0, 0], wrist: [1, 0] };
const CUPPED_HINGE: Hinge = { ...FOREARM, index: [2, 0.5] };   // ≈ +26.57°
const FLAT_HINGE: Hinge = { ...FOREARM, index: [2, 0] };       // 0°
const BOWED_HINGE: Hinge = { ...FOREARM, index: [2, -0.5] };   // ≈ −26.57°

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\n=== Wrist Hinge Module Tests ===");

group("category at impact");
{
  const frames = buildSequence(10, 20, FLAT_HINGE, CUPPED_HINGE);
  const phases = [makePhase("top", 10), makePhase("impact", 20)];
  const r = computeLeadWristHinge(frames, phases);
  assert(r !== null, "returns non-null with full visibility");
  if (r) {
    assertEq(r.category, "cupped", "cupped impact → cupped category");
    approxEq(r.hingeAtImpactDeg, 26.57, 0.5, "cupped hinge ≈ +26.57°");
  }
}
{
  const frames = buildSequence(10, 20, FLAT_HINGE, FLAT_HINGE);
  const phases = [makePhase("top", 10), makePhase("impact", 20)];
  const r = computeLeadWristHinge(frames, phases);
  assert(r !== null, "flat hinge returns result");
  if (r) {
    assertEq(r.category, "flat", "flat impact → flat category");
    approxEq(r.hingeAtImpactDeg, 0, 0.1, "flat hinge ≈ 0°");
  }
}
{
  const frames = buildSequence(10, 20, FLAT_HINGE, BOWED_HINGE);
  const phases = [makePhase("top", 10), makePhase("impact", 20)];
  const r = computeLeadWristHinge(frames, phases);
  assert(r !== null, "bowed hinge returns result");
  if (r) {
    assertEq(r.category, "bowed", "bowed impact → bowed category");
    approxEq(r.hingeAtImpactDeg, -26.57, 0.5, "bowed hinge ≈ −26.57°");
  }
}

group("sign convention and delta direction");
{
  // Top: cupped (+26.57°), Impact: bowed (−26.57°). Delta = −53.14° (wrist bows down through transition).
  const frames = buildSequence(10, 20, CUPPED_HINGE, BOWED_HINGE);
  const phases = [makePhase("top", 10), makePhase("impact", 20)];
  const r = computeLeadWristHinge(frames, phases);
  if (!r) {
    assert(false, "expected non-null result for cupped→bowed transition");
  } else {
    approxEq(r.hingeAtTopDeg, 26.57, 0.5, "hingeAtTopDeg ≈ +26.57");
    approxEq(r.hingeAtImpactDeg, -26.57, 0.5, "hingeAtImpactDeg ≈ −26.57");
    approxEq(r.deltaTransitionDeg, -53.14, 0.5, "deltaTransitionDeg ≈ −53.14");
    assert(r.deltaTransitionDeg < 0, "delta is negative when wrist bows through transition");
  }
}
{
  // Top: bowed, Impact: cupped. Delta should be positive (wrist cups through transition).
  const frames = buildSequence(10, 20, BOWED_HINGE, CUPPED_HINGE);
  const phases = [makePhase("top", 10), makePhase("impact", 20)];
  const r = computeLeadWristHinge(frames, phases);
  if (r) {
    assert(r.deltaTransitionDeg > 0, "delta is positive when wrist cups through transition");
  } else {
    assert(false, "expected non-null result");
  }
}

group("threshold constants are signed as expected");
assert(CUPPED_THRESHOLD_DEG > 0, "CUPPED_THRESHOLD_DEG positive");
assert(BOWED_THRESHOLD_DEG < 0, "BOWED_THRESHOLD_DEG negative");

group("gating: low leftIndex visibility → null");
{
  // Build sequence where leftIndex confidence in the impact window drops below MIN_CONFIDENCE
  // on enough frames that fewer than MIN_HINGE_FRAMES (=3) remain visible.
  const frames: PoseFrame[] = [];
  for (let i = 0; i < 30; i++) {
    // Impact window is [17, 23]. Mark all index joints in that window as low-confidence
    // EXCEPT frame 17 (only 1 valid frame — below MIN_HINGE_FRAMES = 3).
    const inImpactWindow = i >= 17 && i <= 23;
    const indexConf = inImpactWindow && i !== 17 ? 0.1 : 0.9;
    frames.push(makeFrame(i * 33, { ...FLAT_HINGE, indexConfidence: indexConf }));
  }
  const phases = [makePhase("top", 10), makePhase("impact", 20)];
  const r = computeLeadWristHinge(frames, phases);
  assertEq(r, null, "returns null when impact window has < MIN_HINGE_FRAMES");
}

group("gating: missing phases → null");
{
  const frames = buildSequence(10, 20, FLAT_HINGE, FLAT_HINGE);
  assertEq(computeLeadWristHinge(frames, [makePhase("top", 10)]), null, "no impact phase → null");
  assertEq(computeLeadWristHinge(frames, [makePhase("impact", 20)]), null, "no top phase → null");
  assertEq(computeLeadWristHinge(frames, []), null, "no phases → null");
}

group("MIN_HINGE_FRAMES constant");
assertEq(MIN_HINGE_FRAMES, 3, "MIN_HINGE_FRAMES = 3");

// ---------------------------------------------------------------------------

console.log(`\n${"═".repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(55)}`);
if (failed > 0) {
  process.exit(1);
}
