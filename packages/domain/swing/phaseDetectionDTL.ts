/**
 * phaseDetectionDTL.ts — DTL-camera phase detection per
 * docs/HoneySwing_Phase_Detection_Rules.md (DTL Phase 0–5).
 *
 * Reads joints from the canonical PoseSequence (already mirrored for lefties)
 * plus the wrist-midpoint trail for the shared takeaway gate. Returns the
 * same 6-slot DetectedPhase[] shape as the legacy detector so downstream
 * tempo/scoring/angle-windowing code needs no changes.
 *
 * Phase 0 (swing_start) and Phase 1 (true_address) are surfaced in the rule
 * debug record for diagnostics; address.frame in the output is filled with
 * true_address when the window scan finds it, otherwise with the takeaway
 * directional gate's start-of-window (matching legacy behavior).
 */

import type { PoseFrame, PoseSequence } from "../../pose/PoseTypes";
import { calculateGolfAngles } from "./angles";
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
  scalePerFrameFloor,
  smoothVelocities,
  smoothWindow,
  type PhaseRuleDebug,
  type PhaseRuleReliability,
} from "./phaseDetectionShared";

const A = EXTERNAL_ASSUMPTIONS.dtl;

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
// Phase 0 — hip dSpreadX swing start
// ---------------------------------------------------------------------------

/**
 * Returns frame index at which the hips first commit to rotation, or null
 * if no committed onset is found. Works in canonical space because the
 * canonical transform preserves |dSpreadX| magnitude for lefties (joint-name
 * swap + x-mirror cancel out — see rules doc DTL Phase 0 notes).
 */
function detectDTLSwingStart(
  frames: PoseFrame[],
  msPerFrame: number,
): {
  frame: number | null;
  reliability: "high" | "medium" | "low" | null;
  baselineUsed: number;
  thresholdUsed: number;
} {
  // 1b: rate-derived frame counts (fall back to the old literals at 60fps).
  const baselineN = msToFrames(A.swingStart.baselineMs, msPerFrame);
  const watchTimeoutN = msToFrames(A.swingStart.watchTimeoutMs, msPerFrame);
  const lb = Math.max(1, msToFrames(A.swingStart.riseLookbackMs, msPerFrame));
  const spreadX: (number | null)[] = frames.map((f) => {
    const lh = f.joints.leftHip;
    const rh = f.joints.rightHip;
    if (!lh || !rh) return null;
    return lh.x - rh.x;
  });

  const midX: (number | null)[] = frames.map((f) => {
    const lh = f.joints.leftHip;
    const rh = f.joints.rightHip;
    if (!lh || !rh) return null;
    return (lh.x + rh.x) / 2;
  });

  // dSpreadX[i] = spreadX[i] - spreadX[i-1]; null when either side missing.
  const dSpreadX: (number | null)[] = spreadX.map((v, i) => {
    if (i === 0 || v == null || spreadX[i - 1] == null) return null;
    return v - spreadX[i - 1]!;
  });

  // Baseline: mean(|dSpreadX|) over first N frames where dSpreadX is defined.
  const baselineSamples: number[] = [];
  for (let i = 1; i <= baselineN && i < dSpreadX.length; i++) {
    const v = dSpreadX[i];
    if (v != null) baselineSamples.push(Math.abs(v));
  }

  if (baselineSamples.length === 0) {
    return { frame: null, reliability: null, baselineUsed: 0, thresholdUsed: 0 };
  }
  const baseline = baselineSamples.reduce((a, b) => a + b, 0) / baselineSamples.length;

  const hardThreshold = Math.max(baseline * A.swingStart.hardMultiplier, A.swingStart.hardFloor);
  const watchThreshold = Math.max(baseline * A.swingStart.watchMultiplier, A.swingStart.watchFloor);

  let watchTimeout = 0;
  for (let F = lb; F < dSpreadX.length - 1; F++) {
    const sxF = spreadX[F];
    const sxF3 = spreadX[F - lb];
    const mxF = midX[F];
    const mxF3 = midX[F - lb];

    if (sxF != null && sxF3 != null) {
      if (sxF - sxF3 > A.swingStart.spreadRiseDelta) {
        watchTimeout = watchTimeoutN;
      }
    }
    if (mxF != null && mxF3 != null) {
      if (Math.abs(mxF - mxF3) > A.swingStart.midXDriftDelta) {
        watchTimeout = watchTimeoutN;
      }
    }
    const watchMode = watchTimeout > 0;
    watchTimeout = Math.max(0, watchTimeout - 1);

    const threshold = watchMode ? watchThreshold : hardThreshold;
    const dF = dSpreadX[F];
    const dFp = dSpreadX[F + 1];
    if (dF != null && dFp != null && dF > threshold && dFp > 0) {
      // Reliability: HIGH when both peak conditions firmly cleared.
      const reliability: "high" | "medium" = dF > threshold * 1.25 ? "high" : "medium";
      return {
        frame: Math.max(0, F - 1),
        reliability,
        baselineUsed: baseline,
        thresholdUsed: threshold,
      };
    }
  }

  return { frame: null, reliability: "low", baselineUsed: baseline, thresholdUsed: hardThreshold };
}

// ---------------------------------------------------------------------------
// Phase 1 — spine + head + trail-knee window scan for true address
// ---------------------------------------------------------------------------

/** Returns frame index of the true address window, or null if none found. */
function detectDTLTrueAddress(
  frames: PoseFrame[],
  topIdx: number,
  msPerFrame: number,
): { frame: number | null; reliability: "high" | "medium" | "low" | null } {
  // Pre-compute per-frame signals so the window scan stays cheap.
  const spineAngles: (number | null)[] = frames.map((f) => calculateGolfAngles(f).spineAngle);
  const trailKneeAngles: (number | null)[] = frames.map((f) => {
    // Canonical convention: rightKnee is the trail-side knee post-mirror.
    return calculateGolfAngles(f).rightKneeAngle;
  });
  // headDelta = signed per-frame nose.x displacement. The DTL view holds the
  // head laterally still through address; |delta| is the stillness signal.
  const headDelta: (number | null)[] = frames.map((f, i) => {
    if (i === 0) return 0;
    const a = frames[i - 1].joints.nose;
    const b = f.joints.nose;
    if (!a || !b) return null;
    return b.x - a.x;
  });

  const W = msToFrames(A.trueAddress.windowMs, msPerFrame);
  const scanEnd = Math.max(0, topIdx - msToFrames(A.trueAddress.backScanCapBeforeTopMs, msPerFrame));
  const headMax = scalePerFrameFloor(A.trueAddress.headDeltaMax, msPerFrame); // 1b-2: per-ms head-still floor

  for (let end = scanEnd; end >= W - 1; end--) {
    const start = end - (W - 1);
    let spineMin = Infinity;
    let spineMax = -Infinity;
    let kneeMin = Infinity;
    let kneeMax = -Infinity;
    let headOk = true;
    let allDefined = true;
    for (let i = start; i <= end; i++) {
      const s = spineAngles[i];
      const k = trailKneeAngles[i];
      const h = headDelta[i];
      if (s == null || k == null || h == null) {
        allDefined = false;
        break;
      }
      if (s < spineMin) spineMin = s;
      if (s > spineMax) spineMax = s;
      if (k < kneeMin) kneeMin = k;
      if (k > kneeMax) kneeMax = k;
      if (Math.abs(h) >= headMax) {
        headOk = false;
        break;
      }
    }
    if (!allDefined || !headOk) continue;

    const spineVar = spineMax - spineMin;
    const kneeVar = kneeMax - kneeMin;
    if (
      spineVar < A.trueAddress.spineVarMax &&
      kneeVar < A.trueAddress.kneeVarMax
    ) {
      return { frame: end, reliability: "high" };
    }
  }

  return { frame: null, reliability: null };
}

// ---------------------------------------------------------------------------
// Phase 3 — top of backswing (trail wrist X minimum + lookahead guard).
// Reads the canonical TRAIL wrist (leftWrist) via SwingTrailPoint.trailX.
// ---------------------------------------------------------------------------

function detectDTLTop(
  points: SwingTrailPoint[],
  addressIdx: number,
  msPerFrame: number,
): { frame: number | null } {
  const lastIdx = points.length - 1;
  const topSearchStart = Math.min(lastIdx, addressIdx + msToFrames(A.top.searchStartMs, msPerFrame));
  const topSearchEnd = Math.min(lastIdx, addressIdx + msToFrames(A.top.searchEndMs, msPerFrame));
  if (topSearchStart >= topSearchEnd) return { frame: null };

  let windowMax = -Infinity;
  for (let F = Math.max(topSearchStart, 1); F <= topSearchEnd - 2; F++) {
    const tWx = points[F].trailX;
    if (tWx > windowMax) windowMax = tWx;
    if (
      tWx < points[F - 1].trailX &&
      tWx < points[F + 1].trailX &&
      points[F + 1].trailX < points[F + 2].trailX &&
      tWx < windowMax - A.top.minTravel
    ) {
      let hasDeeperMin = false;
      const lookaheadN = msToFrames(A.top.lookaheadMs, msPerFrame);
      for (let k = 1; k <= lookaheadN && F + k <= topSearchEnd; k++) {
        if (points[F + k].trailX < tWx) {
          hasDeeperMin = true;
          break;
        }
      }
      if (!hasDeeperMin) return { frame: F };
    }
  }
  return { frame: null };
}

// ---------------------------------------------------------------------------
// Phase 4 — impact (combined wrist Y maximum + 67 ms offset)
// ---------------------------------------------------------------------------

function detectDTLImpact(
  points: SwingTrailPoint[],
  topIdx: number,
  msPerFrame: number,
): { frame: number | null } {
  const lastIdx = points.length - 1;
  const impactSearchStart = topIdx + msToFrames(A.impact.searchStartMs, msPerFrame);
  const impactSearchEnd = Math.min(lastIdx, topIdx + msToFrames(A.impact.searchEndMs, msPerFrame));
  if (impactSearchStart >= impactSearchEnd) return { frame: null };

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
    handLowFrame + msToFrames(A.impact.handLowToImpactMs, msPerFrame),
  );
  return { frame: impactIdx };
}

// ---------------------------------------------------------------------------
// Phase 5 — finish (per-frame wrist displacement falls below floor × 3 frames)
// ---------------------------------------------------------------------------

function detectDTLFinish(
  points: SwingTrailPoint[],
  topIdx: number,
  impactIdx: number,
  msPerFrame: number,
): { frame: number; complete: boolean } {
  const lastIdx = points.length - 1;
  const downswingFrames = impactIdx - topIdx;
  const finishSearchEnd = Math.min(
    lastIdx,
    impactIdx + Math.round(downswingFrames * A.finish.searchMultiplier),
  );
  const finishSearchStart = impactIdx + msToFrames(A.finish.minFollowMs, msPerFrame);
  const velFloor = scalePerFrameFloor(A.finish.velocityFloor, msPerFrame); // 1b-2: per-ms stop floor

  if (finishSearchStart < 1 || finishSearchStart >= finishSearchEnd - 1) {
    return { frame: finishSearchEnd, complete: false };
  }

  for (let F = finishSearchStart; F <= finishSearchEnd - 2; F++) {
    const d0 = Math.hypot(points[F].x - points[F - 1].x, points[F].y - points[F - 1].y);
    const d1 = Math.hypot(points[F + 1].x - points[F].x, points[F + 1].y - points[F].y);
    const d2 = Math.hypot(points[F + 2].x - points[F + 1].x, points[F + 2].y - points[F + 1].y);
    if (
      d0 < velFloor &&
      d1 < velFloor &&
      d2 < velFloor
    ) {
      return { frame: F, complete: true };
    }
  }
  return { frame: finishSearchEnd, complete: false };
}

// ---------------------------------------------------------------------------
// Dispatcher entry point
// ---------------------------------------------------------------------------

export function detectDTLPhases(input: {
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
        detector: "dtl",
        swing_start_frame: null,
        true_address_frame: null,
        reliability,
        external_assumptions_used: assumptionsUsed,
      },
    };
  }

  // Phase 0 — swing_start
  const swingStart = detectDTLSwingStart(frames, msPerFrame);
  reliability.swing_start = swingStart.reliability;
  assumptionsUsed.push("dtl.swingStart");

  // Phase 2 — takeaway directional gate (start-of-window address candidate)
  const velocities = computeTrailVelocities(trail);
  const smoothed = smoothVelocities(velocities, smoothWindow(msPerFrame));
  const takeawayAddressIdx = findSetupEndIndex(smoothed, trail, msPerFrame);
  reliability.takeaway = "medium";

  // Phase 3 — top
  const top = detectDTLTop(trail, takeawayAddressIdx, msPerFrame);
  assumptionsUsed.push("dtl.top");
  if (top.frame == null) {
    return {
      phases: [],
      fallbackGate: "top_search_bounds",
      ruleDebug: {
        detector: "dtl",
        swing_start_frame: swingStart.frame,
        true_address_frame: null,
        reliability,
        external_assumptions_used: assumptionsUsed,
      },
    };
  }
  const topIdx = top.frame;
  reliability.top = "high";

  // Phase 1 — true_address (search backward from top). detectDTLTrueAddress
  // scans FRAMES, so its anchor must be frame-space: map the trail-space
  // topIdx through its timestamp (identity while trail↔frames are 1:1;
  // diverges the moment buildTrailPoints drops a frame). Same pattern as
  // phaseDetectionFaceOn.ts:862-869. Every trail point is built from a frame,
  // so a miss is the same invariant breach the phase assembly throws on below.
  const topTimestamp = trail[topIdx].timestamp;
  const topFrameIdx = frames.findIndex((f) => f.timestampMs === topTimestamp);
  if (topFrameIdx === -1) {
    throw new Error('[HoneySwing] trail timestamp not found in frames — phase fix incomplete');
  }
  const trueAddress = detectDTLTrueAddress(frames, topFrameIdx, msPerFrame);
  reliability.true_address = trueAddress.reliability ?? "low";
  assumptionsUsed.push("dtl.trueAddress");
  // trueAddress.frame is FRAME-space; indices[] below is consumed as
  // trail-space (trail[ti].timestamp). Map back via nearest timestamp — exact
  // at 1:1; nearest covers a true-address frame dropped from the trail
  // (no trail wrist), mirroring the legacy assembly's nearest fallback.
  let addressIdx = takeawayAddressIdx;
  if (trueAddress.frame != null) {
    const targetTs = frames[trueAddress.frame].timestampMs;
    let nearest = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < trail.length; i++) {
      const d = Math.abs(trail[i].timestamp - targetTs);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    }
    addressIdx = nearest;
  }

  // Phase 4 — impact
  const impact = detectDTLImpact(trail, topIdx, msPerFrame);
  assumptionsUsed.push("dtl.impact");
  if (impact.frame == null) {
    return {
      phases: [],
      fallbackGate: "impact_search_bounds",
      ruleDebug: {
        detector: "dtl",
        swing_start_frame: swingStart.frame,
        true_address_frame: trueAddress.frame,
        reliability,
        external_assumptions_used: assumptionsUsed,
      },
    };
  }
  const impactIdx = impact.frame;
  reliability.impact = "high";

  const lastIdx = trail.length - 1;
  const maxImpactDistance = Math.floor(lastIdx * 0.4);
  const actualDistance = impactIdx - topIdx;
  if (actualDistance > maxImpactDistance || actualDistance < 2) {
    return {
      phases: [],
      fallbackGate: "impact_distance_out_of_range",
      ruleDebug: {
        detector: "dtl",
        swing_start_frame: swingStart.frame,
        true_address_frame: trueAddress.frame,
        reliability,
        external_assumptions_used: assumptionsUsed,
      },
    };
  }

  // Takeaway onset is addressIdx (first committed move); synthetic 40% slot removed.
  const downswingIdx = Math.floor(topIdx + (impactIdx - topIdx) * 0.35);

  // Phase 5 — finish
  const finish = detectDTLFinish(trail, topIdx, impactIdx, msPerFrame);
  assumptionsUsed.push("dtl.finish");
  reliability.finish = finish.complete ? "high" : "low";

  const indices = [addressIdx, topIdx, downswingIdx, impactIdx, finish.frame];

  // Temporal sanity: keep parity with legacy gates.
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] <= indices[i - 1]) {
      return {
        phases: [],
        fallbackGate: "temporal_inversion",
        ruleDebug: {
          detector: "dtl",
          swing_start_frame: swingStart.frame,
          true_address_frame: trueAddress.frame,
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
          detector: "dtl",
          swing_start_frame: swingStart.frame,
          true_address_frame: trueAddress.frame,
          reliability,
          external_assumptions_used: assumptionsUsed,
        },
      };
    }
  }

  const phases: DetectedPhase[] = PHASE_ORDER.map((phase, i) => {
    const ti = indices[i]; // trail-space index from trail-based sub-detectors
    const ts = trail[ti].timestamp;
    const frameIdx = frames.findIndex(f => f.timestampMs === ts);
    if (frameIdx === -1) {
      throw new Error('[HoneySwing] trail timestamp not found in frames — phase fix incomplete');
    }
    return {
      phase,
      label: PHASE_LABELS[phase],
      point: trail[ti],
      index: frameIdx,
      timestamp: ts,
      source: "heuristic" as const,
    };
  });

  return {
    phases,
    fallbackGate: null,
    ruleDebug: {
      detector: "dtl",
      swing_start_frame: swingStart.frame,
      true_address_frame: trueAddress.frame,
      reliability,
      external_assumptions_used: assumptionsUsed,
    },
  };
}
