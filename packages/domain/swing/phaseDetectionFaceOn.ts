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
// Phase 4 — impact: speed-banded lead-wrist (leftWrist) Y-arc-bottom.
// Validated via scripts/testLeadWristImpact.ts (T=0.90: +9 recoveries on
// impact_search_bounds, 1 regression). Replaces the prior trail-hand (rightWrist)
// X-rise-vs-footRef heuristic, which keyed off the wrong hand/axis for face-on.
// ---------------------------------------------------------------------------

const IMPACT_SPEED_LOOKBACK = 3; // frames; 2D leftWrist displacement window
const IMPACT_PEAK_PERCENTILE = 0.95; // robust max (ignores a single noisy spike)
const IMPACT_BAND_THRESHOLD = 0.9; // band = speed >= threshold * peak

function detectFaceOnImpact(
  frames: PoseFrame[],
  msPerFrame: number,
): { frame: number | null; reliability: "high" | "medium" | "low" | null } {
  // 2D leftWrist (lead hand) speed with k-frame lookback; speed[0..k-1]=0, and 0
  // when either frame's joint is missing. (Mirrors testLeadWristImpact.leadWristSpeed.)
  const n = frames.length;
  if (n === 0) return { frame: null, reliability: null };
  const speed = new Array<number>(n).fill(0);
  for (let f = IMPACT_SPEED_LOOKBACK; f < n; f++) {
    const a = frames[f - IMPACT_SPEED_LOOKBACK].joints.leftWrist;
    const b = frames[f].joints.leftWrist;
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    speed[f] = Math.sqrt(dx * dx + dy * dy);
  }

  // Robust peak = 95th-percentile speed (sort asc, index floor(0.95*n)).
  // (Mirrors testLeadWristImpact.robustPeak.)
  const sorted = [...speed].sort((a, b) => a - b);
  const peak = sorted[Math.min(Math.floor(IMPACT_PEAK_PERCENTILE * n), n - 1)];
  if (!(peak > 0)) return { frame: null, reliability: null };

  // Impact = the band frame (speed >= threshold*peak) with MAX leftWrist.y. y is
  // top-down 0..1, so arc bottom = max y. Restricting the search to the high-speed
  // band keeps it out of the slow address/finish regions where a global max lands.
  // (Mirrors testLeadWristImpact.bandedArcBottom.)
  const floor = IMPACT_BAND_THRESHOLD * peak;
  let bestIdx: number | null = null;
  let bestY = -Infinity;
  for (let f = 0; f < n; f++) {
    if (speed[f] < floor) continue;
    const y = frames[f].joints.leftWrist?.y;
    if (y == null) continue;
    if (y > bestY) {
      bestY = y;
      bestIdx = f;
    }
  }
  if (bestIdx == null) return { frame: null, reliability: null };
  return { frame: bestIdx, reliability: "medium" };
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
  /**
   * External candidate impact frame (test seam). When provided, replaces the
   * internal detectFaceOnImpact and flows through the real downstream
   * top/finish/gates/assembly. Production passes none → identical path. Must be a
   * valid in-array frame index [0, frames.length-1]; out-of-array yields a clean
   * impact_search_bounds gate. Used by scripts/testLeadWristImpact.ts.
   */
  impactOverride?: number;
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

  // Phase 4 — impact (no dependency on top). impactOverride lets an external
  // candidate (e.g. lead-wrist Y-arc-bottom) replace the internal detector and flow
  // through the real downstream top/finish/gates/assembly. Production passes none.
  let impactIdx: number;
  if (input.impactOverride != null) {
    // Required range [0, frames.length-1]: detectFaceOnTop's search bound
    // `to = impactIdx - toOffset` indexes frames[F] for F <= to <= impactIdx, so an
    // out-of-ARRAY override would read past the array (frames[F].joints on undefined).
    // Out-of-ORDER but in-array values are safe — the existing top_search_bounds /
    // temporal_inversion gates handle them.
    if (input.impactOverride < 0 || input.impactOverride > frames.length - 1) {
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
    impactIdx = input.impactOverride;
    reliability.impact = "medium"; // external candidate, not internal high/low
    assumptionsUsed.push("faceOn.impact:override");
  } else {
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
    impactIdx = impact.frame;
    reliability.impact = impact.reliability ?? "medium";
  }

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

  // Phase 1 — takeaway onset (first committed club movement) from findSetupEndIndex.
  // takeawayAddressIdx is a TRAIL-space index; convert to frame-space so phases[].index
  // is canonical and agrees with topIdx/impactIdx.
  const takeawayTimestamp = trail[takeawayAddressIdx].timestamp;
  const takeawayIdx = frames.findIndex(f => f.timestampMs === takeawayTimestamp);
  if (takeawayIdx === -1) {
    throw new Error('[HoneySwing] trail timestamp not found in frames — phase fix incomplete');
  }
  reliability.true_address = "low";

  // Sanity: takeaway must precede top must precede impact.
  if (!(takeawayIdx < topIdx && topIdx < impactIdx)) {
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

  const downswingIdx = Math.floor(topIdx + (impactIdx - topIdx) * 0.35);

  // Phase 5 — finish
  const finish = detectFaceOnFinish(frames, impactIdx, msPerFrame);
  assumptionsUsed.push("faceOn.finish");
  reliability.finish = finish.reliability;

  const indices = [takeawayIdx, topIdx, downswingIdx, impactIdx, finish.frame];
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

// ---------------------------------------------------------------------------
// Debug-only entry: runs the same sub-detectors as detectFaceOnPhases but
// does NOT return early on gate violations. Used by scripts/debugPhaseDetection.ts
// to surface the interim addressIdx / topIdx / impactIdx values that the
// temporal_inversion gate compares.
// ---------------------------------------------------------------------------

export type FaceOnPhasesDebugResult = {
  swingStartFrame: number | null;
  takeawayAddressIdx: number | null;
  addressIdx: number | null;
  takeawayIdx: number | null;
  topIdx: number | null;
  downswingIdx: number | null;
  impactIdx: number | null;
  finishFrame: number | null;
  triggerA: { fired: boolean; condition: string };
  triggerB: { fired: boolean; offendingPair: string | null };
  wouldFallbackGate: FallbackGate | null;
};

export function detectFaceOnPhasesDebug(input: {
  canonical: PoseSequence;
  trail: SwingTrailPoint[];
  msPerFrame: number;
}): FaceOnPhasesDebugResult {
  const { canonical, trail, msPerFrame } = input;
  const frames = canonical.frames;

  const result: FaceOnPhasesDebugResult = {
    swingStartFrame: null,
    takeawayAddressIdx: null,
    addressIdx: null,
    takeawayIdx: null,
    topIdx: null,
    downswingIdx: null,
    impactIdx: null,
    finishFrame: null,
    triggerA: { fired: false, condition: "n/a (missing indices)" },
    triggerB: { fired: false, offendingPair: null },
    wouldFallbackGate: null,
  };

  if (trail.length < 6) {
    result.wouldFallbackGate = "points_too_short";
    return result;
  }

  const swingStart = detectFaceOnSwingStart(frames, msPerFrame);
  result.swingStartFrame = swingStart.frame;

  const velocities = computeTrailVelocities(trail);
  const smoothed = smoothVelocities(velocities, 5);
  const takeawayAddressIdx = findSetupEndIndex(smoothed, trail);
  result.takeawayAddressIdx = takeawayAddressIdx;
  result.addressIdx = takeawayAddressIdx;

  const impact = detectFaceOnImpact(frames, msPerFrame);
  result.impactIdx = impact.frame;

  if (impact.frame == null) {
    result.wouldFallbackGate = "impact_search_bounds";
    return result;
  }

  const topSearchAnchor = swingStart.frame ?? takeawayAddressIdx;
  const top = detectFaceOnTop(frames, topSearchAnchor, impact.frame);
  result.topIdx = top.frame;

  if (top.frame == null) {
    result.wouldFallbackGate = "top_search_bounds";
    return result;
  }

  const takeawayIdx = takeawayAddressIdx;
  const topIdx = top.frame;
  const impactIdx = impact.frame;

  const triggerAOk = takeawayIdx < topIdx && topIdx < impactIdx;
  result.triggerA = {
    fired: !triggerAOk,
    condition: `${takeawayIdx} < ${topIdx} < ${impactIdx} = ${triggerAOk}`,
  };

  if (!triggerAOk) {
    result.wouldFallbackGate = "temporal_inversion";
    return result;
  }

  const downswingIdx = Math.floor(topIdx + (impactIdx - topIdx) * 0.35);
  result.takeawayIdx = takeawayIdx;
  result.downswingIdx = downswingIdx;

  const finish = detectFaceOnFinish(frames, impactIdx, msPerFrame);
  result.finishFrame = finish.frame;

  const indices = [takeawayIdx, topIdx, downswingIdx, impactIdx, finish.frame];
  const labels = ["takeaway", "top", "downswing", "impact", "follow_through"];
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] <= indices[i - 1]) {
      result.triggerB = {
        fired: true,
        offendingPair: `${labels[i - 1]}=${indices[i - 1]} >= ${labels[i]}=${indices[i]}`,
      };
      result.wouldFallbackGate = "temporal_inversion";
      return result;
    }
  }
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] - indices[i - 1] < 2) {
      result.wouldFallbackGate = "phases_too_bunched";
      return result;
    }
  }

  return result;
}
