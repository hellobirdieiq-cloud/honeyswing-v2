/**
 * syntheticClubheadPath.test.ts — Tests for computeSyntheticClubheadPath.
 *
 * Run with: npx --yes tsx packages/domain/swing/syntheticClubheadPath.test.ts
 */
import type { PoseFrame, NormalizedJoint } from "../../pose/PoseTypes";
import type { DetectedPhase } from "./phaseDetection";
import {
  computeSyntheticClubheadPath,
  MIN_PATH_FRAMES,
  K_EXTENSION,
  PATH_IN_TO_OUT_DEG,
  PATH_OUT_TO_IN_DEG,
} from "./syntheticClubheadPath";

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

function joint(name: NormalizedJoint["name"], x: number, y: number, confidence = 0.9): NormalizedJoint {
  return { name, x, y, confidence };
}

/**
 * Build a 30-frame sequence with elbow + wrist placed so that the synthetic
 * clubhead position follows the requested slope (dy/dx) across the impact
 * window.
 *
 * The clubhead lands at:
 *   clubhead.x = wrist.x + K_EXTENSION * (wrist.x − elbow.x)
 *   clubhead.y = wrist.y + K_EXTENSION * (wrist.y − elbow.y)
 *
 * To make clubhead.y a function of clubhead.x (with the requested slope), we
 * shift both elbow and wrist by (frameDelta, frameDelta * slope) per frame.
 * Both vectors then have a fixed forearm direction, so the slope of the
 * clubhead path equals slope_per_frame in y vs x.
 */
function buildSequence(impactIdx: number, slope: number, options: { wristConfidence?: (i: number) => number; elbowConfidence?: (i: number) => number } = {}): PoseFrame[] {
  const frames: PoseFrame[] = [];
  for (let i = 0; i < 30; i++) {
    // Move base position with frame index. Forearm vector is constant.
    const baseX = 0.1 * (i - impactIdx);
    const baseY = slope * baseX;
    const elbowJoint: NormalizedJoint = joint("leftElbow", baseX, baseY, options.elbowConfidence?.(i) ?? 0.9);
    const wristJoint: NormalizedJoint = joint("leftWrist", baseX + 0.05, baseY + 0.05 * slope, options.wristConfidence?.(i) ?? 0.9);
    frames.push({
      timestampMs: i * 33,
      joints: { leftElbow: elbowJoint, leftWrist: wristJoint } as PoseFrame["joints"],
      frameWidth: 1280,
      frameHeight: 720,
    });
  }
  return frames;
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

console.log("\n=== Synthetic Clubhead Path Tests ===");

group("category from slope");
{
  // Slope 0.5 → atan(0.5) ≈ 26.57° → in-to-out (well above PATH_IN_TO_OUT_DEG = 8)
  const frames = buildSequence(15, 0.5);
  const r = computeSyntheticClubheadPath(frames, [makePhase("impact", 15)]);
  assert(r !== null, "in-to-out returns result");
  if (r) {
    assertEq(r.category, "in-to-out", "positive slope → in-to-out");
    assert(r.pathAngleAtImpactDeg > PATH_IN_TO_OUT_DEG, "pathAngle exceeds threshold");
  }
}
{
  // Slope 0 → square
  const frames = buildSequence(15, 0);
  const r = computeSyntheticClubheadPath(frames, [makePhase("impact", 15)]);
  assert(r !== null, "square returns result");
  if (r) {
    assertEq(r.category, "square", "zero slope → square");
    assert(
      r.pathAngleAtImpactDeg <= PATH_IN_TO_OUT_DEG && r.pathAngleAtImpactDeg >= PATH_OUT_TO_IN_DEG,
      "pathAngle within square band",
    );
  }
}
{
  // Slope −0.5 → atan(−0.5) ≈ −26.57° → out-to-in
  const frames = buildSequence(15, -0.5);
  const r = computeSyntheticClubheadPath(frames, [makePhase("impact", 15)]);
  assert(r !== null, "out-to-in returns result");
  if (r) {
    assertEq(r.category, "out-to-in", "negative slope → out-to-in");
    assert(r.pathAngleAtImpactDeg < PATH_OUT_TO_IN_DEG, "pathAngle below threshold");
  }
}

group("samples populated and frame indices preserved");
{
  const frames = buildSequence(15, 0.5);
  const r = computeSyntheticClubheadPath(frames, [makePhase("impact", 15)]);
  if (!r) {
    assert(false, "expected non-null");
  } else {
    assert(r.samples.length >= MIN_PATH_FRAMES, "samples length ≥ MIN_PATH_FRAMES");
    assertEq(r.samples.length, r.framesUsed, "framesUsed matches samples length");
    // Frames in window [10, 20] inclusive.
    const minIdx = r.samples[0].frameIdx;
    const maxIdx = r.samples[r.samples.length - 1].frameIdx;
    assert(minIdx >= 10 && maxIdx <= 20, "samples fall inside ±5 window around impact 15");
  }
}

group("K_EXTENSION matches calibration source");
assertEq(K_EXTENSION, 4.0, "K_EXTENSION = 4.0 (scripts/clubhead-overlay-prototype.py:38)");

group("gating: too few visible frames → null");
{
  // Only frames 13, 14, 15 (3 frames) have good wrist confidence; rest fail. Below MIN_PATH_FRAMES = 5.
  const frames = buildSequence(15, 0, {
    wristConfidence: (i) => (i >= 13 && i <= 15 ? 0.9 : 0.1),
  });
  const r = computeSyntheticClubheadPath(frames, [makePhase("impact", 15)]);
  assertEq(r, null, "low visibility window → null");
}

group("gating: missing impact phase → null");
{
  const frames = buildSequence(15, 0);
  assertEq(computeSyntheticClubheadPath(frames, []), null, "no phases → null");
  assertEq(
    computeSyntheticClubheadPath(frames, [makePhase("top", 10)]),
    null,
    "no impact phase → null",
  );
}

group("MIN_PATH_FRAMES constant");
assertEq(MIN_PATH_FRAMES, 5, "MIN_PATH_FRAMES = 5");

console.log(`\n${"═".repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(55)}`);
if (failed > 0) {
  process.exit(1);
}
