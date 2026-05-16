/**
 * wristHinge.ts — Lead-wrist hinge read at top and impact.
 *
 * Computes a signed 2D angle for the lead arm (leftElbow → leftWrist → leftIndex,
 * which is always the LEAD arm post-canonicalTransform). Positive = cupped (hand
 * extended back of forearm line), negative = bowed (hand flexed forward of line),
 * 0 ≈ flat.
 *
 * Output bucket (cupped / flat / bowed) at impact is a face-angle proxy. The
 * delta from top → impact characterizes the transition. Thresholds are
 * PLACEHOLDERS pending corpus calibration via scripts/replayWristHinge.ts.
 */
import type { PoseFrame, NormalizedJoint } from "../../pose/PoseTypes";
import type { DetectedPhase } from "./phaseDetection";

export type WristHingeCategory = "cupped" | "flat" | "bowed";

export type LeadWristHinge = {
  hingeAtTopDeg: number;
  hingeAtImpactDeg: number;
  deltaTransitionDeg: number;
  category: WristHingeCategory;
  framesUsedTop: number;
  framesUsedImpact: number;
  confidence: number;
};

// Minimum frames in either window with leftElbow + leftWrist + leftIndex all visible.
export const MIN_HINGE_FRAMES = 3;

// Half-window radius around top / impact (full window = 2*RADIUS + 1).
const WINDOW_RADIUS = 3;

const MIN_CONFIDENCE = 0.5;

// PLACEHOLDER: calibrate from corpus replay; see scripts/replayWristHinge.ts
export const CUPPED_THRESHOLD_DEG = 15;
// PLACEHOLDER: calibrate from corpus replay; see scripts/replayWristHinge.ts
export const BOWED_THRESHOLD_DEG = -10;

// Lead-wrist hinge is anatomically bounded — anything past this is a tracking
// artifact (e.g. leftIndex jumping to a non-hand pixel), not a real hinge.
const MAX_PLAUSIBLE_HINGE_DEG = 60;

function isGood(j: NormalizedJoint | undefined): j is NormalizedJoint {
  return j != null && (j.confidence ?? 0) >= MIN_CONFIDENCE;
}

/**
 * Count frames in [start, end] where leftElbow, leftWrist, leftIndex all pass
 * the confidence floor — also accumulate per-joint averages for the angle calc.
 * Returns null when fewer than MIN_HINGE_FRAMES qualify.
 */
function averageHingeWindow(
  frames: PoseFrame[],
  centerIdx: number,
): { elbow: { x: number; y: number }; wrist: { x: number; y: number }; index: { x: number; y: number }; framesUsed: number } | null {
  const start = Math.max(0, centerIdx - WINDOW_RADIUS);
  const end = Math.min(frames.length - 1, centerIdx + WINDOW_RADIUS);

  let sumElbowX = 0, sumElbowY = 0;
  let sumWristX = 0, sumWristY = 0;
  let sumIndexX = 0, sumIndexY = 0;
  let framesUsed = 0;

  for (let i = start; i <= end; i++) {
    const f = frames[i];
    if (!f) continue;
    const elbow = f.joints.leftElbow;
    const wrist = f.joints.leftWrist;
    const index = f.joints.leftIndex;
    if (!isGood(elbow) || !isGood(wrist) || !isGood(index)) continue;
    sumElbowX += elbow.x; sumElbowY += elbow.y;
    sumWristX += wrist.x; sumWristY += wrist.y;
    sumIndexX += index.x; sumIndexY += index.y;
    framesUsed++;
  }

  if (framesUsed < MIN_HINGE_FRAMES) return null;

  return {
    elbow: { x: sumElbowX / framesUsed, y: sumElbowY / framesUsed },
    wrist: { x: sumWristX / framesUsed, y: sumWristY / framesUsed },
    index: { x: sumIndexX / framesUsed, y: sumIndexY / framesUsed },
    framesUsed,
  };
}

/**
 * Signed 2D angle (degrees) between forearm vector (elbow→wrist) and hand
 * vector (wrist→index), measured in the canonical (x, y) plane.
 *
 * Positive = cupped (hand rotates back of forearm line).
 * Negative = bowed (hand rotates forward of forearm line).
 */
function signedHingeDeg(
  elbow: { x: number; y: number },
  wrist: { x: number; y: number },
  index: { x: number; y: number },
): number {
  const forearmX = wrist.x - elbow.x;
  const forearmY = wrist.y - elbow.y;
  const handX = index.x - wrist.x;
  const handY = index.y - wrist.y;
  const cross = forearmX * handY - forearmY * handX;
  const dot = forearmX * handX + forearmY * handY;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

function categorize(hingeAtImpactDeg: number): WristHingeCategory {
  if (hingeAtImpactDeg > CUPPED_THRESHOLD_DEG) return "cupped";
  if (hingeAtImpactDeg < BOWED_THRESHOLD_DEG) return "bowed";
  return "flat";
}

export function computeLeadWristHinge(
  frames: PoseFrame[],
  phases: DetectedPhase[],
): LeadWristHinge | null {
  const topPhase = phases.find((p) => p.phase === "top");
  const impactPhase = phases.find((p) => p.phase === "impact");
  if (!topPhase || !impactPhase) return null;

  const topAvg = averageHingeWindow(frames, topPhase.index);
  const impactAvg = averageHingeWindow(frames, impactPhase.index);
  if (!topAvg || !impactAvg) return null;

  const hingeAtTopDeg = signedHingeDeg(topAvg.elbow, topAvg.wrist, topAvg.index);
  const hingeAtImpactDeg = signedHingeDeg(impactAvg.elbow, impactAvg.wrist, impactAvg.index);
  if (Math.abs(hingeAtTopDeg) > MAX_PLAUSIBLE_HINGE_DEG) return null;
  if (Math.abs(hingeAtImpactDeg) > MAX_PLAUSIBLE_HINGE_DEG) return null;
  const deltaTransitionDeg = hingeAtImpactDeg - hingeAtTopDeg;

  const fullWindow = 2 * WINDOW_RADIUS + 1;
  const confidence = Math.min(topAvg.framesUsed, impactAvg.framesUsed) / fullWindow;

  return {
    hingeAtTopDeg,
    hingeAtImpactDeg,
    deltaTransitionDeg,
    category: categorize(hingeAtImpactDeg),
    framesUsedTop: topAvg.framesUsed,
    framesUsedImpact: impactAvg.framesUsed,
    confidence,
  };
}
