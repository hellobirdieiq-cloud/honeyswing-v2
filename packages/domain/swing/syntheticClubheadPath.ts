/**
 * syntheticClubheadPath.ts — Approximate clubhead path by extrapolating the
 * lead-arm vector (leftElbow → leftWrist) past the wrist by K_EXTENSION
 * forearm-multiples. Lead arm is canonical after toCanonicalSequence.
 *
 * Path direction at impact is the least-squares slope of clubhead y vs x across
 * a small window centered on impact. Canonical +x is the target line, so a
 * positive slope (path angle > 0) reads as in-to-out.
 *
 * Thresholds are PLACEHOLDERS pending corpus calibration via
 * scripts/replayWristHinge.ts.
 */
import type { PoseFrame, NormalizedJoint } from "../../pose/PoseTypes";
import type { DetectedPhase } from "./phaseDetection";

export type ClubheadPathCategory = "in-to-out" | "square" | "out-to-in";

export type ClubheadSample = {
  frameIdx: number;
  x: number;
  y: number;
};

export type SyntheticClubheadPath = {
  pathAngleAtImpactDeg: number;
  category: ClubheadPathCategory;
  samples: ClubheadSample[];
  framesUsed: number;
  confidence: number;
};

// K_EXTENSION calibration source: scripts/clubhead-overlay-prototype.py:38
export const K_EXTENSION = 4.0;

// Half-window radius around impact (full window = 2*RADIUS + 1 = 11 frames).
const WINDOW_RADIUS = 5;

// Minimum samples needed in the impact window to attempt the regression.
export const MIN_PATH_FRAMES = 5;

const MIN_CONFIDENCE = 0.5;

// PLACEHOLDER: calibrate from corpus replay; see scripts/replayWristHinge.ts
export const PATH_IN_TO_OUT_DEG = 8;
// PLACEHOLDER: calibrate from corpus replay; see scripts/replayWristHinge.ts
export const PATH_OUT_TO_IN_DEG = -8;

function isGood(j: NormalizedJoint | undefined): j is NormalizedJoint {
  return j != null && (j.confidence ?? 0) >= MIN_CONFIDENCE;
}

function categorize(pathAngleDeg: number): ClubheadPathCategory {
  if (pathAngleDeg > PATH_IN_TO_OUT_DEG) return "in-to-out";
  if (pathAngleDeg < PATH_OUT_TO_IN_DEG) return "out-to-in";
  return "square";
}

/**
 * Least-squares slope (dy/dx) of points. Returns 0 when variance in x is zero
 * (degenerate case — caller treats result as square).
 */
function slope(samples: ClubheadSample[]): number {
  const n = samples.length;
  let sumX = 0, sumY = 0;
  for (const s of samples) { sumX += s.x; sumY += s.y; }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0, den = 0;
  for (const s of samples) {
    const dx = s.x - meanX;
    num += dx * (s.y - meanY);
    den += dx * dx;
  }
  if (den === 0) return 0;
  return num / den;
}

export function computeSyntheticClubheadPath(
  frames: PoseFrame[],
  phases: DetectedPhase[],
): SyntheticClubheadPath | null {
  const impactPhase = phases.find((p) => p.phase === "impact");
  if (!impactPhase) return null;

  const start = Math.max(0, impactPhase.index - WINDOW_RADIUS);
  const end = Math.min(frames.length - 1, impactPhase.index + WINDOW_RADIUS);

  const samples: ClubheadSample[] = [];
  for (let i = start; i <= end; i++) {
    const f = frames[i];
    if (!f) continue;
    const elbow = f.joints.leftElbow;
    const wrist = f.joints.leftWrist;
    if (!isGood(elbow) || !isGood(wrist)) continue;
    const x = wrist.x + K_EXTENSION * (wrist.x - elbow.x);
    const y = wrist.y + K_EXTENSION * (wrist.y - elbow.y);
    samples.push({ frameIdx: i, x, y });
  }

  if (samples.length < MIN_PATH_FRAMES) return null;

  const dyDx = slope(samples);
  // atan2(slope, 1) is the angle of the tangent (slope = dy/dx).
  const pathAngleAtImpactDeg = (Math.atan2(dyDx, 1) * 180) / Math.PI;

  const fullWindow = 2 * WINDOW_RADIUS + 1;
  const confidence = samples.length / fullWindow;

  return {
    pathAngleAtImpactDeg,
    category: categorize(pathAngleAtImpactDeg),
    samples,
    framesUsed: samples.length,
    confidence,
  };
}
