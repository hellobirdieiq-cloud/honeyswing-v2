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
  findTakeawayOnsetFaceOn,
  msToFrames,
  smoothVelocities,
  type FaceOnTakeawayOnset,
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

// phase.index is FRAME-space (canonical). Map a frame's timestamp to its trail point for the
// diagnostic-only `point` field; a wrist-less frame has no trail entry → use the nearest.
function trailPointForFrame(trail: SwingTrailPoint[], frameTs: number): SwingTrailPoint {
  let best = trail[0];
  let bestD = Infinity;
  for (const t of trail) {
    if (t.timestamp === frameTs) return t;
    const d = Math.abs(t.timestamp - frameTs);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

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
// Phase 4 — impact: speed-banded Y-arc-bottom of canonical `leftWrist`.
//
// NAMING: `leftWrist` here is the canonical TRAIL wrist (canonicalTransform.ts
// CANONICAL_TRAIL / M docstring: "label left* is the TRAIL arm"). The TRAIL wrist is the
// empirically-accurate face-on impact joint: across the real RH population its
// arc-bottom agrees with the INDEPENDENT thumb-crossing impact to within Δ0–3
// frames (11/13 thumb-source swings), whereas the LEAD wrist (`rightWrist`) misses
// by up to ~60+ frames (one outlier ~215) and regresses LH gating. The original
// "+9 recoveries" validation (scripts/testLeadWristImpact.ts) measured GATE
// recovery on impact_search_bounds, not impact ACCURACY — hence the prior
// "lead-wrist" misnomer. DO NOT switch this to `rightWrist`; see the joint-choice
// guard in faceOnImpactJoint.test.ts. (Replaced the even older trail-hand
// X-rise-vs-footRef heuristic, which keyed off the wrong axis for face-on.)
// ---------------------------------------------------------------------------

const IMPACT_SPEED_LOOKBACK = 3; // frames; 2D leftWrist displacement window
const IMPACT_PEAK_PERCENTILE = 0.95; // robust max (ignores a single noisy spike)
const IMPACT_BAND_THRESHOLD = 0.9; // band = speed >= threshold * peak

// Exported for faceOnImpactJoint.test.ts (pins the TRAIL-wrist joint choice).
export function detectFaceOnImpact(
  frames: PoseFrame[],
  msPerFrame: number,
): { frame: number | null; reliability: "high" | "medium" | "low" | null } {
  // 2D leftWrist (canonical TRAIL wrist) speed with k-frame lookback; speed[0..k-1]=0,
  // and 0 when either frame's joint is missing. (Mirrors testLeadWristImpact.leadWristSpeed.)
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

  // Impact = the band frame (speed >= threshold*peak) with MAX leftWrist.y (canonical
  // TRAIL wrist — the validated impact joint). y is top-down 0..1, so arc bottom = max y.
  // Restricting the search to the high-speed
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
// Phase 4 (primary) — lead-thumb-line zero-crossing.
// dx = thumbTip.x − thumbCMC.x in PRE-canonical (unmirrored, normalized) space —
// the same x-sign space the rule was validated in (scripts/output/_thumbCrossing.mjs,
// RH swing 81f0b197: crossing 137.5 vs ground truth 137.6). Within [top, follow_through]:
// negative→positive crossings that hold positive thumbHoldFrames consecutive valid frames;
// sub-frame via linear interpolation. Frames where either thumb joint conf < thumbConfMin
// are skipped.
//
// PRIMARY pick = `frameLowY`: the FIRST crossing where BOTH wrists are physically low
// (bottom lowYFraction of their y-range over [top, follow_through]), skipping teleport-
// amplitude dx spikes. This rejects early-transition crossings (81f0b197 first=112.5, wrists
// still high) and follow-through noise (dec6edd1 165.25) that the old LAST pick chased.
// FALLBACK pick = `frame` (LAST crossing) is retained for the selector to use when no low-y
// crossing qualifies or it fails the arc-bottom cross-check (see selectFaceOnImpact).
// [EXTERNAL ASSUMPTION — lowYFraction/lowYZoneWindow/teleportDxAmplitude UNTESTED beyond N=2
//  (dec6edd1→120, 81f0b197→137.x); pinned in scripts/replayThumbImpact.ts.]
//
// Handedness: RH lead hand = LEFT thumb (CMC=leftThumb idx 92, tip=leftThumbTip idx 95),
// neg→pos crossing. LH lead hand = RIGHT thumb (113/116) with the sign FLIPPED (the rule
// was calibrated on RH). The LH thumb path is UNVALIDATED (no LH ground truth) and is
// gated OFF as primary by the caller this ticket; the mapping is built here for later.
// ---------------------------------------------------------------------------

type ThumbCrossingResult = {
  frame: number | null;      // LAST crossing — legacy/fallback pick
  frameLowY: number | null;  // FIRST low-y-gated crossing — primary pick (null if none qualify)
  coverage: number;
  nCrossings: number;
  reason: "ok" | "invalid_window" | "no_crossing";
};

// Low-y zone threshold for a wrist over [lo,hi]: y ≥ min + (1 − lowYFraction)·range. y is
// top-down (0=top,1=bottom) so "physically low" = HIGH y. Null when no finite samples.
function lowWristYThreshold(
  frames: PoseFrame[],
  joint: "leftWrist" | "rightWrist",
  lo: number,
  hi: number,
): number | null {
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = Math.max(0, lo); i <= Math.min(frames.length - 1, hi); i++) {
    const y = frames[i]?.joints[joint]?.y;
    if (y == null || !Number.isFinite(y)) continue;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
  return minY + (1 - A.impact.lowYFraction) * (maxY - minY);
}

// Linear-interpolated wrist y at a fractional frame.
function interpWristY(
  frames: PoseFrame[],
  joint: "leftWrist" | "rightWrist",
  frame: number,
): number | null {
  const f0 = Math.floor(frame);
  if (f0 < 0 || f0 >= frames.length) return null;
  const y0 = frames[f0]?.joints[joint]?.y;
  if (y0 == null || !Number.isFinite(y0)) return null;
  const f1 = Math.min(frames.length - 1, f0 + 1);
  const y1 = frames[f1]?.joints[joint]?.y;
  if (y1 == null || !Number.isFinite(y1)) return y0;
  return y0 + (y1 - y0) * (frame - f0);
}

export function detectFaceOnThumbCrossing(
  preFrames: PoseFrame[],
  topIdx: number,
  followIdx: number,
  isLeftHanded: boolean,
): ThumbCrossingResult {
  const cmcName = isLeftHanded ? "rightThumb" : "leftThumb";
  const tipName = isLeftHanded ? "rightThumbTip" : "leftThumbTip";
  const signFlip = isLeftHanded ? -1 : 1; // LH flips the RH-calibrated sign

  const start = Math.max(0, topIdx);
  const end = Math.min(preFrames.length - 1, followIdx);
  // Defense-in-depth: a degenerate/inverted window (incl. any sentinel followIdx)
  // is reported, never silently coerced to a 0-length search.
  if (end <= start) return { frame: null, frameLowY: null, coverage: 0, nCrossings: 0, reason: "invalid_window" };

  const confMin = A.impact.thumbConfMin;
  const samples: { frame: number; dx: number }[] = [];
  let windowLen = 0;
  for (let i = start; i <= end; i++) {
    windowLen++;
    const f = preFrames[i];
    const cmc = f?.joints[cmcName];
    const tip = f?.joints[tipName];
    if (!cmc || !tip) continue;
    if (!Number.isFinite(cmc.x) || !Number.isFinite(tip.x)) continue;
    if (!((cmc.confidence ?? 0) >= confMin) || !((tip.confidence ?? 0) >= confMin)) continue;
    samples.push({ frame: i, dx: signFlip * (tip.x - cmc.x) });
  }
  const coverage = windowLen > 0 ? samples.length / windowLen : 0;

  // All neg→pos crossings that hold positive thumbHoldFrames consecutive valid frames.
  // Each carries its bounding |dx| amplitude for the teleport-spike guard.
  const hold = A.impact.thumbHoldFrames;
  const crossings: { cross: number; amp: number }[] = [];
  for (let k = 0; k + 1 < samples.length; k++) {
    const a = samples[k];
    const b = samples[k + 1];
    if (!(a.dx < 0 && b.dx > 0)) continue;
    let holds = true;
    for (let h = 1; h < hold; h++) {
      const c = samples[k + 1 + h];
      if (c === undefined) break; // tail of window — accept (mirrors _thumbCrossing.mjs)
      if (!(c.dx > 0)) { holds = false; break; }
    }
    if (!holds) continue;
    const cross = a.frame + ((0 - a.dx) / (b.dx - a.dx)) * (b.frame - a.frame);
    crossings.push({ cross, amp: Math.max(Math.abs(a.dx), Math.abs(b.dx)) });
  }
  // LAST crossing — legacy pick, retained as the selector's fallback.
  const last = crossings.length > 0 ? crossings[crossings.length - 1].cross : null;

  // PRIMARY — FIRST crossing inside the low-y zone (both wrists physically low over
  // [top, follow_through]), skipping teleport-amplitude dx spikes.
  const zoneL = lowWristYThreshold(preFrames, "leftWrist", start, end);
  const zoneR = lowWristYThreshold(preFrames, "rightWrist", start, end);
  let frameLowY: number | null = null;
  if (zoneL != null && zoneR != null) {
    for (const c of crossings) {
      if (c.amp > A.impact.teleportDxAmplitude) continue; // skip teleport spike
      const lwY = interpWristY(preFrames, "leftWrist", c.cross);
      const rwY = interpWristY(preFrames, "rightWrist", c.cross);
      if (lwY != null && rwY != null && lwY >= zoneL && rwY >= zoneR) {
        frameLowY = c.cross;
        break;
      }
    }
  }

  return {
    frame: last,
    frameLowY,
    coverage,
    nCrossings: crossings.length,
    reason: last != null ? "ok" : "no_crossing",
  };
}

// Impact selection: thumb crossing (primary, RH) vs arc-bottom (fallback), with the
// per-swing cross-check. Shared by detectFaceOnPhases and detectFaceOnPhasesDebug so
// the two paths can never drift. Returns the chosen frame + full provenance.
type ImpactSelection = {
  impactIdx: number;
  impactSource: "thumb_crossing" | "arc_bottom";
  impactThumb: number | null;
  impactArcbottom: number;
  impactDelta: number | null;
  impactCrossCheckMismatch: boolean;
  impactFallbackReason: PhaseRuleDebug["impact_fallback_reason"];
  impactReliability: "high" | "medium";
};

export function selectFaceOnImpact(args: {
  arcBottomFrame: number;
  thumb: ThumbCrossingResult | null;
  isLeftHanded: boolean;
  hasPreCanonical: boolean;
  isOverride: boolean;
}): ImpactSelection {
  const { arcBottomFrame, thumb, isLeftHanded, hasPreCanonical, isOverride } = args;
  // Prefer the low-y-gated FIRST crossing when present AND it passes the arc-bottom cross-check;
  // otherwise fall back to the legacy LAST crossing (thumb.frame) + the existing cross-check below.
  // This keeps the old path intact: when no low-y crossing qualifies (or it disagrees egregiously
  // with arc-bottom), behavior is identical to the prior LAST-crossing selector.
  const lowYPasses =
    thumb != null &&
    thumb.frameLowY != null &&
    Math.abs(thumb.frameLowY - arcBottomFrame) <= A.impact.impactRejectDeltaFrames;
  const impactThumb = lowYPasses
    ? thumb!.frameLowY
    : thumb && thumb.frame != null
      ? thumb.frame
      : null;
  const impactArcbottom = arcBottomFrame;
  const impactDelta = impactThumb != null ? impactThumb - impactArcbottom : null;
  const impactCrossCheckMismatch =
    impactDelta != null && Math.abs(impactDelta) > A.impact.crossCheckThresholdFrames;
  // Egregious thumb↔arc-bottom disagreement (> impactRejectDeltaFrames, looser than the
  // reliability-downgrade threshold) rejects the thumb crossing → arc-bottom directly.
  const impactRejectByDelta =
    impactDelta != null && Math.abs(impactDelta) > A.impact.impactRejectDeltaFrames;

  // Precedence: override → LH gate → no pre-canonical → RH thumb (primary) → fallback.
  let impactIdx: number;
  let impactSource: "thumb_crossing" | "arc_bottom";
  let impactFallbackReason: PhaseRuleDebug["impact_fallback_reason"];
  let impactReliability: "high" | "medium" = "medium";

  if (isOverride) {
    impactIdx = arcBottomFrame;
    impactSource = "arc_bottom";
    impactFallbackReason = "override";
  } else if (isLeftHanded) {
    impactIdx = arcBottomFrame;
    impactSource = "arc_bottom";
    impactFallbackReason = "lh_ungated";
  } else if (!hasPreCanonical) {
    impactIdx = arcBottomFrame;
    impactSource = "arc_bottom";
    impactFallbackReason = "no_precanonical";
  } else if (
    thumb &&
    impactThumb != null &&
    thumb.coverage >= A.impact.thumbMinValidCoverage &&
    !impactRejectByDelta
  ) {
    impactIdx = Math.round(impactThumb);
    impactSource = "thumb_crossing";
    // Mild cross-check disagreement (> crossCheckThresholdFrames, ≤ impactRejectDeltaFrames)
    // keeps the thumb frame but downgrades confidence.
    impactReliability = impactCrossCheckMismatch ? "medium" : "high";
  } else {
    impactIdx = arcBottomFrame;
    impactSource = "arc_bottom";
    impactFallbackReason = impactRejectByDelta
      ? "cross_check_mismatch"
      : thumb && thumb.reason === "invalid_window"
        ? "invalid_window"
        : thumb && impactThumb == null
          ? "no_crossing"
          : "low_coverage";
  }

  return {
    impactIdx,
    impactSource,
    impactThumb,
    impactArcbottom,
    impactDelta,
    impactCrossCheckMismatch,
    impactFallbackReason,
    impactReliability,
  };
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
  /**
   * Pre-canonical (unmirrored, normalized) frames — the x-sign space the
   * lead-thumb crossing rule was validated in. When present (and RH), the thumb
   * crossing is the PRIMARY impact; arc-bottom becomes fallback. Absent → arc-bottom.
   */
  preCanonical?: PoseSequence;
  /** Handedness for the thumb lead-hand/sign branch. LH is gated to arc-bottom. */
  isLeftHanded?: boolean;
}): {
  phases: DetectedPhase[];
  fallbackGate: FallbackGate | null;
  ruleDebug: PhaseRuleDebug;
} {
  const { canonical, trail, msPerFrame } = input;
  const frames = canonical.frames;
  const isLeftHanded = input.isLeftHanded ?? false;
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

  // Phase 2 — takeaway address candidate. Body-scaled, reversal-rejecting rule
  // overrides the legacy directional gate when confident; otherwise falls back
  // to the exact findSetupEndIndex value (always computed → fallback path is
  // byte-identical to today). Both spaces are trail-space.
  const velocities = computeTrailVelocities(trail);
  const smoothed = smoothVelocities(velocities, 5);
  const fallbackIdx = findSetupEndIndex(smoothed, trail);
  const takeawayOnset = findTakeawayOnsetFaceOn(trail, frames);
  const takeawayAddressIdx = takeawayOnset.onsetTrailIdx ?? fallbackIdx;
  reliability.takeaway = "medium";

  const trailIdxToFrame = (idx: number | null): number | null => {
    if (idx == null || idx < 0 || idx >= trail.length) return null;
    const f = frames.findIndex((fr) => fr.timestampMs === trail[idx].timestamp);
    return f === -1 ? null : f;
  };
  const takeawayTelemetry = {
    takeaway_path: takeawayOnset.fired
      ? ("body_scaled" as const)
      : ("fallback_gate" as const),
    takeaway_locked_body_height: takeawayOnset.lockedBodyHeight,
    takeaway_body_scaled_frame: trailIdxToFrame(takeawayOnset.onsetTrailIdx),
    takeaway_fallback_idx: trailIdxToFrame(fallbackIdx),
    takeaway_travel_bh: takeawayOnset.travelBH,
    takeaway_fallback_reason: takeawayOnset.fallbackReason,
  };

  // Phase 4 — PROVISIONAL impact (arc-bottom or test override). Used to bound the
  // top/finish search; the thumb crossing (computed below) becomes the final impact
  // for RH swings. impactOverride is a test seam (testLeadWristImpact) and bypasses
  // the thumb primary entirely.
  let arcBottomFrame: number | null;
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
          ...takeawayTelemetry,
        },
      };
    }
    arcBottomFrame = input.impactOverride;
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
          ...takeawayTelemetry,
        },
      };
    }
    arcBottomFrame = impact.frame;
  }

  // Phase 3 — top (uses swing_start and provisional impact for search bounds)
  const topSearchAnchor = swingStart.frame ?? takeawayAddressIdx;
  const top = detectFaceOnTop(frames, topSearchAnchor, arcBottomFrame);
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
        ...takeawayTelemetry,
      },
    };
  }
  const topIdx = top.frame;
  reliability.top = top.reliability ?? "medium";

  // Phase 5 — finish (computed against provisional impact; gives the follow-through
  // window upper bound for the thumb crossing).
  const finish = detectFaceOnFinish(frames, arcBottomFrame, msPerFrame);
  assumptionsUsed.push("faceOn.finish");
  reliability.finish = finish.reliability;

  // Phase 4 (PRIMARY) — lead-thumb-line last zero-crossing within [top, follow_through].
  // Selection precedence: test override → arc-bottom (bypass thumb); LH → arc-bottom
  // (unvalidated thumb path, gated off this ticket); otherwise RH thumb crossing when a
  // qualifying crossing exists and conf coverage is adequate, else arc-bottom fallback.
  const thumb =
    input.impactOverride == null && !isLeftHanded && input.preCanonical
      ? detectFaceOnThumbCrossing(input.preCanonical.frames, topIdx, finish.frame, isLeftHanded)
      : null;
  const selection = selectFaceOnImpact({
    arcBottomFrame,
    thumb,
    isLeftHanded,
    hasPreCanonical: input.preCanonical != null,
    isOverride: input.impactOverride != null,
  });
  const impactIdx = selection.impactIdx;
  const {
    impactSource,
    impactThumb,
    impactArcbottom,
    impactDelta,
    impactCrossCheckMismatch,
    impactFallbackReason,
  } = selection;
  reliability.impact = selection.impactReliability;
  if (impactSource === "thumb_crossing") assumptionsUsed.push("faceOn.impact:thumbCrossing");

  // Phase 1 — takeaway onset (first committed club movement) from findSetupEndIndex.
  // takeawayAddressIdx is a TRAIL-space index; convert to frame-space so phases[].index
  // is canonical and agrees with topIdx/impactIdx.
  const takeawayTimestamp = trail[takeawayAddressIdx].timestamp;
  const takeawayIdx = frames.findIndex(f => f.timestampMs === takeawayTimestamp);
  if (takeawayIdx === -1) {
    throw new Error('[HoneySwing] trail timestamp not found in frames — phase fix incomplete');
  }
  reliability.true_address = "low";

  // Sanity: takeaway must precede top must precede impact (final impact).
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
        ...takeawayTelemetry,
        impact_source: impactSource,
        impact_thumb: impactThumb,
        impact_arcbottom: impactArcbottom,
        impact_delta: impactDelta,
        impact_cross_check_mismatch: impactCrossCheckMismatch,
        impact_fallback_reason: impactFallbackReason,
      },
    };
  }

  const downswingIdx = Math.floor(topIdx + (impactIdx - topIdx) * 0.35);

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
          ...takeawayTelemetry,
          impact_source: impactSource,
          impact_thumb: impactThumb,
          impact_arcbottom: impactArcbottom,
          impact_delta: impactDelta,
          impact_cross_check_mismatch: impactCrossCheckMismatch,
          impact_fallback_reason: impactFallbackReason,
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
          ...takeawayTelemetry,
          impact_source: impactSource,
          impact_thumb: impactThumb,
          impact_arcbottom: impactArcbottom,
          impact_delta: impactDelta,
          impact_cross_check_mismatch: impactCrossCheckMismatch,
          impact_fallback_reason: impactFallbackReason,
        },
      };
    }
  }

  const phases: DetectedPhase[] = PHASE_ORDER.map((phase, i) => {
    const frameIdx = indices[i]; // sub-detectors return FRAME-space indices
    return {
      phase,
      label: PHASE_LABELS[phase],
      point: trailPointForFrame(trail, frames[frameIdx].timestampMs),
      index: frameIdx,
      timestamp: frames[frameIdx].timestampMs,
      source: "heuristic" as const,
    };
  });

  return {
    phases,
    fallbackGate: null,
    ruleDebug: {
      detector: "face_on",
      swing_start_frame: swingStart.frame,
      true_address_frame: null,
      reliability,
      external_assumptions_used: assumptionsUsed,
      ...takeawayTelemetry,
      impact_source: impactSource,
      impact_thumb: impactThumb,
      impact_arcbottom: impactArcbottom,
      impact_delta: impactDelta,
      impact_cross_check_mismatch: impactCrossCheckMismatch,
      impact_fallback_reason: impactFallbackReason,
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
  // Impact provenance + cross-check (mirrors detectFaceOnPhases via selectFaceOnImpact).
  impactSource: "thumb_crossing" | "arc_bottom" | null;
  impactThumb: number | null;
  impactArcbottom: number | null;
  impactDelta: number | null;
  impactCrossCheckMismatch: boolean | null;
  impactFallbackReason: PhaseRuleDebug["impact_fallback_reason"] | null;
  // Body-scaled, reversal-rejecting takeaway gate (mirrors detectFaceOnPhases).
  takeawayPath: "body_scaled" | "fallback_gate" | null;
  takeawayLockedBodyHeight: number | null;
  takeawayBodyScaledFrame: number | null;
  takeawayFallbackIdx: number | null;
  takeawayTravelBH: number | null;
  takeawayFallbackReason: FaceOnTakeawayOnset["fallbackReason"];
  triggerA: { fired: boolean; condition: string };
  triggerB: { fired: boolean; offendingPair: string | null };
  wouldFallbackGate: FallbackGate | null;
};

export function detectFaceOnPhasesDebug(input: {
  canonical: PoseSequence;
  trail: SwingTrailPoint[];
  msPerFrame: number;
  /** Pre-canonical frames + handedness — same as detectFaceOnPhases. When present
   * (and RH), the thumb crossing is the primary impact; absent → arc-bottom. */
  preCanonical?: PoseSequence;
  isLeftHanded?: boolean;
}): FaceOnPhasesDebugResult {
  const { canonical, trail, msPerFrame } = input;
  const frames = canonical.frames;
  const isLeftHanded = input.isLeftHanded ?? false;

  const result: FaceOnPhasesDebugResult = {
    swingStartFrame: null,
    takeawayAddressIdx: null,
    addressIdx: null,
    takeawayIdx: null,
    topIdx: null,
    downswingIdx: null,
    impactIdx: null,
    finishFrame: null,
    impactSource: null,
    impactThumb: null,
    impactArcbottom: null,
    impactDelta: null,
    impactCrossCheckMismatch: null,
    impactFallbackReason: null,
    takeawayPath: null,
    takeawayLockedBodyHeight: null,
    takeawayBodyScaledFrame: null,
    takeawayFallbackIdx: null,
    takeawayTravelBH: null,
    takeawayFallbackReason: null,
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
  const fallbackIdx = findSetupEndIndex(smoothed, trail);
  const takeawayOnset = findTakeawayOnsetFaceOn(trail, frames);
  const takeawayAddressIdx = takeawayOnset.onsetTrailIdx ?? fallbackIdx;
  result.takeawayAddressIdx = takeawayAddressIdx;
  result.addressIdx = takeawayAddressIdx;

  const trailIdxToFrame = (idx: number | null): number | null => {
    if (idx == null || idx < 0 || idx >= trail.length) return null;
    const f = frames.findIndex((fr) => fr.timestampMs === trail[idx].timestamp);
    return f === -1 ? null : f;
  };
  result.takeawayPath = takeawayOnset.fired ? "body_scaled" : "fallback_gate";
  result.takeawayLockedBodyHeight = takeawayOnset.lockedBodyHeight;
  result.takeawayBodyScaledFrame = trailIdxToFrame(takeawayOnset.onsetTrailIdx);
  result.takeawayFallbackIdx = trailIdxToFrame(fallbackIdx);
  result.takeawayTravelBH = takeawayOnset.travelBH;
  result.takeawayFallbackReason = takeawayOnset.fallbackReason;

  // Provisional arc-bottom impact (bounds top/finish search).
  const impact = detectFaceOnImpact(frames, msPerFrame);

  if (impact.frame == null) {
    result.wouldFallbackGate = "impact_search_bounds";
    return result;
  }
  const arcBottomFrame = impact.frame;

  const topSearchAnchor = swingStart.frame ?? takeawayAddressIdx;
  const top = detectFaceOnTop(frames, topSearchAnchor, arcBottomFrame);
  result.topIdx = top.frame;

  if (top.frame == null) {
    result.impactIdx = arcBottomFrame; // best available before the gate
    result.wouldFallbackGate = "top_search_bounds";
    return result;
  }

  const takeawayIdx = takeawayAddressIdx;
  const topIdx = top.frame;

  // Finish bounds the thumb window; computed against provisional impact.
  const finish = detectFaceOnFinish(frames, arcBottomFrame, msPerFrame);
  result.finishFrame = finish.frame;

  // Final impact: thumb crossing (RH, primary) vs arc-bottom (fallback) — shared selector.
  const thumb =
    !isLeftHanded && input.preCanonical
      ? detectFaceOnThumbCrossing(input.preCanonical.frames, topIdx, finish.frame, isLeftHanded)
      : null;
  const selection = selectFaceOnImpact({
    arcBottomFrame,
    thumb,
    isLeftHanded,
    hasPreCanonical: input.preCanonical != null,
    isOverride: false,
  });
  const impactIdx = selection.impactIdx;
  result.impactIdx = impactIdx;
  result.impactSource = selection.impactSource;
  result.impactThumb = selection.impactThumb;
  result.impactArcbottom = selection.impactArcbottom;
  result.impactDelta = selection.impactDelta;
  result.impactCrossCheckMismatch = selection.impactCrossCheckMismatch;
  result.impactFallbackReason = selection.impactFallbackReason;

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
