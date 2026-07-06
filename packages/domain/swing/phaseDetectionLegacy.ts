/**
 * phaseDetectionLegacy.ts — pre-rules-doc single-path detector preserved as
 * the fallback for unknown camera angles. Behavior is intentionally 1:1 with
 * the prior `phaseDetection.ts` so swings that were classified as
 * `unknown` by the camera-angle pre-detector get exactly the same result
 * they would have gotten before the angle-aware split.
 *
 * TODO(legacy-disposition): live backup path only — reached when the early
 * camera-angle pre-detector returns "unknown" (confidence-degraded captures).
 * Fresh production phase_source / ruleDebug.detector data will decide whether
 * this detector is kept, retired, or fully characterized. Until then: smoke
 * coverage only (phaseDetection.test.ts T11); do not pin internal constants.
 */

import type {
  DetectedPhase,
  FallbackGate,
  ImpactData,
  SwingPhase,
  SwingTrailPoint,
} from "./phaseDetection";
import {
  computeTrailVelocities,
  findSetupEndIndex,
  smoothVelocities,
} from "./phaseDetectionShared";

const PHASE_LABELS: Record<SwingPhase, string> = {
  takeaway: "Takeaway",
  top: "Top",
  downswing: "Downswing",
  impact: "Impact",
  follow_through: "Finish",
};

const PHASE_ORDER: SwingPhase[] = [
  "takeaway",
  "top",
  "downswing",
  "impact",
  "follow_through",
];

function findMinYIndex(
  points: SwingTrailPoint[],
  startIdx: number,
  endIdx: number,
): number {
  let minY = Infinity;
  let minIdx = startIdx;
  for (let i = startIdx; i <= endIdx; i++) {
    if (points[i].y < minY) {
      minY = points[i].y;
      minIdx = i;
    }
  }
  return minIdx;
}

function findMaxVelocityIndex(
  velocities: number[],
  startIdx: number,
  endIdx: number,
): number {
  let maxV = 0;
  let maxIdx = startIdx;
  for (let i = startIdx; i <= endIdx; i++) {
    if (velocities[i] > maxV) {
      maxV = velocities[i];
      maxIdx = i;
    }
  }
  return maxIdx;
}

function fallbackPhases(points: SwingTrailPoint[]): DetectedPhase[] {
  const pcts = [0.12, 0.45, 0.55, 0.65, 0.9];
  return PHASE_ORDER.map((phase, i) => {
    const idx = Math.min(
      points.length - 1,
      Math.max(0, Math.floor(pcts[i] * (points.length - 1))),
    );
    return {
      phase,
      label: PHASE_LABELS[phase],
      point: points[idx],
      index: idx,
      timestamp: points[idx].timestamp,
      source: "fallback" as const,
    };
  });
}

export function tryHeuristicDetection(
  points: SwingTrailPoint[],
): { phases: DetectedPhase[]; failureGate: FallbackGate | null } {
  const velocities = computeTrailVelocities(points);
  const smoothed = smoothVelocities(velocities, 5);
  const lastIdx = points.length - 1;
  const msPerFrame =
    lastIdx > 0 ? (points[lastIdx].timestamp - points[0].timestamp) / lastIdx : 0;

  const addressIdx = findSetupEndIndex(smoothed, points);

  const topSearchStart = Math.min(lastIdx, addressIdx + Math.round(200 / msPerFrame));
  const topSearchEnd = Math.min(lastIdx, addressIdx + Math.round(2000 / msPerFrame));
  if (topSearchStart >= topSearchEnd) {
    return { phases: [], failureGate: "top_search_bounds" };
  }

  // Trail-wrist X minimum + lookahead guard (canonical S151). Reads the canonical
  // TRAIL wrist (leftWrist) via SwingTrailPoint.trailX.
  const MIN_TRAVEL = 0.04;
  const MIN_LOOKAHEAD_FRAMES = 10;

  let windowMax = -Infinity;
  let topIdx: number | null = null;
  for (let F = Math.max(topSearchStart, 1); F <= topSearchEnd - 2; F++) {
    const tWx = points[F].trailX;
    if (tWx > windowMax) windowMax = tWx;
    if (
      tWx < points[F - 1].trailX &&
      tWx < points[F + 1].trailX &&
      points[F + 1].trailX < points[F + 2].trailX &&
      tWx < windowMax - MIN_TRAVEL
    ) {
      let hasDeeperMin = false;
      for (let k = 1; k <= MIN_LOOKAHEAD_FRAMES && F + k <= topSearchEnd; k++) {
        if (points[F + k].trailX < tWx) {
          hasDeeperMin = true;
          break;
        }
      }
      if (!hasDeeperMin) {
        topIdx = F;
        break;
      }
    }
  }
  if (topIdx === null) return { phases: [], failureGate: "top_search_bounds" };

  const HAND_LOW_TO_IMPACT_MS = 67;
  const impactSearchStart = topIdx + Math.round(100 / msPerFrame);
  const impactSearchEnd = Math.min(lastIdx, topIdx + Math.round(1500 / msPerFrame));
  if (impactSearchStart >= impactSearchEnd) {
    return { phases: [], failureGate: "impact_search_bounds" };
  }

  let handLowFrame = impactSearchStart;
  let maxY = -Infinity;
  for (let F = impactSearchStart; F <= impactSearchEnd; F++) {
    if (points[F].y > maxY) {
      maxY = points[F].y;
      handLowFrame = F;
    }
  }
  const impactIdx = Math.min(
    lastIdx,
    handLowFrame + Math.round(HAND_LOW_TO_IMPACT_MS / msPerFrame),
  );

  const maxImpactDistance = Math.floor(lastIdx * 0.4);
  const actualDistance = impactIdx - topIdx;
  if (actualDistance > maxImpactDistance || actualDistance < 2) {
    return { phases: [], failureGate: "impact_distance_out_of_range" };
  }

  // Takeaway onset is addressIdx (first committed move); synthetic 40% slot removed.
  const downswingIdx = Math.floor(topIdx + (impactIdx - topIdx) * 0.35);

  const FOLLOW_THROUGH_MULTIPLIER = 3.0;
  const VEL_NOISE_FLOOR = 0.008;

  const downswingFrames = impactIdx - topIdx;
  const finishSearchEnd = Math.min(
    lastIdx,
    impactIdx + Math.round(downswingFrames * FOLLOW_THROUGH_MULTIPLIER),
  );
  const finishSearchStart = impactIdx + Math.round(300 / msPerFrame);

  let finishIdx = finishSearchEnd;
  if (finishSearchStart >= 1 && finishSearchStart < finishSearchEnd - 1) {
    for (let F = finishSearchStart; F <= finishSearchEnd - 2; F++) {
      const d0 = Math.hypot(
        points[F].x - points[F - 1].x,
        points[F].y - points[F - 1].y,
      );
      const d1 = Math.hypot(
        points[F + 1].x - points[F].x,
        points[F + 1].y - points[F].y,
      );
      const d2 = Math.hypot(
        points[F + 2].x - points[F + 1].x,
        points[F + 2].y - points[F + 1].y,
      );
      if (d0 < VEL_NOISE_FLOOR && d1 < VEL_NOISE_FLOOR && d2 < VEL_NOISE_FLOOR) {
        finishIdx = F;
        break;
      }
    }
  }
  finishIdx = Math.min(finishIdx, lastIdx);

  const indices = [addressIdx, topIdx, downswingIdx, impactIdx, finishIdx];

  for (let i = 1; i < indices.length; i++) {
    if (indices[i] <= indices[i - 1]) {
      return { phases: [], failureGate: "temporal_inversion" };
    }
  }
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] - indices[i - 1] < 2) {
      return { phases: [], failureGate: "phases_too_bunched" };
    }
  }

  return {
    phases: PHASE_ORDER.map((phase, i) => ({
      phase,
      label: PHASE_LABELS[phase],
      point: points[indices[i]],
      index: indices[i],
      timestamp: points[indices[i]].timestamp,
      source: "heuristic" as const,
    })),
    failureGate: null,
  };
}

/** Legacy entry point preserved with original ratio check + fallback. */
export function detectLegacyPhases(points: SwingTrailPoint[]): {
  phases: DetectedPhase[];
  fallbackGate: FallbackGate | null;
} {
  if (points.length < 6) {
    return { phases: [], fallbackGate: "points_too_short" };
  }

  const result = tryHeuristicDetection(points);

  if (result.phases.length === 6) {
    const topTs = result.phases[2].timestamp;
    const addressTs = result.phases[0].timestamp;
    const impactTs = result.phases[4].timestamp;
    const backswing = topTs - addressTs;
    const downswing = impactTs - topTs;

    if (downswing > 0 && backswing > 0 && backswing / downswing >= 0.8) {
      return { phases: result.phases, fallbackGate: null };
    }
    return {
      phases: fallbackPhases(points),
      fallbackGate: "backswing_ratio_check_failed",
    };
  }
  return { phases: fallbackPhases(points), fallbackGate: result.failureGate };
}

export function detectImpactLegacy(points: SwingTrailPoint[]): ImpactData | null {
  if (points.length < 10) return null;

  const velocities = computeTrailVelocities(points);
  const smoothed = smoothVelocities(velocities, 5);
  const lastIdx = points.length - 1;

  const topSearchStart = Math.floor(lastIdx * 0.2);
  const topSearchEnd = Math.floor(lastIdx * 0.75);
  if (topSearchStart >= topSearchEnd) return null;
  const topIdx = findMinYIndex(points, topSearchStart, topSearchEnd);

  const impactSearchStart = topIdx + 2;
  const impactSearchEnd = Math.min(lastIdx, Math.floor(lastIdx * 0.85));
  if (impactSearchStart >= impactSearchEnd) return null;
  const impactIdx = findMaxVelocityIndex(smoothed, impactSearchStart, impactSearchEnd);

  return {
    frameIndex: impactIdx,
    timestamp: points[impactIdx].timestamp,
    point: points[impactIdx],
    velocity: smoothed[impactIdx],
    source: "heuristic",
  };
}

export { PHASE_LABELS as LEGACY_PHASE_LABELS, PHASE_ORDER as LEGACY_PHASE_ORDER };
