/**
 * phaseDetectionShared.ts — Shared helpers and constants for the angle-aware
 * phase detection dispatcher (docs/HoneySwing_Phase_Detection_Rules.md).
 *
 * Hosts:
 *   - The takeaway directional gate (already shipped — works for both DTL
 *     and face-on because the canonical-space wrist midpoint travels the
 *     same direction either viewpoint).
 *   - Time/frame conversion helpers so each rule can express its window in
 *     milliseconds and have it scale to the actual capture frame rate.
 *   - The EXTERNAL_ASSUMPTIONS object — single source of truth for all
 *     thresholds that the Dave clinic recalibration step will tune.
 *   - PhaseRuleDebug, the per-rule diagnostic record threaded into
 *     swing_debug.phase_rules.
 */

import type { PoseFrame } from "../../pose/PoseTypes";
import type { SwingTrailPoint } from "./phaseDetection";

// ---------------------------------------------------------------------------
// External assumptions — every numeric threshold from the rules doc, in one
// place, so clinic recalibration is a single edit.
// ---------------------------------------------------------------------------

export const EXTERNAL_ASSUMPTIONS = {
  dtl: {
    swingStart: {
      hardMultiplier: 3,
      watchMultiplier: 2,
      hardFloor: 0.002,
      watchFloor: 0.0015,
      baselineFrames: 10,
      // 1b: ms-based sibling of baselineFrames (10 @ 60fps). Live readers use msToFrames(baselineMs, msPerFrame).
      baselineMs: 167,
      spreadRiseDelta: 0.003,
      midXDriftDelta: 0.004,
      // 1b: ms-based sibling of the hardcoded F-3 spreadRise/midXDrift lookback (3 @ 60fps).
      riseLookbackMs: 50,
      watchTimeoutFrames: 5,
      // 1b: ms-based sibling of watchTimeoutFrames (5 @ 60fps).
      watchTimeoutMs: 83,
    },
    trueAddress: {
      windowFrames: 8,
      // 1b: ms-based sibling of windowFrames (8 @ 60fps).
      windowMs: 133,
      spineVarMax: 1.5,
      headDeltaMax: 0.006,
      kneeVarMax: 2.0,
      backScanCapBeforeTop: 20,
      // 1b: ms-based sibling of backScanCapBeforeTop (20 @ 60fps).
      backScanCapBeforeTopMs: 333,
    },
    top: {
      minTravel: 0.04,
      lookaheadFrames: 10,
      // 1b: ms-based sibling of lookaheadFrames (10 @ 60fps).
      lookaheadMs: 167,
      searchStartMs: 200,
      searchEndMs: 2000,
    },
    impact: {
      handLowToImpactMs: 67,
      searchStartMs: 100,
      searchEndMs: 1500,
    },
    finish: {
      searchMultiplier: 3.0,
      minFollowMs: 300,
      velocityFloor: 0.008,
    },
  },
  faceOn: {
    swingStart: {
      triggerMultiplier: 2.5,
      sustainMultiplier: 10.0,
      sustainMs: 330,
      baselineWindowFrames: 30,
      // 1b: ms-based sibling of baselineWindowFrames (30 @ 60fps).
      baselineWindowMs: 500,
      baselineLowestN: 20,
    },
    top: {
      consensusWindowFrames: 5,
      // 1b: ms-based sibling of consensusWindowFrames (5 @ 60fps).
      consensusWindowMs: 83,
      searchStartFraction: 0.25,
      searchEndFraction: 0.20,
    },
    // Shadow X-extreme top rule (Phase 2 parallel compute — NOT wired as the real
    // top). Separate fractions so the live `top` rule above keeps its baseline.
    topXExtreme: {
      searchStartFraction: 0.30,
      // 0.10 (was 0.06): more end-margin before impact. e212431b showed the
      // canonical lead-X max contaminates near impact (~150, downswing); a wider
      // right margin keeps the search off the downswing.
      searchEndFraction: 0.10,
      minConfidence: 0.5,
    },
    impact: {
      lagCorrectionMs: 27,
      riseRateThreshold: 0.03,
      riseLookbackFrames: 3,
      riseSustainMs: 110,
      footRefFrames: 30,
      // Lead-thumb-line crossing rule (primary face-on impact detector).
      // EXTERNAL ASSUMPTION — calibrated on RH swing 81f0b197 (crossing 137.5 vs
      // ground truth 137.6) via scripts/output/_thumbCrossing.mjs; re-validate vs corpus.
      thumbConfMin: 0.4,        // skip frames where either thumb joint conf < this
      thumbHoldFrames: 2,       // crossing must hold positive this many consecutive valid frames
      thumbHoldMs: 33,          // 1b-2: ms sibling of thumbHoldFrames (2 @ 60fps)
      thumbMinValidCoverage: 0.5, // fraction of window frames that must pass conf, else fall back
      crossCheckThresholdFrames: 6, // |thumb − arcBottom| above this sets the reliability flag
      crossCheckThresholdMs: 100, // 1b-2: ms sibling of crossCheckThresholdFrames (6 @ 60fps)
      // [EXTERNAL ASSUMPTION / NO SOURCE — clinic-calibrated, N=12 (10 real / 2 artifact)]
      // Reject the thumb crossing → arc-bottom when |thumb − arcBottom| exceeds this. SEPARATE
      // from crossCheckThresholdFrames (6, reliability downgrade only). 15 = center of the empty
      // gap measured offline: reals max |delta| 3.3, artifacts min |delta| 23.8 → 15 sits ~12
      // frames above the worst real and ~9 below the nearest artifact. Re-validate as corpus grows.
      impactRejectDeltaFrames: 15,
      // ── Low-Y-gated FIRST-crossing selector (primary thumb pick) ──────────────────────────
      // [EXTERNAL ASSUMPTION — UNTESTED BEYOND N=2: validated only on dec6edd1 (impact 120) and
      // 81f0b197 (137.x), pinned in scripts/replayThumbImpact.ts. Re-validate as ground truth grows.]
      // Impact = FIRST neg→pos thumb crossing after top where BOTH wrists sit in the bottom
      // LOW_Y_FRACTION of their y-range, measured over the lowYZoneWindow. Rejects early-transition
      // and follow-through-noise crossings the LAST rule chased. Falls back to the LAST-crossing
      // path (above) when no low-y crossing qualifies or it fails the arc-bottom cross-check.
      lowYFraction: 0.5,        // y top-down: low-y zone = y ≥ min + (1 − lowYFraction)·range
      lowYZoneWindow: ["top", "follow_through"] as const, // phases bounding the y-range measurement
      teleportDxAmplitude: 0.05, // skip crossings whose bounding |dx| exceeds this (teleport spike;
                                 // clean impact crossings ≈0.008–0.015, dec6edd1's noise spike ≈0.19)
      // ── xCross CONSENSUS impact (ported from honeyswing-swing-inspector/src/lib/impactRule.ts) ──
      // The validated replacement for the arc-bottom/thumb selector: a geometric CONSENSUS
      // (S1=xCross, S2=arm-vertical, S3=wrist-lowest) refined by a sub-frame thumb crossing.
      // Computed over [topIdx, follow_through] on PRE-CANONICAL (raw/un-mirrored) frames — the same
      // x-sign space the viewer validated in. Shadow-only this PR (does NOT feed impactIdx).
      // [EXTERNAL ASSUMPTION — n=6 RH drivers; validated 6/6 in the viewer, avg|Δ| 0.43 / max 1.0.]
      consensus: {
        // Impact search window = [topIdx, topIdx + downswingBudget] (viewer design). The viewer
        // anchored on a takeaway-derived freshTop ≈ the app's topXExtreme; the budget keeps the
        // search OFF the broken stored/derived finish. Validated: [topIdx, finish] truncates
        // 9d1606a6 (finish 103 < impact 125) and over-widens e212431b (decoys at 184/196).
        downswingBudget: 50,       // raised 45→50 in the viewer after 3a814184's ~47-frame downswing
                                   // (60fps frame form; kept for the deferred diagnostic scripts)
        // 1d: ms sibling of downswingBudget (50 @ 60fps) — live consumers convert via msToFrames.
        // Validated ground truth is 0.83s of downswing (6 swings, all 16.667 ms/frame).
        downswingBudgetMs: 833,
        xcrossLeadOffset: 0.06,    // L: shaft-lean offset — wrist leads the feet midpoint at impact
        xcrossAnchorRadius: 11,    // pick the xCross crossing nearest the provisional anchor within ±this
        xcrossAnchorRadiusMs: 183, // 1b: ms sibling of xcrossAnchorRadius (11 @ 60fps)
        xcrossConfMin: 0.6,        // selected-wrist confidence floor at a crossing
        xcrossSustainFrames: 2,    // g must hold ≥ L for this many consecutive frames (hold ≥2)
        xcrossSustainMs: 33,       // 1b: ms sibling of xcrossSustainFrames (2 @ 60fps)
        availConfMin: 0.6,         // a geometric signal is "available" iff its min joint conf ≥ this
        refineRadius: 6,           // thumb crossing must land within ±this of the consensus anchor
        refineRadiusMs: 100,       // 1b: ms sibling of refineRadius (6 @ 60fps)
        thumbRefineConfMin: 0.5,   // min(tip,base) confidence for a thumb refine crossing to count
      },
    },
    finish: {
      rollingWindow: 5,
      // 1b: ms-based sibling of rollingWindow (5 @ 60fps).
      rollingWindowMs: 83,
      plateauJitterPct: 0.10,
      plateauConfirmMs: 550,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Diagnostic record
// ---------------------------------------------------------------------------

export type PhaseReliability = "high" | "medium" | "low";

export type PhaseRuleReliability = {
  swing_start: PhaseReliability | null;
  true_address: PhaseReliability | null;
  takeaway: PhaseReliability | null;
  top: PhaseReliability | null;
  impact: PhaseReliability | null;
  finish: PhaseReliability | null;
};

// Shadow X-extreme top candidate — Phase 2 parallel compute, logged beside the
// live top for ground-truth comparison (not wired as the real top). perLandmark /
// median / spread / window are surfaced so nose drift and near-impact contamination
// are visible without re-running the detector.
export type FaceOnTopXExtreme = {
  frame: number | null; // combined pick = median (robust to a drifting landmark)
  mean: number | null;  // mean of picks — kept for comparison only, not the pick
  reliability: PhaseReliability | null;
  perLandmark: {
    nose: number | null;
    leadShoulder: number | null;
    leadEar: number | null;
  };
  median: number | null;
  spread: number | null;
  window: { from: number; to: number } | null;
};

export type PhaseRuleDebug = {
  detector: "dtl" | "face_on" | "legacy";
  swing_start_frame: number | null;
  true_address_frame: number | null;
  reliability: PhaseRuleReliability;
  external_assumptions_used: string[];
  // Shadow X-extreme top (face-on only; Phase 2). Optional → DTL/legacy unaffected.
  top_x_extreme?: FaceOnTopXExtreme;
  // Shadow velocity-min top (face-on only). The X-extreme median is now the live top;
  // the legacy velocity-min rule is retained here for one release for live comparison
  // before deletion. Optional → DTL/legacy unaffected.
  top_velmin_shadow?: number | null;
  // Face-on impact provenance + cross-check (optional → DTL/legacy unaffected).
  // Records the consensus FINAL and its disagreement with the old arc-bottom on every swing, so
  // neither detector is silently trusted. (PR2: consensus is the primary; arc-bottom the fallback.)
  impact_source?: "consensus" | "arc_bottom";
  impact_consensus_final?: number | null; // sub-frame consensus FINAL used (null when none / gated)
  impact_arcbottom?: number | null;   // arc-bottom fallback frame (null when none)
  impact_delta?: number | null;       // round(impact_consensus_final) − impact_arcbottom (cross-check)
  impact_cross_check_mismatch?: boolean; // |delta| > crossCheckThresholdFrames (FLAG, not a rejection)
  // Why arc-bottom was used instead of the consensus (set only when impact_source === "arc_bottom"):
  // "lh_ungated" = DEPRECATED — no longer produced (LH gate removed; LH now runs the consensus).
  //   Retained for historical persisted rows captured before the flip.
  // "override" = test seam; "no_precanonical" = no raw frames to run the consensus on;
  // "no_signals" = 0 geometric signals available (consensus null). All carry reliability.impact=low.
  impact_fallback_reason?:
    | "lh_ungated"
    | "override"
    | "no_precanonical"
    | "no_signals";
  // xCross CONSENSUS impact detail (face-on only). Full provenance of the primary detector
  // (s1/s2/s3, provAnchor, thumb-refine, signFlip). Optional → DTL/legacy unaffected.
  impact_consensus?: FaceOnImpactConsensusShadow | null;
  // Body-scaled, reversal-rejecting takeaway gate (FACE-ON only; optional →
  // DTL/legacy unaffected). Records which path produced the takeaway index and
  // the body-scaled rule's findings EVEN WHEN the legacy gate was used.
  takeaway_path?: "body_scaled" | "fallback_gate";
  takeaway_locked_body_height?: number | null; // trimmed-mean nose↔rightAnkle (normalized)
  takeaway_body_scaled_frame?: number | null;  // body-scaled onset candidate, FRAME space
  takeaway_fallback_idx?: number | null;        // findSetupEndIndex result, FRAME space
  takeaway_travel_bh?: number | null;           // max peak-above-running-min lead-wrist travel
  takeaway_fallback_reason?:
    | "trail_too_short"
    | "ruler_unreliable"
    | "no_qualifying_climb"
    | "no_confirmed_trigger"
    | "onset_too_late"
    | null;
};

// Shadow xCross CONSENSUS impact (face-on only; PR1). Flattened from
// faceOnImpactConsensus.FaceOnImpactConsensus for logging — defined here (not imported) to keep
// phaseDetectionShared free of a module cycle. Frames are FRAME-space; sub-frame values kept raw.
export type FaceOnImpactConsensusShadow = {
  final: number | null;       // sub-frame: thumb if qualifies, else consensus, else null
  source: "thumb" | "consensus" | "none";
  consensus: number | null;
  provAnchor: number | null;
  anchor: number | null;
  s1: number | null;          // xCross pick frame (nearest-anchor)
  s2: number | null;          // arm-vertical
  s3: number | null;          // wrist-lowest
  footPick: number | null;    // wrist-over-foot anchor seed
  xCross: number | null;      // first sustained crossing sub-frame (pre nearest-anchor)
  thumbQualifies: boolean;
  signFlip: number;
  lowReliability: boolean;
  window: [number, number];
};

export function emptyReliability(): PhaseRuleReliability {
  return {
    swing_start: null,
    true_address: null,
    takeaway: null,
    top: null,
    impact: null,
    finish: null,
  };
}

// ---------------------------------------------------------------------------
// Time/frame helpers
// ---------------------------------------------------------------------------

/** Average ms per frame across the capture. Returns 0 for single-frame inputs. */
export function msPerFrameFromFrames(frames: PoseFrame[]): number {
  if (frames.length < 2) return 0;
  const span = frames[frames.length - 1].timestampMs - frames[0].timestampMs;
  return span / (frames.length - 1);
}

/** Average ms per frame across a trail. Returns 0 for single-point inputs. */
export function msPerFrameFromTrail(points: SwingTrailPoint[]): number {
  if (points.length < 2) return 0;
  const span = points[points.length - 1].timestamp - points[0].timestamp;
  return span / (points.length - 1);
}

/** Convert milliseconds to frames at the given ms/frame rate. */
export function msToFrames(ms: number, msPerFrame: number): number {
  if (msPerFrame <= 0) return 0;
  return Math.round(ms / msPerFrame);
}

/**
 * Reference capture rate the per-frame *spatial* floors (displacement thresholds) were
 * calibrated at: 240fps source / 4 decimation = 60fps = 1000/60 ms/frame. A per-frame
 * displacement floor scales linearly with dt, so at another rate use `floor · msPerFrame / REF_MS_60`
 * (exactly the calibrated value at 60fps).
 */
export const REF_MS_60 = 1000 / 60;

/** Scale a per-frame displacement floor (calibrated at 60fps) to the given rate. */
export function scalePerFrameFloor(floor60: number, msPerFrame?: number): number {
  return msPerFrame != null && msPerFrame > 0 ? floor60 * (msPerFrame / REF_MS_60) : floor60;
}

// ---------------------------------------------------------------------------
// Shared takeaway directional gate — works in canonical space for both DTL
// and face-on. Lifted from the original phaseDetection.ts (commit 7c54e4b)
// so DTL/face-on/legacy detectors all share one implementation.
// ---------------------------------------------------------------------------

// (1b: removed dead TAKEAWAY_DIRECTION_FRAMES/THRESHOLD — declared, never referenced;
//  their comment also mis-asserted 120fps. See audit Section 2.)
const TAKEAWAY_MAX_ADDRESS_FRACTION = 0.6;
const MEDIAN_GATE_WINDOW = 8;     // frames per window (60fps fallback when msPerFrame absent)
const MEDIAN_GATE_WINDOW_MS = 133; // 1b: ms sibling of MEDIAN_GATE_WINDOW (8 @ 60fps)
const MEDIAN_GATE_REQUIRED = 6;   // middle N that must all be positive (drops 1 outlier each end)

/** Frames of the directional gate window at the given rate (falls back to the 60fps literal). */
function medianGateWindow(msPerFrame?: number): number {
  return msPerFrame != null ? msToFrames(MEDIAN_GATE_WINDOW_MS, msPerFrame) : MEDIAN_GATE_WINDOW;
}

/**
 * Magnitude-based stillness gate (legacy). Direction-blind — kept as a
 * safety fallback so the directional gate never makes a swing strictly
 * worse than today's behavior.
 */
export function findSetupEndIndexStillness(
  smoothed: number[],
  points: SwingTrailPoint[],
  // Rate for the stillness-run threshold (falls back to the 60fps literal when absent).
  msPerFrame?: number,
): number {
  const sorted = [...smoothed].filter((v) => v > 0).sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  const threshold = Math.max(median * 0.2, 0.0001);

  const stillRun = msPerFrame != null ? Math.max(1, msToFrames(STILLNESS_MIN_MS, msPerFrame)) : 2;
  let stillCount = 0;
  for (let i = 0; i < points.length; i++) {
    if (smoothed[i] <= threshold) {
      stillCount++;
    } else if (stillCount >= stillRun) {
      return Math.max(0, i - 1);
    } else {
      stillCount = 0;
    }
  }
  return Math.min(2, points.length - 1);
}

/**
 * Find the end of the setup/address phase using a sign-aware directional
 * gate on the canonical wrist-midpoint x. Δx > 0 is the takeaway direction
 * in canonical space (lefty x is mirrored upstream), so a sustained
 * positive Δx window indicates committed swing initiation rather than
 * waggle, glove-tug, or forward-press noise. Falls back to the legacy
 * stillness gate when no directional onset is found or onset arrives late.
 */
export function findSetupEndIndex(
  smoothed: number[],
  points: SwingTrailPoint[],
  // Rate for the directional-gate window (falls back to the 60fps literal when absent).
  msPerFrame?: number,
): number {
  const gate = medianGateWindow(msPerFrame);
  // 1c: "drop 1 each end" scaled to the rate-derived window (keeps the 6/8 ratio) and clamped so a
  // small (low-fps) gate can't index past `window`. At 60fps gate=8 → required=6 (unchanged).
  const required = Math.max(1, Math.min(gate - 1, Math.round((gate * MEDIAN_GATE_REQUIRED) / MEDIAN_GATE_WINDOW)));
  if (points.length < gate + 1) {
    return findSetupEndIndexStillness(smoothed, points, msPerFrame);
  }

  const lastIdx = points.length - 1;

  for (let i = gate; i < points.length; i++) {
    const window: number[] = [];
    for (let j = i - (gate - 1); j <= i; j++) {
      window.push(points[j].x - points[j - 1].x);
    }
    window.sort((a, b) => a - b);
    // Drop sorted[0] and sorted[gate-1]; require sorted[1..required] all > 0.
    let allPositive = true;
    for (let k = 1; k <= required; k++) {
      if (window[k] <= 0) { allPositive = false; break; }
    }
    if (allPositive) {
      const candidate = i - gate;
      if (candidate <= TAKEAWAY_MAX_ADDRESS_FRACTION * lastIdx) {
        return candidate;
      }
      break;
    }
  }
  return findSetupEndIndexStillness(smoothed, points, msPerFrame);
}

// ---------------------------------------------------------------------------
// Velocity helpers reused by legacy + DTL/face-on detectors
// ---------------------------------------------------------------------------

const SMOOTH_WINDOW_MS = 83; // 1b: ms sibling of the box-mean smoothing window (5 @ 60fps)

/** Box-mean smoothing window in frames at the given rate (falls back to the 60fps literal 5). */
export function smoothWindow(msPerFrame?: number): number {
  return msPerFrame != null ? Math.max(1, msToFrames(SMOOTH_WINDOW_MS, msPerFrame)) : 5;
}

export function trailVelocity(a: SwingTrailPoint, b: SwingTrailPoint): number {
  const dt = b.timestamp - a.timestamp;
  if (dt === 0) return 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy) / dt;
}

export function computeTrailVelocities(points: SwingTrailPoint[]): number[] {
  const velocities: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    velocities.push(trailVelocity(points[i - 1], points[i]));
  }
  return velocities;
}

export function smoothVelocities(
  velocities: number[],
  window: number = 5,
): number[] {
  const half = Math.floor(window / 2);
  return velocities.map((_, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(velocities.length - 1, i + half);
    let sum = 0;
    for (let j = start; j <= end; j++) sum += velocities[j];
    return sum / (end - start + 1);
  });
}

// ---------------------------------------------------------------------------
// Body-scaled, reversal-rejecting takeaway onset — FACE-ON ONLY.
//
// Additive override for findSetupEndIndex: when a confident, reversal-clean
// lead-wrist climb of >= TAKEAWAY_MIN_TRAVEL_BH body-heights exists, returns its
// onset (TRAIL-space index, same space findSetupEndIndex returns); otherwise
// returns null so the caller falls back to the legacy directional gate. Never
// throws — any bad/missing data yields a null onset.
//
// The signal is the LEAD-wrist x = trail[].leadX (canonical lead arm = right*; see
// CANONICAL_LEAD in canonicalTransform.ts). Δx > 0 is the takeaway direction in
// canonical space for BOTH handedness.
// ---------------------------------------------------------------------------

/**
 * Minimum lead-wrist travel (in body-heights) for the body-scaled gate to fire.
 * EXTERNAL ASSUMPTION (N=2): data-derived midpoint of the measured feint (0.20
 * BH) vs real-takeaway (1.08 BH) travel gap on swing 6623e3e8.
 */
export const TAKEAWAY_MIN_TRAVEL_BH = 0.5;

const BODY_HEIGHT_MIN_FRAMES = 20;  // fewer confident nose↔ankle frames → ruler unreliable (60fps fallback)
const BODY_HEIGHT_MIN_MS = 333;     // 1b: ms sibling of BODY_HEIGHT_MIN_FRAMES (20 @ 60fps)
const BODY_HEIGHT_TRIM = 0.2;       // drop top/bottom 20% before averaging
const BODY_HEIGHT_MIN_CONFIDENCE = 0.5;

/**
 * Consecutive strictly-decreasing smoothed frames that mark a real reversal (a
 * waggle/feint turning back) and reject a trigger group before it confirms.
 * EXTERNAL ASSUMPTION (N=3 swings); wide margin — observed waggles climbed
 * 0.09–0.22 BH before reversing, real takeaways climbed 0.51–0.56 BH.
 */
const SUSTAINED_REVERSAL_FRAMES = 3;
const SUSTAINED_REVERSAL_MS = 50; // 1b: ms sibling of SUSTAINED_REVERSAL_FRAMES (3 @ 60fps)
const STILLNESS_MIN_MS = 33;      // 1b: ms sibling of the stillness run threshold (2 @ 60fps)

export type FaceOnTakeawayOnset = {
  /** Trail-space onset index; null ⇒ caller must fall back to findSetupEndIndex. */
  onsetTrailIdx: number | null;
  /** Trimmed-mean nose↔rightAnkle distance (normalized); null when unreliable. */
  lockedBodyHeight: number | null;
  /** Onset candidate (trail-space) even when the gate did NOT fire — telemetry. */
  candidateTrailIdx: number | null;
  /** Max peak-above-running-min lead-wrist travel, in body-heights. */
  travelBH: number | null;
  fired: boolean;
  fallbackReason:
    | "trail_too_short"
    | "ruler_unreliable"
    | "no_qualifying_climb"
    | "no_confirmed_trigger"
    | "onset_too_late"
    | null;
};

/**
 * Body-scale ruler: trimmed mean of euclidean(nose, rightAnkle) over frames
 * where BOTH joints have confidence >= 0.5. Height-only by design — tolerant of
 * the known lower-body L/R swap. Returns null when too few confident frames.
 */
function lockedBodyHeightFromFrames(frames: PoseFrame[], msPerFrame?: number): number | null {
  const heights: number[] = [];
  for (const f of frames) {
    const nose = f.joints.nose;
    const ankle = f.joints.rightAnkle;
    if (!nose || !ankle) continue;
    if ((nose.confidence ?? 0) < BODY_HEIGHT_MIN_CONFIDENCE) continue;
    if ((ankle.confidence ?? 0) < BODY_HEIGHT_MIN_CONFIDENCE) continue;
    const dx = nose.x - ankle.x;
    const dy = nose.y - ankle.y;
    heights.push(Math.sqrt(dx * dx + dy * dy));
  }
  const minFrames = msPerFrame != null ? msToFrames(BODY_HEIGHT_MIN_MS, msPerFrame) : BODY_HEIGHT_MIN_FRAMES;
  if (heights.length < minFrames) return null;
  heights.sort((a, b) => a - b);
  const lo = Math.floor(heights.length * BODY_HEIGHT_TRIM);
  const hi = heights.length - lo;
  const mid = heights.slice(lo, hi);
  if (mid.length === 0) return null;
  let sum = 0;
  for (const h of mid) sum += h;
  const bh = sum / mid.length;
  return bh > 0 ? bh : null;
}

export function findTakeawayOnsetFaceOn(
  trail: SwingTrailPoint[],
  frames: PoseFrame[],
  // Rate for the gate window / ruler-min / reversal-run / smoothing (falls back to 60fps literals).
  msPerFrame?: number,
): FaceOnTakeawayOnset {
  const gate = medianGateWindow(msPerFrame);
  const required = Math.max(1, Math.min(gate - 1, Math.round((gate * MEDIAN_GATE_REQUIRED) / MEDIAN_GATE_WINDOW)));
  const reversalRunMax = msPerFrame != null ? Math.max(1, msToFrames(SUSTAINED_REVERSAL_MS, msPerFrame)) : SUSTAINED_REVERSAL_FRAMES;
  const nullResult = (
    fallbackReason: FaceOnTakeawayOnset["fallbackReason"],
    extra?: Partial<FaceOnTakeawayOnset>,
  ): FaceOnTakeawayOnset => ({
    onsetTrailIdx: null,
    lockedBodyHeight: null,
    candidateTrailIdx: null,
    travelBH: null,
    fired: false,
    fallbackReason,
    ...extra,
  });

  try {
    if (trail.length < gate + 1) {
      return nullResult("trail_too_short");
    }

    const bh = lockedBodyHeightFromFrames(frames, msPerFrame);
    if (bh == null) {
      return nullResult("ruler_unreliable");
    }

    // Smooth the LEAD-wrist x (leadX) position series with the existing box-mean.
    // This is the confirm/travel signal; Δx > 0 is the takeaway direction for both
    // handedness.
    const leadX = trail.map((p) => p.leadX);
    const s = smoothVelocities(leadX, smoothWindow(msPerFrame));

    // Candidate generator — re-run the OLD 6-of-8 directional-window test
    // (findSetupEndIndex's window math, left unmodified there) on the wrist-
    // MIDPOINT x, but emit EVERY passing window-start instead of only the first.
    // Each window of 8 raw deltas is sorted, its min+max dropped, and the middle
    // 6 required strictly positive → a committed directional move, not a spike.
    const windowStarts: number[] = [];
    for (let i = gate; i < trail.length; i++) {
      const window: number[] = [];
      for (let j = i - (gate - 1); j <= i; j++) {
        window.push(trail[j].x - trail[j - 1].x);
      }
      window.sort((a, b) => a - b);
      let allPositive = true;
      for (let k = 1; k <= required; k++) {
        if (window[k] <= 0) { allPositive = false; break; }
      }
      if (allPositive) windowStarts.push(i - gate);
    }

    // Group contiguous window-starts (gap > 1 ⇒ new trigger group); each group's
    // first start is its trigger frame.
    const triggers: number[] = [];
    for (let i = 0; i < windowStarts.length; i++) {
      if (i === 0 || windowStarts[i] - windowStarts[i - 1] > 1) {
        triggers.push(windowStarts[i]);
      }
    }

    const candidateTrailIdx = triggers.length > 0 ? triggers[0] : null;
    const target = TAKEAWAY_MIN_TRAVEL_BH * bh;

    // Confirm each trigger group in order: walk forward from its start along the
    // smoothed lead-wrist position. CONFIRM the instant the climb above the start
    // reaches the body-scaled target. REJECT the group if a run of
    // SUSTAINED_REVERSAL_FRAMES strictly-decreasing smoothed frames hits first (a
    // real reversal — waggle/feint turning back), or if the series ends with
    // neither. A flat or rising frame resets the reversal counter. Track each
    // group's max climb-BH for fallback telemetry when nothing confirms.
    let confirmedOnset: number | null = null;
    let confirmTravelBH = 0;
    let bestGroupTravelBH = 0;
    for (const c of triggers) {
      let reversalRun = 0;
      let groupMaxTravel = 0;
      let confirmedHere = false;
      for (let i = c + 1; i < s.length; i++) {
        const climb = s[i] - s[c];
        if (climb > groupMaxTravel) groupMaxTravel = climb;
        if (climb >= target) {
          confirmedOnset = c;
          confirmTravelBH = climb / bh;
          confirmedHere = true;
          break;
        }
        if (s[i] < s[i - 1]) {
          reversalRun++;
          if (reversalRun >= reversalRunMax) break; // sustained reversal → reject
        } else {
          reversalRun = 0; // flat OR rising resets
        }
      }
      const groupTravelBH = groupMaxTravel / bh;
      if (groupTravelBH > bestGroupTravelBH) bestGroupTravelBH = groupTravelBH;
      if (confirmedHere) break;
    }

    if (confirmedOnset === null) {
      return nullResult("no_confirmed_trigger", {
        lockedBodyHeight: bh,
        candidateTrailIdx,
        travelBH: triggers.length > 0 ? bestGroupTravelBH : null,
      });
    }

    // Late guard — applied to the FINAL confirmed onset only.
    const lastIdx = trail.length - 1;
    if (confirmedOnset > TAKEAWAY_MAX_ADDRESS_FRACTION * lastIdx) {
      return nullResult("onset_too_late", {
        lockedBodyHeight: bh,
        candidateTrailIdx,
        travelBH: confirmTravelBH,
      });
    }

    return {
      onsetTrailIdx: confirmedOnset,
      lockedBodyHeight: bh,
      candidateTrailIdx,
      travelBH: confirmTravelBH,
      fired: true,
      fallbackReason: null,
    };
  } catch {
    return nullResult("ruler_unreliable");
  }
}
