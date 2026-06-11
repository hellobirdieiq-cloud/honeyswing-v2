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
  // primary this ticket; "override" = test seam; the rest are RH thumb misses.
  impact_fallback_reason?:
    | "lh_ungated"
    | "override"
    | "no_precanonical"
    | "invalid_window"
    | "no_crossing"
    | "low_coverage";
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
