/**
 * phaseDetectionFaceOn.ts — face-on camera phase detection per
 * docs/HoneySwing_Phase_Detection_Rules.md (Face-On Phase 0, 2, 3, 4, 5).
 *
 * Phase 1 (true_address) is NOT validated face-on per spec doc; we fall
 * back to the takeaway directional gate's start-of-window address frame
 * (matches legacy behavior and keeps tempo math consistent).
 */

import type { PoseFrame, PoseSequence } from "../../pose/PoseTypes";
import type {
  DetectedPhase,
  FallbackGate,
  SwingPhase,
  SwingTrailPoint,
} from "./phaseDetection";
import {
  EXTERNAL_ASSUMPTIONS,
  computeTrailVelocities,
  emptyReliability,
  findSetupEndIndex,
  msToFrames,
  smoothVelocities,
  type PhaseRuleDebug,
  type PhaseRuleReliability,
} from "./phaseDetectionShared";

const A = EXTERNAL_ASSUMPTIONS.faceOn;

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

// ---------------------------------------------------------------------------
// Helpers — joint velocity per frame, with null-skip for missing joints
// ---------------------------------------------------------------------------

function jointVelocity(
  prev: PoseFrame,
  curr: PoseFrame,
  name: "leftWrist" | "rightWrist" | "leftShoulder",
): number | null {
  const a = prev.joints[name];
  const b = curr.joints[name];
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------------------------------------------------------------------------
// Phase 0 — 3-joint velocity average swing start
// ---------------------------------------------------------------------------

function detectFaceOnSwingStart(
  frames: PoseFrame[],
  msPerFrame: number,
): {
  frame: number | null;
  reliability: "high" | "medium" | "low" | null;
} {
  if (frames.length < 30) return { frame: null, reliability: null };

  const avg: (number | null)[] = new Array(frames.length).fill(null);
  for (let i = 1; i < frames.length; i++) {
    const v1 = jointVelocity(frames[i - 1], frames[i], "rightWrist");
    const v2 = jointVelocity(frames[i - 1], frames[i], "leftWrist");
    const v3 = jointVelocity(frames[i - 1], frames[i], "leftShoulder");
    if (v1 == null || v2 == null || v3 == null) continue;
    avg[i] = (v1 + v2 + v3) / 3;
  }

  // Baseline: mean of the N lowest avg values within the first window frames.
  const window = Math.min(A.swingStart.baselineWindowFrames, avg.length - 1);
  const baselineCandidates: number[] = [];
  for (let i = 1; i <= window; i++) {
    if (avg[i] != null) baselineCandidates.push(avg[i] as number);
  }
  if (baselineCandidates.length < 5) return { frame: null, reliability: null };
  baselineCandidates.sort((a, b) => a - b);
  const takeN = Math.min(A.swingStart.baselineLowestN, baselineCandidates.length);
  let baseSum = 0;
  for (let i = 0; i < takeN; i++) baseSum += baselineCandidates[i];
  const baseline = baseSum / takeN;
  if (baseline <= 0) return { frame: null, reliability: null };

  const sustainFrames = Math.max(1, msToFrames(A.swingStart.sustainMs, msPerFrame));
  const triggerFloor = baseline * A.swingStart.triggerMultiplier;
  const sustainFloor = baseline * A.swingStart.sustainMultiplier;

  for (let F = 1; F + sustainFrames < avg.length; F++) {
    if (avg[F] == null) continue;
    let allAboveTrigger = true;
    let sum = 0;
    let count = 0;
    for (let k = 0; k <= sustainFrames; k++) {
      const v = avg[F + k];
      if (v == null || v <= triggerFloor) {
        allAboveTrigger = false;
        break;
      }
      sum += v;
      count++;
    }
    if (!allAboveTrigger || count === 0) continue;
    const meanWindow = sum / count;
    if (meanWindow > sustainFloor) {
      const reliability: "high" | "medium" =
        meanWindow > sustainFloor * 1.25 ? "high" : "medium";
      return { frame: F, reliability };
    }
  }
  return { frame: null, reliability: "low" };
}

// ---------------------------------------------------------------------------
// Phase 4 — impact (hand/foot x crossing with foot locked at address)
// ---------------------------------------------------------------------------

function detectFaceOnImpact(
  frames: PoseFrame[],
  msPerFrame: number,
): { frame: number | null; reliability: "high" | "medium" | "low" | null } {
  // Foot reference locked at address window (frames 0..N).
  const footFrames = Math.min(A.impact.footRefFrames, frames.length);
  const footSamples: number[] = [];
  for (let i = 0; i < footFrames; i++) {
    const h = frames[i].joints.leftHeel;
    const a = frames[i].joints.leftAnkle;
    if (h && a) footSamples.push((h.x + a.x) / 2);
  }
  if (footSamples.length === 0) return { frame: null, reliability: null };
  const footRef = footSamples.reduce((s, v) => s + v, 0) / footSamples.length;

  // hand_avg per frame = (trailWrist.x + trailThumb.x) / 2 (canonical R-side).
  const handAvg: (number | null)[] = frames.map((f) => {
    const w = f.joints.rightWrist;
    const t = f.joints.rightThumb;
    if (!w) return null;
    if (!t) return w.x; // thumb often missing; fall back to wrist only.
    return (w.x + t.x) / 2;
  });

  const sustainFrames = Math.max(1, msToFrames(A.impact.riseSustainMs, msPerFrame));
  let activeStreak = 0;

  for (let F = A.impact.riseLookbackFrames; F < frames.length; F++) {
    const here = handAvg[F];
    const prev = handAvg[F - A.impact.riseLookbackFrames];
    if (here == null || prev == null) {
      activeStreak = 0;
      continue;
    }
    const riseRate = here - prev;
    if (riseRate > A.impact.riseRateThreshold) {
      activeStreak += 1;
    } else {
      activeStreak = 0;
    }
    const riseActive = activeStreak >= sustainFrames;
    if (riseActive && here >= footRef) {
      const lagFrames = msToFrames(A.impact.lagCorrectionMs, msPerFrame);
      const impactFrame = Math.max(0, F - lagFrames);
      return { frame: impactFrame, reliability: "high" };
    }
  }
  return { frame: null, reliability: "low" };
}

// ---------------------------------------------------------------------------
// Phase 3 — top of backswing (consensus across velocity min, z max, shoulder x min)
// ---------------------------------------------------------------------------

function detectFaceOnTop(
  frames: PoseFrame[],
  swingStartIdx: number,
  impactIdx: number,
): { frame: number | null; reliability: "high" | "medium" | "low" | null } {
  const totalSpan = impactIdx - swingStartIdx;
  if (totalSpan < 6) return { frame: null, reliability: null };

  const fromOffset = Math.round(totalSpan * A.top.searchStartFraction);
  const toOffset = Math.round(totalSpan * A.top.searchEndFraction);
  const from = swingStartIdx + fromOffset;
  const to = impactIdx - toOffset;
  if (to <= from) return { frame: null, reliability: null };

  // rightWrist velocity per frame.
  const rwVel: (number | null)[] = frames.map((f, i) => {
    if (i === 0) return null;
    return jointVelocity(frames[i - 1], f, "rightWrist");
  });

  let velMinFi = from;
  let velMinV = Infinity;
  for (let F = from; F <= to; F++) {
    const v = rwVel[F];
    if (v != null && v < velMinV) {
      velMinV = v;
      velMinFi = F;
    }
  }

  const window = A.top.consensusWindowFrames;
  // rightWrist z max within ±window of velMinFi.
  let zMaxFi: number | null = null;
  let zMaxV = -Infinity;
  for (let F = Math.max(from, velMinFi - window); F <= Math.min(to, velMinFi + window); F++) {
    const z = frames[F].joints.rightWrist?.z;
    if (z != null && z > zMaxV) {
      zMaxV = z;
      zMaxFi = F;
    }
  }

  // leftShoulder x min within ±window of velMinFi.
  let lsMinFi: number | null = null;
  let lsMinV = Infinity;
  for (let F = Math.max(from, velMinFi - window); F <= Math.min(to, velMinFi + window); F++) {
    const x = frames[F].joints.leftShoulder?.x;
    if (x != null && x < lsMinV) {
      lsMinV = x;
      lsMinFi = F;
    }
  }

  const signals = [velMinFi, zMaxFi, lsMinFi].filter((v): v is number => v != null);
  if (signals.length === 0) return { frame: null, reliability: null };

  const mn = Math.min(...signals);
  const mx = Math.max(...signals);
  if (signals.length === 3 && mx - mn <= window) {
    const mean = Math.round(signals.reduce((s, v) => s + v, 0) / signals.length);
    return { frame: mean, reliability: "high" };
  }
  return { frame: velMinFi, reliability: "medium" };
}

// ---------------------------------------------------------------------------
// Phase 5 — finish (trail shoulder x plateau)
// ---------------------------------------------------------------------------

function detectFaceOnFinish(
  frames: PoseFrame[],
  impactIdx: number,
  msPerFrame: number,
): { frame: number; reliability: "high" | "medium" | "low" } {
  const lastIdx = frames.length - 1;
  const tsx: (number | null)[] = frames.map((f) => f.joints.rightShoulder?.x ?? null);

  const W = A.finish.rollingWindow;
  const rolling: (number | null)[] = tsx.map((_, i) => {
    const lo = Math.max(0, i - Math.floor(W / 2));
    const hi = Math.min(lastIdx, i + Math.floor(W / 2));
    let sum = 0;
    let count = 0;
    for (let j = lo; j <= hi; j++) {
      const v = tsx[j];
      if (v == null) continue;
      sum += v;
      count++;
    }
    return count === W ? sum / count : null;
  });

  // Jitter filter: drop frames where raw value exceeds rolling avg by >jitterPct.
  const cleaned: (number | null)[] = rolling.map((r, i) => {
    if (r == null) return null;
    const raw = tsx[i];
    if (raw == null) return null;
    if (Math.abs(raw - r) > Math.abs(r) * A.finish.plateauJitterPct) return null;
    return r;
  });

  // Find highest clean rolling avg after impact.
  let plateau = -Infinity;
  let plateauIdx: number | null = null;
  for (let i = impactIdx + 1; i <= lastIdx; i++) {
    const v = cleaned[i];
    if (v == null) continue;
    if (v > plateau) {
      plateau = v;
      plateauIdx = i;
    }
  }
  if (plateauIdx == null) {
    return { frame: lastIdx, reliability: "low" };
  }

  // Confirmation: ~confirmMs of rising x before plateau.
  const confirmFrames = Math.max(1, msToFrames(A.finish.plateauConfirmMs, msPerFrame));
  let rising = 0;
  const confirmStart = Math.max(impactIdx + 1, plateauIdx - confirmFrames);
  for (let i = confirmStart + 1; i <= plateauIdx; i++) {
    const a = cleaned[i - 1];
    const b = cleaned[i];
    if (a == null || b == null) continue;
    if (b >= a) rising += 1;
  }
  const confirmed = rising >= Math.floor((plateauIdx - confirmStart) * 0.6);

  return {
    frame: plateauIdx,
    reliability: confirmed ? "high" : "medium",
  };
}

// ---------------------------------------------------------------------------
// Dispatcher entry point
// ---------------------------------------------------------------------------

export function detectFaceOnPhases(input: {
  canonical: PoseSequence;
  trail: SwingTrailPoint[];
  msPerFrame: number;
}): {
  phases: DetectedPhase[];
  fallbackGate: FallbackGate | null;
  ruleDebug: PhaseRuleDebug;
} {
  const { canonical, trail, msPerFrame } = input;
  const frames = canonical.frames;
  const reliability: PhaseRuleReliability = emptyReliability();
  const assumptionsUsed: string[] = [];

  if (trail.length < 6) {
    return {
      phases: [],
      fallbackGate: "points_too_short",
      ruleDebug: {
        detector: "face_on",
        swing_start_frame: null,
        true_address_frame: null,
        reliability,
        external_assumptions_used: assumptionsUsed,
      },
    };
  }

  // Phase 0 — swing_start
  const swingStart = detectFaceOnSwingStart(frames, msPerFrame);
  reliability.swing_start = swingStart.reliability;
  assumptionsUsed.push("faceOn.swingStart");

  // Phase 2 — takeaway directional gate (for fallback address)
  const velocities = computeTrailVelocities(trail);
  const smoothed = smoothVelocities(velocities, 5);
  const takeawayAddressIdx = findSetupEndIndex(smoothed, trail);
  reliability.takeaway = "medium";

  // Phase 4 — impact (no dependency on top)
  const impact = detectFaceOnImpact(frames, msPerFrame);
  assumptionsUsed.push("faceOn.impact");
  if (impact.frame == null) {
    return {
      phases: [],
      fallbackGate: "impact_search_bounds",
      ruleDebug: {
        detector: "face_on",
        swing_start_frame: swingStart.frame,
        true_address_frame: null,
        reliability,
        external_assumptions_used: assumptionsUsed,
      },
    };
  }
  const impactIdx = impact.frame;
  reliability.impact = impact.reliability ?? "medium";

  // Phase 3 — top (uses swing_start and impact for search bounds)
  const topSearchAnchor = swingStart.frame ?? takeawayAddressIdx;
  const top = detectFaceOnTop(frames, topSearchAnchor, impactIdx);
  assumptionsUsed.push("faceOn.top");
  if (top.frame == null) {
    return {
      phases: [],
      fallbackGate: "top_search_bounds",
      ruleDebug: {
        detector: "face_on",
        swing_start_frame: swingStart.frame,
        true_address_frame: null,
        reliability,
        external_assumptions_used: assumptionsUsed,
      },
    };
  }
  const topIdx = top.frame;
  reliability.top = top.reliability ?? "medium";

  // Phase 1 — true_address not validated face-on; use takeaway gate fallback.
  const addressIdx = takeawayAddressIdx;
  reliability.true_address = "low";

  // Sanity: address must precede top must precede impact.
  if (!(addressIdx < topIdx && topIdx < impactIdx)) {
    return {
      phases: [],
      fallbackGate: "temporal_inversion",
      ruleDebug: {
        detector: "face_on",
        swing_start_frame: swingStart.frame,
        true_address_frame: null,
        reliability,
        external_assumptions_used: assumptionsUsed,
      },
    };
  }

  const takeawayIdx = Math.floor(addressIdx + (topIdx - addressIdx) * 0.4);
  const downswingIdx = Math.floor(topIdx + (impactIdx - topIdx) * 0.35);

  // Phase 5 — finish
  const finish = detectFaceOnFinish(frames, impactIdx, msPerFrame);
  assumptionsUsed.push("faceOn.finish");
  reliability.finish = finish.reliability;

  const indices = [addressIdx, takeawayIdx, topIdx, downswingIdx, impactIdx, finish.frame];
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] <= indices[i - 1]) {
      return {
        phases: [],
        fallbackGate: "temporal_inversion",
        ruleDebug: {
          detector: "face_on",
          swing_start_frame: swingStart.frame,
          true_address_frame: null,
          reliability,
          external_assumptions_used: assumptionsUsed,
        },
      };
    }
  }
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] - indices[i - 1] < 2) {
      return {
        phases: [],
        fallbackGate: "phases_too_bunched",
        ruleDebug: {
          detector: "face_on",
          swing_start_frame: swingStart.frame,
          true_address_frame: null,
          reliability,
          external_assumptions_used: assumptionsUsed,
        },
      };
    }
  }

  const phases: DetectedPhase[] = PHASE_ORDER.map((phase, i) => ({
    phase,
    label: PHASE_LABELS[phase],
    point: trail[indices[i]],
    index: indices[i],
    timestamp: trail[indices[i]].timestamp,
    source: "heuristic" as const,
  }));

  return {
    phases,
    fallbackGate: null,
    ruleDebug: {
      detector: "face_on",
      swing_start_frame: swingStart.frame,
      true_address_frame: null,
      reliability,
      external_assumptions_used: assumptionsUsed,
    },
  };
}
