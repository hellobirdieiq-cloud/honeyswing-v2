/**
 * phaseDetectionFaceOn.ts — face-on camera phase detection per
 * docs/HoneySwing_Phase_Detection_Rules.md (Face-On Phase 0, 2, 3, 4, 5).
 *
 * Phase 1 (true_address) is NOT validated face-on per spec doc; we fall
 * back to the takeaway directional gate's start-of-window address frame
 * (matches legacy behavior and keeps tempo math consistent).
 */

import type { JointName, PoseFrame, PoseSequence } from "../../pose/PoseTypes";
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
  smoothWindow,
  type FaceOnImpactConsensusShadow,
  type FaceOnTakeawayOnset,
  type FaceOnTopXExtreme,
  type PhaseRuleDebug,
  type PhaseRuleReliability,
} from "./phaseDetectionShared";
import {
  computeFaceOnImpactConsensus,
  type FaceOnImpactConsensus,
} from "./faceOnImpactConsensus";

const A = EXTERNAL_ASSUMPTIONS.faceOn;

// ---------------------------------------------------------------------------
// Shadow xCross CONSENSUS impact (PR1) — computed beside the live impact, never feeds impactIdx.
// Runs the ported viewer pipeline (faceOnImpactConsensus) over [topIdx, topIdx + downswingBudget]
// on the PRE-CANONICAL frames (the raw/un-mirrored x-sign space the rule was validated in). The
// BUDGET window (not [topIdx, follow_through]) is the viewer's validated design — the stored/derived
// finish is anchored on the broken arc-bottom and either truncates before the true impact
// (9d1606a6) or over-widens past it onto follow-through decoys (e212431b). Returns null when
// preCanonical is absent (no behavior change for those swings).
// ---------------------------------------------------------------------------

function toImpactConsensusShadow(r: FaceOnImpactConsensus): FaceOnImpactConsensusShadow {
  return {
    final: r.final,
    source: r.source,
    consensus: r.consensus,
    provAnchor: r.provAnchor,
    anchor: r.anchor,
    s1: r.s1.frame,
    s2: r.s2.frame,
    s3: r.s3.frame,
    footPick: r.footPick.frame,
    xCross: r.xCross,
    thumbQualifies: r.thumb.qualifies,
    signFlip: r.signFlip,
    lowReliability: r.lowReliability,
    window: r.window,
  };
}

function computeImpactConsensus(
  preCanonical: PoseSequence | undefined,
  topIdx: number,
  isLeftHanded: boolean,
  msPerFrame: number,
): FaceOnImpactConsensus | null {
  if (!preCanonical) return null;
  // hi is clamped to the array inside computeFaceOnImpactConsensus.
  const hi = topIdx + msToFrames(A.impact.consensus.downswingBudgetMs, msPerFrame);
  return computeFaceOnImpactConsensus({ frames: preCanonical.frames, lo: topIdx, hi, isLeftHanded, msPerFrame });
}

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
  if (frames.length < msToFrames(A.swingStart.baselineWindowMs, msPerFrame)) return { frame: null, reliability: null };

  const avg: (number | null)[] = new Array(frames.length).fill(null);
  for (let i = 1; i < frames.length; i++) {
    const v1 = jointVelocity(frames[i - 1], frames[i], "rightWrist");
    const v2 = jointVelocity(frames[i - 1], frames[i], "leftWrist");
    const v3 = jointVelocity(frames[i - 1], frames[i], "leftShoulder");
    if (v1 == null || v2 == null || v3 == null) continue;
    avg[i] = (v1 + v2 + v3) / 3;
  }

  // Baseline: mean of the N lowest avg values within the first window frames.
  const window = Math.min(msToFrames(A.swingStart.baselineWindowMs, msPerFrame), avg.length - 1);
  const baselineCandidates: number[] = [];
  for (let i = 1; i <= window; i++) {
    if (avg[i] != null) baselineCandidates.push(avg[i] as number);
  }
  if (baselineCandidates.length < 5) return { frame: null, reliability: null };
  baselineCandidates.sort((a, b) => a - b);
  // 1c A2: baseline = mean of the calmest FRACTION of the window (baselineLowestN/baselineWindowFrames
  // = 20/30 ≈ ⅔), rate-independent, clamped to [floor, candidates]. At 60fps window=30 → 20 (unchanged).
  // EXTERNAL ASSUMPTION — the min-sample floor (10) is unvalidated; chosen to keep the baseline mean
  // statistically usable on short/poor-tracking windows. Revisit at clinic calibration.
  const takeN = Math.min(Math.max(Math.round(window * A.swingStart.baselineLowestN / A.swingStart.baselineWindowFrames), 10), baselineCandidates.length);
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

const IMPACT_SPEED_LOOKBACK_MS = 50; // 2D leftWrist displacement window (3 frames @ 60fps)
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
  const lookback = Math.max(1, msToFrames(IMPACT_SPEED_LOOKBACK_MS, msPerFrame));
  const speed = new Array<number>(n).fill(0);
  for (let f = lookback; f < n; f++) {
    const a = frames[f - lookback].joints.leftWrist;
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
// was calibrated on RH). The LH thumb path is VALIDATED on real left-handed swings and
// runs as primary (enabled in 555adff), same as RH.
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
  // 1b-2: capture rate for the hold window (60fps fallback; the sole caller is a diagnostic script).
  msPerFrame?: number,
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
  const hold = msPerFrame != null ? msToFrames(A.impact.thumbHoldMs, msPerFrame) : A.impact.thumbHoldFrames;
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

// Impact selection: xCross consensus (primary, both handedness) vs arc-bottom (fallback),
// with the per-swing cross-check. Shared by detectFaceOnPhases and detectFaceOnPhasesDebug
// so the two paths can never drift. Returns the chosen frame + full provenance.
type ImpactSelection = {
  impactIdx: number;
  impactSource: "consensus" | "arc_bottom";
  impactConsensusFinal: number | null; // sub-frame consensus FINAL used (null if not computed/none)
  impactArcbottom: number;
  impactDelta: number | null; // round(consensusFinal) − arcBottom (cross-check vs the old detector)
  impactCrossCheckMismatch: boolean;
  impactFallbackReason: PhaseRuleDebug["impact_fallback_reason"];
  impactReliability: "high" | "medium" | "low";
};

// PR2 cutover — the ported xCross CONSENSUS (faceOnImpactConsensus) is now the PRIMARY face-on
// impact. Arc-bottom is the per-reason FALLBACK only; it never wins when the consensus resolves.
// Precedence: override → no pre-canonical → consensus-null → CONSENSUS (both handedness —
// the LH gate was removed once the signFlip=-1 path validated).
// The arc-bottom↔consensus cross-check is a FLAG (downgrade), never a rejection — the consensus is
// validated and is trusted when it resolves. Every fallback carries reliability.impact = "low" so
// downstream can suppress a confident score (see the convergence ticket).
export function selectFaceOnImpact(args: {
  arcBottomFrame: number;
  consensus: FaceOnImpactConsensus | null;
  isLeftHanded: boolean;
  hasPreCanonical: boolean;
  isOverride: boolean;
  // 1b-2: capture rate for the cross-check tolerance (60fps fallback when absent; tests omit it).
  msPerFrame?: number;
}): ImpactSelection {
  const { arcBottomFrame, consensus, isLeftHanded, hasPreCanonical, isOverride, msPerFrame } = args;
  const impactArcbottom = arcBottomFrame;
  const finalSub = consensus?.final ?? null;
  const finalRounded = finalSub != null ? Math.round(finalSub) : null;
  const impactDelta = finalRounded != null ? finalRounded - impactArcbottom : null;
  const crossCheckTol = msPerFrame != null
    ? msToFrames(A.impact.crossCheckThresholdMs, msPerFrame)
    : A.impact.crossCheckThresholdFrames;
  const impactCrossCheckMismatch =
    impactDelta != null && Math.abs(impactDelta) > crossCheckTol;

  // Arc-bottom fallback — preserves today's graceful behavior; reliability LOW so a low-credibility
  // impact can be suppressed downstream. final/delta still logged for provenance.
  const fallback = (reason: PhaseRuleDebug["impact_fallback_reason"]): ImpactSelection => ({
    impactIdx: arcBottomFrame,
    impactSource: "arc_bottom",
    impactConsensusFinal: finalSub,
    impactArcbottom,
    impactDelta,
    impactCrossCheckMismatch,
    impactFallbackReason: reason,
    impactReliability: "low",
  });

  if (isOverride) return fallback("override"); // test seam (impactOverride) bypasses the consensus
  // LH gate removed: the LH sign path (signFlip=-1) is validated, so LH runs the consensus exactly
  // like RH. A LH swing whose consensus is null still falls through to no_precanonical / no_signals.
  if (!hasPreCanonical || consensus == null) return fallback("no_precanonical");
  if (finalSub == null) return fallback("no_signals"); // 0 geometric signals → consensus null

  // CONSENSUS PRIMARY. Cross-check disagreement with arc-bottom downgrades confidence (flag), but
  // never rejects: the consensus is the validated signal.
  return {
    impactIdx: finalRounded as number,
    impactSource: "consensus",
    impactConsensusFinal: finalSub,
    impactArcbottom,
    impactDelta,
    impactCrossCheckMismatch,
    impactFallbackReason: undefined,
    impactReliability: impactCrossCheckMismatch ? "medium" : "high",
  };
}

// ---------------------------------------------------------------------------
// Phase 3 — top of backswing (consensus across velocity min, z max, shoulder x min)
// ---------------------------------------------------------------------------

function detectFaceOnTop(
  frames: PoseFrame[],
  swingStartIdx: number,
  impactIdx: number,
  msPerFrame: number,
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

  const window = msToFrames(A.top.consensusWindowMs, msPerFrame);
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
// Phase 3 (SHADOW) — X-extreme top. Parallel-computed beside detectFaceOnTop for
// ground-truth validation; NOT wired as the real top this phase.
//
// top = round(mean of the MAX-canonical-x frames) of 3 canonical LEAD landmarks
// (nose, rightShoulder, rightEar). MAX x for BOTH handedness — canonicalization
// normalizes lefty/righty to the same direction (measured: RH 16c98eeb MAX@~85,
// LH d5084eb5 MAX@~98), so no isLeftHanded branch (same as detectFaceOnTop, which
// hardcodes canonical lead = right*). Window anchors on swingStart + the
// INDEPENDENT arc-bottom impact → non-circular. Owns its own search fractions
// (A.topXExtreme) so the live rule's baseline is untouched.
// ---------------------------------------------------------------------------

const TOP_XEXTREME_LEAD: { key: keyof FaceOnTopXExtreme["perLandmark"]; joint: JointName }[] = [
  { key: "nose", joint: "nose" },
  { key: "leadShoulder", joint: "rightShoulder" },
  { key: "leadEar", joint: "rightEar" },
];

function detectFaceOnTopXExtreme(
  frames: PoseFrame[],
  swingStartIdx: number,
  impactIdx: number,
  msPerFrame: number,
): FaceOnTopXExtreme {
  const empty: FaceOnTopXExtreme = {
    frame: null,
    mean: null,
    reliability: null,
    perLandmark: { nose: null, leadShoulder: null, leadEar: null },
    median: null,
    spread: null,
    window: null,
  };

  const totalSpan = impactIdx - swingStartIdx;
  if (totalSpan < 6) return empty;

  const from = swingStartIdx + Math.round(totalSpan * A.topXExtreme.searchStartFraction);
  const to = impactIdx - Math.round(totalSpan * A.topXExtreme.searchEndFraction);
  if (to <= from) return empty;

  const minConf = A.topXExtreme.minConfidence;
  const perLandmark: FaceOnTopXExtreme["perLandmark"] = { nose: null, leadShoulder: null, leadEar: null };

  // Per landmark: frame of MAX canonical x within [from, to], gated on confidence.
  // Strict > keeps the FIRST occurrence on a flat plateau (defined tie-break).
  for (const { key, joint } of TOP_XEXTREME_LEAD) {
    let bestFi: number | null = null;
    let bestX = -Infinity;
    for (let F = from; F <= to; F++) {
      const j = frames[F].joints[joint];
      if (!j || (j.confidence ?? 0) < minConf) continue;
      if (j.x > bestX) {
        bestX = j.x;
        bestFi = F;
      }
    }
    perLandmark[key] = bestFi;
  }

  const picks = [perLandmark.nose, perLandmark.leadShoulder, perLandmark.leadEar].filter(
    (v): v is number => v != null,
  );
  if (picks.length === 0) return { ...empty, window: { from, to } };

  const mean = picks.reduce((s, v) => s + v, 0) / picks.length;
  const sorted = [...picks].sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
  const spread = sorted[sorted.length - 1] - sorted[0];

  // Reliability mirrors detectFaceOnTop's tiering: all 3 present and tightly
  // clustered = high; ≥2 = medium; a single landmark = low.
  const reliability: "high" | "medium" | "low" =
    picks.length === 3 && spread <= msToFrames(A.top.consensusWindowMs, msPerFrame)
      ? "high"
      : picks.length >= 2
        ? "medium"
        : "low";

  return {
    // MEDIAN is the combined pick — robust to a single drifting landmark (the LH
    // nose pulls the mean late/early; median ignores it). mean kept in `mean` for
    // comparison only.
    frame: median,
    mean: Math.round(mean),
    reliability,
    perLandmark,
    median,
    spread,
    window: { from, to },
  };
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

  const W = msToFrames(A.finish.rollingWindowMs, msPerFrame);
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
    // Full nominal window AND every sample present. The interior span is
    // 2·floor(W/2)+1: equal to W when W is odd (60fps), W+1 when W is even
    // (120fps) — the old `count === W` could never match an even-W interior
    // window, nulling the whole rolling series. Edge-clamped windows
    // (span < W) keep failing, exactly as before.
    const span = hi - lo + 1;
    return span >= W && count === span ? sum / count : null;
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
// Shared sequence core — single source of truth for BOTH entry points
// (efficiency-audit Fix 8). detectFaceOnPhases (gated production) and
// detectFaceOnPhasesDebug (scripts harness) previously hand-mirrored ~160
// lines that had to be kept in lockstep by hand; both now run THIS sequence
// and only format its state. The two REAL behavioral divergences are explicit
// flags instead of drifting copies:
//   - impactOverride: production-only test seam (scripts/testLeadWristImpact);
//     the Debug entry never passes it, matching the old Debug body.
//   - salvageTrailMiss: on the trail-timestamp invariant breach production
//     THROWS (captureProcessing catches it as dev telemetry) while the Debug
//     harness substitutes the trail-space index so corpus scripts keep
//     producing rows for breach-y swings.
// The sequence, gate order, reliability/assumption mutation order, and
// short-circuit points are byte-identical to the pre-refactor production body
// (locked by phaseDetectionFaceOn.test.ts + the corpus-replay byte-diff).
// ---------------------------------------------------------------------------

/** Which gate stopped the sequence — distinguishes the two temporal_inversion
 * sites because their production ruleDebug shapes differ (trigger_a omits the
 * top fields; the ladder includes them). */
type FaceOnGateStage =
  | "points"
  | "impact_search"
  | "top_search"
  | "trigger_a"
  | "ladder"
  | "bunched";

type FaceOnTakeawayTelemetry = {
  takeaway_path: "body_scaled" | "fallback_gate";
  takeaway_locked_body_height: number | null;
  takeaway_body_scaled_frame: number | null;
  takeaway_fallback_idx: number | null;
  takeaway_travel_bh: number | null;
  takeaway_fallback_reason: FaceOnTakeawayOnset["fallbackReason"];
};

type FaceOnSequenceState = {
  gate: FallbackGate | null;
  gateStage: FaceOnGateStage | null;
  swingStart: { frame: number | null; reliability: "high" | "medium" | "low" | null };
  /** TRAIL-space; null only when the points gate fired before any compute. */
  takeawayAddressIdx: number | null;
  takeawayTelemetry: FaceOnTakeawayTelemetry | null;
  /** Frame-space takeaway (salvaged from trail-space in salvageTrailMiss mode). */
  takeawayIdx: number | null;
  arcBottomFrame: number | null;
  topVelMinShadow: number | null;
  topXExtreme: FaceOnTopXExtreme | null;
  topIdx: number | null;
  consensusShadow: FaceOnImpactConsensusShadow | null;
  selection: ImpactSelection | null;
  impactIdx: number | null;
  finish: { frame: number; reliability: "high" | "medium" | "low" } | null;
  downswingIdx: number | null;
  triggerA: { fired: boolean; condition: string };
  triggerB: { fired: boolean; offendingPair: string | null };
  reliability: PhaseRuleReliability;
  assumptionsUsed: string[];
};

function runFaceOnPhaseSequence(input: {
  canonical: PoseSequence;
  trail: SwingTrailPoint[];
  msPerFrame: number;
  preCanonical?: PoseSequence;
  isLeftHanded: boolean;
  impactOverride?: number;
  salvageTrailMiss: boolean;
}): FaceOnSequenceState {
  const { canonical, trail, msPerFrame } = input;
  const frames = canonical.frames;

  const state: FaceOnSequenceState = {
    gate: null,
    gateStage: null,
    swingStart: { frame: null, reliability: null },
    takeawayAddressIdx: null,
    takeawayTelemetry: null,
    takeawayIdx: null,
    arcBottomFrame: null,
    topVelMinShadow: null,
    topXExtreme: null,
    topIdx: null,
    consensusShadow: null,
    selection: null,
    impactIdx: null,
    finish: null,
    downswingIdx: null,
    triggerA: { fired: false, condition: "n/a (missing indices)" },
    triggerB: { fired: false, offendingPair: null },
    reliability: emptyReliability(),
    assumptionsUsed: [],
  };
  const gate = (g: FallbackGate, stage: FaceOnGateStage): FaceOnSequenceState => {
    state.gate = g;
    state.gateStage = stage;
    return state;
  };

  if (trail.length < 6) {
    return gate("points_too_short", "points");
  }

  // Phase 0 — swing_start
  state.swingStart = detectFaceOnSwingStart(frames, msPerFrame);
  state.reliability.swing_start = state.swingStart.reliability;
  state.assumptionsUsed.push("faceOn.swingStart");

  // Phase 2 — takeaway address candidate. Body-scaled, reversal-rejecting rule
  // overrides the legacy directional gate when confident; otherwise falls back
  // to the exact findSetupEndIndex value (always computed → fallback path is
  // byte-identical). Both spaces are trail-space.
  const velocities = computeTrailVelocities(trail);
  const smoothed = smoothVelocities(velocities, smoothWindow(msPerFrame));
  const fallbackIdx = findSetupEndIndex(smoothed, trail, msPerFrame);
  const takeawayOnset = findTakeawayOnsetFaceOn(trail, frames, msPerFrame);
  const takeawayAddressIdx = takeawayOnset.onsetTrailIdx ?? fallbackIdx;
  state.takeawayAddressIdx = takeawayAddressIdx;
  state.reliability.takeaway = "medium";

  const trailIdxToFrame = (idx: number | null): number | null => {
    if (idx == null || idx < 0 || idx >= trail.length) return null;
    const f = frames.findIndex((fr) => fr.timestampMs === trail[idx].timestamp);
    return f === -1 ? null : f;
  };
  state.takeawayTelemetry = {
    takeaway_path: takeawayOnset.fired
      ? ("body_scaled" as const)
      : ("fallback_gate" as const),
    takeaway_locked_body_height: takeawayOnset.lockedBodyHeight,
    takeaway_body_scaled_frame: trailIdxToFrame(takeawayOnset.onsetTrailIdx),
    takeaway_fallback_idx: trailIdxToFrame(fallbackIdx),
    takeaway_travel_bh: takeawayOnset.travelBH,
    takeaway_fallback_reason: takeawayOnset.fallbackReason,
  };

  // Phase 1 (frame-space) — takeaway onset. takeawayAddressIdx is a TRAIL-space index;
  // map it to frame-space via timestamp so it can anchor the top search and so phases[].index
  // agrees with topIdx/impactIdx. Computed here (before the top search) because the top window
  // anchors on the takeaway instead of the late-prone swingStart.
  const takeawayTimestamp = trail[takeawayAddressIdx].timestamp;
  let takeawayIdx = frames.findIndex((f) => f.timestampMs === takeawayTimestamp);
  if (takeawayIdx === -1) {
    if (!input.salvageTrailMiss) {
      throw new Error('[HoneySwing] trail timestamp not found in frames — phase fix incomplete');
    }
    takeawayIdx = takeawayAddressIdx; // harness salvage — old Debug `?? takeawayAddressIdx`
  }
  state.takeawayIdx = takeawayIdx;

  // Phase 4 — PROVISIONAL impact (arc-bottom or test override). Bounds the
  // top/finish search; the consensus (below) becomes the final impact.
  let arcBottomFrame: number;
  if (input.impactOverride != null) {
    // Required range [0, frames.length-1]: detectFaceOnTop's search bound
    // `to = impactIdx - toOffset` indexes frames[F] for F <= to <= impactIdx, so an
    // out-of-ARRAY override would read past the array. Out-of-ORDER but in-array
    // values are safe — the top_search_bounds / temporal_inversion gates handle them.
    if (input.impactOverride < 0 || input.impactOverride > frames.length - 1) {
      return gate("impact_search_bounds", "impact_search");
    }
    arcBottomFrame = input.impactOverride;
    state.assumptionsUsed.push("faceOn.impact:override");
  } else {
    const impact = detectFaceOnImpact(frames, msPerFrame);
    state.assumptionsUsed.push("faceOn.impact");
    if (impact.frame == null) {
      return gate("impact_search_bounds", "impact_search");
    }
    arcBottomFrame = impact.frame;
  }
  state.arcBottomFrame = arcBottomFrame;

  // Phase 3 — top of backswing. PRIMARY = median X-extreme (rotational top), anchored on
  // the frame-mapped takeaway and the provisional arc-bottom. The legacy velocity-min rule
  // (detectFaceOnTop) is retained as a logged shadow only (top_velmin_shadow).
  const topSearchAnchor = takeawayIdx;
  const topVelMin = detectFaceOnTop(frames, topSearchAnchor, arcBottomFrame, msPerFrame); // shadow only
  const topXExtreme = detectFaceOnTopXExtreme(frames, topSearchAnchor, arcBottomFrame, msPerFrame);
  state.topVelMinShadow = topVelMin.frame;
  state.topXExtreme = topXExtreme;
  state.assumptionsUsed.push("faceOn.top");
  if (topXExtreme.frame == null) {
    return gate("top_search_bounds", "top_search");
  }
  const topIdx = topXExtreme.frame;
  state.topIdx = topIdx;
  state.reliability.top = topXExtreme.reliability ?? "medium";

  // Phase 4 (PRIMARY) — xCross CONSENSUS impact over [topIdx, topIdx+downswingBudget] on
  // preCanonical (the raw/un-mirrored x-sign space it was validated in). Arc-bottom is the
  // per-reason fallback only; see selectFaceOnImpact.
  const consensus =
    input.impactOverride == null
      ? computeImpactConsensus(input.preCanonical, topIdx, input.isLeftHanded, msPerFrame)
      : null;
  state.consensusShadow = consensus ? toImpactConsensusShadow(consensus) : null;
  const selection = selectFaceOnImpact({
    arcBottomFrame,
    consensus,
    isLeftHanded: input.isLeftHanded,
    hasPreCanonical: input.preCanonical != null,
    isOverride: input.impactOverride != null,
    msPerFrame,
  });
  state.selection = selection;
  const impactIdx = selection.impactIdx;
  state.impactIdx = impactIdx;
  state.reliability.impact = selection.impactReliability;
  if (selection.impactSource === "consensus") state.assumptionsUsed.push("faceOn.impact:consensus");

  // Phase 5 — finish, RE-ANCHORED on the FINAL impact (not the provisional arc-bottom),
  // so a corrected impact later than the old arc-bottom-anchored finish does not trip
  // the impact<finish monotonicity gate (e.g. 9d1606a6: impact 125 vs old finish 103).
  const finish = detectFaceOnFinish(frames, impactIdx, msPerFrame);
  state.finish = finish;
  state.assumptionsUsed.push("faceOn.finish");
  state.reliability.finish = finish.reliability;

  state.reliability.true_address = "low";

  // Sanity: takeaway must precede top must precede impact (final impact).
  const triggerAOk = takeawayIdx < topIdx && topIdx < impactIdx;
  state.triggerA = {
    fired: !triggerAOk,
    condition: `${takeawayIdx} < ${topIdx} < ${impactIdx} = ${triggerAOk}`,
  };
  if (!triggerAOk) {
    return gate("temporal_inversion", "trigger_a");
  }

  const downswingIdx = Math.floor(topIdx + (impactIdx - topIdx) * 0.35);
  state.downswingIdx = downswingIdx;

  const indices = [takeawayIdx, topIdx, downswingIdx, impactIdx, finish.frame];
  const labels = ["takeaway", "top", "downswing", "impact", "follow_through"];
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] <= indices[i - 1]) {
      state.triggerB = {
        fired: true,
        offendingPair: `${labels[i - 1]}=${indices[i - 1]} >= ${labels[i]}=${indices[i]}`,
      };
      return gate("temporal_inversion", "ladder");
    }
  }
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] - indices[i - 1] < 2) {
      return gate("phases_too_bunched", "bunched");
    }
  }

  return state;
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
  const { canonical, trail } = input;
  const frames = canonical.frames;

  const s = runFaceOnPhaseSequence({
    canonical,
    trail,
    msPerFrame: input.msPerFrame,
    preCanonical: input.preCanonical,
    isLeftHanded: input.isLeftHanded ?? false,
    impactOverride: input.impactOverride,
    salvageTrailMiss: false, // production semantics: trail-timestamp miss THROWS
  });

  // ruleDebug assembly — field inclusion depends on how far the sequence got,
  // preserving the exact pre-refactor per-gate shapes (points gate carries no
  // takeaway telemetry; trigger_a carries impact but not top fields; the
  // ladder/bunched gates and success carry everything).
  const base = {
    detector: "face_on" as const,
    swing_start_frame: s.swingStart.frame,
    true_address_frame: null,
    reliability: s.reliability,
    external_assumptions_used: s.assumptionsUsed,
  };
  const topFields = {
    top_x_extreme: s.topXExtreme ?? undefined,
    top_velmin_shadow: s.topVelMinShadow,
  };
  const impactFields = s.selection
    ? {
        impact_source: s.selection.impactSource,
        impact_consensus_final: s.selection.impactConsensusFinal,
        impact_arcbottom: s.selection.impactArcbottom,
        impact_delta: s.selection.impactDelta,
        impact_cross_check_mismatch: s.selection.impactCrossCheckMismatch,
        impact_fallback_reason: s.selection.impactFallbackReason,
        impact_consensus: s.consensusShadow,
      }
    : null;

  if (s.gate) {
    const ruleDebug: PhaseRuleDebug = {
      ...base,
      ...(s.gateStage !== "points" ? s.takeawayTelemetry : null),
      ...(s.gateStage === "trigger_a" || s.gateStage === "ladder" || s.gateStage === "bunched"
        ? impactFields
        : null),
      ...(s.gateStage === "top_search" || s.gateStage === "ladder" || s.gateStage === "bunched"
        ? topFields
        : null),
    };
    return { phases: [], fallbackGate: s.gate, ruleDebug };
  }

  const indices = [s.takeawayIdx!, s.topIdx!, s.downswingIdx!, s.impactIdx!, s.finish!.frame];
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
      ...base,
      ...s.takeawayTelemetry,
      ...impactFields,
      ...topFields,
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
  // Shadow X-extreme top (Phase 2 parallel compute; mirrors detectFaceOnPhases).
  topXExtreme: FaceOnTopXExtreme | null;
  // Shadow velocity-min top (legacy rule, retained for comparison; mirrors detectFaceOnPhases).
  topVelMinShadow: number | null;
  // Impact provenance + cross-check (mirrors detectFaceOnPhases via selectFaceOnImpact).
  impactSource: "consensus" | "arc_bottom" | null;
  impactConsensusFinal: number | null;
  impactArcbottom: number | null;
  impactDelta: number | null;
  impactCrossCheckMismatch: boolean | null;
  impactFallbackReason: PhaseRuleDebug["impact_fallback_reason"] | null;
  // Shadow xCross CONSENSUS impact (PR1 — computed over [topIdx, follow_through] on preCanonical;
  // null when preCanonical absent). Does NOT feed impactIdx; the validation harness reads this.
  impactConsensus: FaceOnImpactConsensusShadow | null;
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
  const s = runFaceOnPhaseSequence({
    canonical: input.canonical,
    trail: input.trail,
    msPerFrame: input.msPerFrame,
    preCanonical: input.preCanonical,
    isLeftHanded: input.isLeftHanded ?? false,
    // No impactOverride (parity with the old Debug body) and salvage the
    // trail-timestamp miss instead of throwing so corpus scripts keep
    // producing rows for breach-y swings.
    salvageTrailMiss: true,
  });

  const result: FaceOnPhasesDebugResult = {
    swingStartFrame: null,
    takeawayAddressIdx: null,
    addressIdx: null,
    takeawayIdx: null,
    topIdx: null,
    downswingIdx: null,
    impactIdx: null,
    finishFrame: null,
    topXExtreme: null,
    topVelMinShadow: null,
    impactConsensus: null,
    impactSource: null,
    impactConsensusFinal: null,
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
    triggerA: s.triggerA,
    triggerB: s.triggerB,
    wouldFallbackGate: s.gate,
  };

  if (s.gateStage === "points") return result; // nothing else ran

  result.swingStartFrame = s.swingStart.frame;
  result.takeawayAddressIdx = s.takeawayAddressIdx;
  result.addressIdx = s.takeawayAddressIdx;
  if (s.takeawayTelemetry) {
    result.takeawayPath = s.takeawayTelemetry.takeaway_path;
    result.takeawayLockedBodyHeight = s.takeawayTelemetry.takeaway_locked_body_height;
    result.takeawayBodyScaledFrame = s.takeawayTelemetry.takeaway_body_scaled_frame;
    result.takeawayFallbackIdx = s.takeawayTelemetry.takeaway_fallback_idx;
    result.takeawayTravelBH = s.takeawayTelemetry.takeaway_travel_bh;
    result.takeawayFallbackReason = s.takeawayTelemetry.takeaway_fallback_reason;
  }
  if (s.gateStage === "impact_search") return result;

  result.topVelMinShadow = s.topVelMinShadow;
  result.topXExtreme = s.topXExtreme;
  result.topIdx = s.topXExtreme?.frame ?? null;
  if (s.gateStage === "top_search") {
    result.impactIdx = s.arcBottomFrame; // best available before the gate
    return result;
  }

  result.impactIdx = s.impactIdx;
  result.impactConsensus = s.consensusShadow;
  if (s.selection) {
    result.impactSource = s.selection.impactSource;
    result.impactConsensusFinal = s.selection.impactConsensusFinal;
    result.impactArcbottom = s.selection.impactArcbottom;
    result.impactDelta = s.selection.impactDelta;
    result.impactCrossCheckMismatch = s.selection.impactCrossCheckMismatch;
    result.impactFallbackReason = s.selection.impactFallbackReason;
  }
  result.finishFrame = s.finish?.frame ?? null;
  if (s.gateStage === "trigger_a") return result;

  // Set only after the triggerA gate passes — matches the old body, where a
  // triggerA return left takeawayIdx/downswingIdx null.
  result.takeawayIdx = s.takeawayIdx;
  result.downswingIdx = s.downswingIdx;

  return result; // covers ladder, bunched, and the clean run
}
