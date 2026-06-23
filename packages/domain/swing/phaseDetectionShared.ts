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
      spreadRiseDelta: 0.003,
      midXDriftDelta: 0.004,
      watchTimeoutFrames: 5,
    },
    trueAddress: {
      windowFrames: 8,
      spineVarMax: 1.5,
      headDeltaMax: 0.006,
      kneeVarMax: 2.0,
      backScanCapBeforeTop: 20,
    },
    top: {
      minTravel: 0.04,
      lookaheadFrames: 10,
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
      baselineLowestN: 20,
    },
    top: {
      consensusWindowFrames: 5,
      searchStartFraction: 0.25,
      searchEndFraction: 0.20,
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
      thumbMinValidCoverage: 0.5, // fraction of window frames that must pass conf, else fall back
      crossCheckThresholdFrames: 6, // |thumb − arcBottom| above this sets the reliability flag
      // [EXTERNAL ASSUMPTION / NO SOURCE — clinic-calibrated, N=12 (10 real / 2 artifact)]
      // Reject the thumb crossing → arc-bottom when |thumb − arcBottom| exceeds this. SEPARATE
      // from crossCheckThresholdFrames (6, reliability downgrade only). 15 = center of the empty
      // gap measured offline: reals max |delta| 3.3, artifacts min |delta| 23.8 → 15 sits ~12
      // frames above the worst real and ~9 below the nearest artifact. Re-validate as corpus grows.
      impactRejectDeltaFrames: 15,
    },
    finish: {
      rollingWindow: 5,
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

export type PhaseRuleDebug = {
  detector: "dtl" | "face_on" | "legacy";
  swing_start_frame: number | null;
  true_address_frame: number | null;
  reliability: PhaseRuleReliability;
  external_assumptions_used: string[];
  // Face-on impact provenance + cross-check (optional → DTL/legacy unaffected).
  // Records BOTH candidates and their disagreement on every swing, so neither
  // detector is silently trusted.
  impact_source?: "thumb_crossing" | "arc_bottom";
  impact_thumb?: number | null;       // sub-frame thumb crossing (null when none / gated)
  impact_arcbottom?: number | null;   // arc-bottom fallback frame (null when none)
  impact_delta?: number | null;       // impact_thumb − impact_arcbottom (null when either absent)
  impact_cross_check_mismatch?: boolean; // |delta| > crossCheckThresholdFrames
  // Why arc-bottom was used instead of the thumb crossing (set only when
  // impact_source === "arc_bottom"). "lh_ungated" = LH skips the unvalidated thumb
  // primary this ticket; "override" = test seam; "cross_check_mismatch" = thumb crossing
  // disagreed with arc-bottom by > impactRejectDeltaFrames (egregious, rejected); the rest
  // are RH thumb misses.
  impact_fallback_reason?:
    | "lh_ungated"
    | "override"
    | "no_precanonical"
    | "invalid_window"
    | "no_crossing"
    | "low_coverage"
    | "cross_check_mismatch";
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

// ---------------------------------------------------------------------------
// Shared takeaway directional gate — works in canonical space for both DTL
// and face-on. Lifted from the original phaseDetection.ts (commit 7c54e4b)
// so DTL/face-on/legacy detectors all share one implementation.
// ---------------------------------------------------------------------------

const TAKEAWAY_DIRECTION_FRAMES = 20;   // ~167 ms at 120 fps
const TAKEAWAY_DIRECTION_THRESHOLD = 0.002;
const TAKEAWAY_MAX_ADDRESS_FRACTION = 0.6;
const MEDIAN_GATE_WINDOW = 8;     // frames per window
const MEDIAN_GATE_REQUIRED = 6;   // middle N that must all be positive (drops 1 outlier each end)

/**
 * Magnitude-based stillness gate (legacy). Direction-blind — kept as a
 * safety fallback so the directional gate never makes a swing strictly
 * worse than today's behavior.
 */
export function findSetupEndIndexStillness(
  smoothed: number[],
  points: SwingTrailPoint[],
): number {
  const sorted = [...smoothed].filter((v) => v > 0).sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  const threshold = Math.max(median * 0.2, 0.0001);

  let stillCount = 0;
  for (let i = 0; i < points.length; i++) {
    if (smoothed[i] <= threshold) {
      stillCount++;
    } else if (stillCount >= 2) {
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
): number {
  if (points.length < MEDIAN_GATE_WINDOW + 1) {
    return findSetupEndIndexStillness(smoothed, points);
  }

  const lastIdx = points.length - 1;

  for (let i = MEDIAN_GATE_WINDOW; i < points.length; i++) {
    const window: number[] = [];
    for (let j = i - (MEDIAN_GATE_WINDOW - 1); j <= i; j++) {
      window.push(points[j].x - points[j - 1].x);
    }
    window.sort((a, b) => a - b);
    // Drop sorted[0] and sorted[7]; require sorted[1..6] all > 0.
    let allPositive = true;
    for (let k = 1; k <= MEDIAN_GATE_REQUIRED; k++) {
      if (window[k] <= 0) { allPositive = false; break; }
    }
    if (allPositive) {
      const candidate = i - MEDIAN_GATE_WINDOW;
      if (candidate <= TAKEAWAY_MAX_ADDRESS_FRACTION * lastIdx) {
        return candidate;
      }
      break;
    }
  }
  return findSetupEndIndexStillness(smoothed, points);
}

// ---------------------------------------------------------------------------
// Velocity helpers reused by legacy + DTL/face-on detectors
// ---------------------------------------------------------------------------

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

const BODY_HEIGHT_MIN_FRAMES = 20;  // fewer confident nose↔ankle frames → ruler unreliable
const BODY_HEIGHT_TRIM = 0.2;       // drop top/bottom 20% before averaging
const BODY_HEIGHT_MIN_CONFIDENCE = 0.5;

/**
 * Consecutive strictly-decreasing smoothed frames that mark a real reversal (a
 * waggle/feint turning back) and reject a trigger group before it confirms.
 * EXTERNAL ASSUMPTION (N=3 swings); wide margin — observed waggles climbed
 * 0.09–0.22 BH before reversing, real takeaways climbed 0.51–0.56 BH.
 */
const SUSTAINED_REVERSAL_FRAMES = 3;

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
function lockedBodyHeightFromFrames(frames: PoseFrame[]): number | null {
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
  if (heights.length < BODY_HEIGHT_MIN_FRAMES) return null;
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
): FaceOnTakeawayOnset {
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
    if (trail.length < MEDIAN_GATE_WINDOW + 1) {
      return nullResult("trail_too_short");
    }

    const bh = lockedBodyHeightFromFrames(frames);
    if (bh == null) {
      return nullResult("ruler_unreliable");
    }

    // Smooth the LEAD-wrist x (leadX) position series with the existing box-mean.
    // This is the confirm/travel signal; Δx > 0 is the takeaway direction for both
    // handedness.
    const leadX = trail.map((p) => p.leadX);
    const s = smoothVelocities(leadX, 5);

    // Candidate generator — re-run the OLD 6-of-8 directional-window test
    // (findSetupEndIndex's window math, left unmodified there) on the wrist-
    // MIDPOINT x, but emit EVERY passing window-start instead of only the first.
    // Each window of 8 raw deltas is sorted, its min+max dropped, and the middle
    // 6 required strictly positive → a committed directional move, not a spike.
    const windowStarts: number[] = [];
    for (let i = MEDIAN_GATE_WINDOW; i < trail.length; i++) {
      const window: number[] = [];
      for (let j = i - (MEDIAN_GATE_WINDOW - 1); j <= i; j++) {
        window.push(trail[j].x - trail[j - 1].x);
      }
      window.sort((a, b) => a - b);
      let allPositive = true;
      for (let k = 1; k <= MEDIAN_GATE_REQUIRED; k++) {
        if (window[k] <= 0) { allPositive = false; break; }
      }
      if (allPositive) windowStarts.push(i - MEDIAN_GATE_WINDOW);
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
          if (reversalRun >= SUSTAINED_REVERSAL_FRAMES) break; // sustained reversal → reject
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
