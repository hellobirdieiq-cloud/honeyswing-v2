export type SwingPhase =
  | "address"
  | "takeaway"
  | "top"
  | "downswing"
  | "impact"
  | "follow_through";

export type SwingTrailPoint = {
  x: number;
  y: number;
  timestamp: number;
};

export interface DetectedPhase {
  phase: SwingPhase;
  label: string;
  point: SwingTrailPoint;
  index: number;
  timestamp: number;
  source: "heuristic" | "fallback";
}

export interface ImpactData {
  frameIndex: number;
  timestamp: number;
  point: SwingTrailPoint;
  velocity: number;
  source: "heuristic" | "fallback";
}

function velocity(a: SwingTrailPoint, b: SwingTrailPoint): number {
  const dt = b.timestamp - a.timestamp;
  if (dt === 0) return 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy) / dt;
}

function computeVelocities(points: SwingTrailPoint[]): number[] {
  const velocities: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    velocities.push(velocity(points[i - 1], points[i]));
  }
  return velocities;
}

function smoothVelocities(velocities: number[], window: number = 5): number[] {
  const half = Math.floor(window / 2);
  return velocities.map((_, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(velocities.length - 1, i + half);
    let sum = 0;
    for (let j = start; j <= end; j++) sum += velocities[j];
    return sum / (end - start + 1);
  });
}

function findMinYIndex(points: SwingTrailPoint[], startIdx: number, endIdx: number): number {
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

function findMaxVelocityIndex(velocities: number[], startIdx: number, endIdx: number): number {
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

const PHASE_LABELS: Record<SwingPhase, string> = {
  address: "Address",
  takeaway: "Takeaway",
  top: "Top",
  downswing: "Downswing",
  impact: "Impact",
  follow_through: "Finish",
};

const PHASE_ORDER: SwingPhase[] = [
  "address",
  "takeaway",
  "top",
  "downswing",
  "impact",
  "follow_through",
];

function fallbackPhases(points: SwingTrailPoint[]): DetectedPhase[] {
  const pcts = [0.02, 0.12, 0.45, 0.55, 0.65, 0.9];

  return PHASE_ORDER.map((phase, i) => {
    const idx = Math.min(points.length - 1, Math.max(0, Math.floor(pcts[i] * (points.length - 1))));
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

export function detectSwingPhases(points: SwingTrailPoint[]): DetectedPhase[] {
  if (points.length < 6) {
    return [];
  }

  const heuristicResult = tryHeuristicDetection(points);

  if (heuristicResult.length === 6) {
    const topTs = heuristicResult[2].timestamp;
    const addressTs = heuristicResult[0].timestamp;
    const impactTs = heuristicResult[4].timestamp;
    const backswing = topTs - addressTs;
    const downswing = impactTs - topTs;

    if (downswing > 0 && backswing > 0 && backswing / downswing >= 0.8) {
      return heuristicResult;
    }
  }

  return fallbackPhases(points);
}

function tryHeuristicDetection(points: SwingTrailPoint[]): DetectedPhase[] {
  const velocities = computeVelocities(points);
  const smoothed = smoothVelocities(velocities, 5);
  const lastIdx = points.length - 1;

  const topSearchStart = Math.floor(lastIdx * 0.2);
  const topSearchEnd = Math.floor(lastIdx * 0.6);

  if (topSearchStart >= topSearchEnd) return [];

  const topIdx = findMinYIndex(points, topSearchStart, topSearchEnd);

  const impactSearchStart = topIdx + 2;
  const impactSearchEnd = Math.min(lastIdx, Math.floor(lastIdx * 0.85));

  if (impactSearchStart >= impactSearchEnd) return [];

  const impactIdx = findMaxVelocityIndex(smoothed, impactSearchStart, impactSearchEnd);

  const maxImpactDistance = Math.floor(lastIdx * 0.4);
  const actualDistance = impactIdx - topIdx;
  if (actualDistance > maxImpactDistance || actualDistance < 2) return [];

  const addressIdx = Math.max(0, Math.floor(lastIdx * 0.02));
  const takeawayIdx = Math.floor(addressIdx + (topIdx - addressIdx) * 0.4);
  const downswingIdx = Math.floor(topIdx + (impactIdx - topIdx) * 0.35);
  const finishIdx = Math.min(lastIdx, impactIdx + Math.floor((lastIdx - impactIdx) * 0.7));

  const indices = [addressIdx, takeawayIdx, topIdx, downswingIdx, impactIdx, finishIdx];

  for (let i = 1; i < indices.length; i++) {
    if (indices[i] <= indices[i - 1]) {
      return [];
    }
  }

  for (let i = 1; i < indices.length; i++) {
    if (indices[i] - indices[i - 1] < 2) {
      return [];
    }
  }

  return PHASE_ORDER.map((phase, i) => ({
    phase,
    label: PHASE_LABELS[phase],
    point: points[indices[i]],
    index: indices[i],
    timestamp: points[indices[i]].timestamp,
    source: "heuristic" as const,
  }));
}

export function detectImpact(points: SwingTrailPoint[]): ImpactData | null {
  if (points.length < 10) return null;

  const velocities = computeVelocities(points);
  const smoothed = smoothVelocities(velocities, 5);
  const lastIdx = points.length - 1;

  const topSearchStart = Math.floor(lastIdx * 0.2);
  const topSearchEnd = Math.floor(lastIdx * 0.6);
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

export function getVisiblePhases(
  phases: DetectedPhase[],
  currentTimeMs: number
): DetectedPhase[] {
  return phases.filter((p) => p.timestamp <= currentTimeMs);
}
