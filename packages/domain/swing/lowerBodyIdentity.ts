/**
 * lowerBodyIdentity.ts — Layer 0 lower-body L/R identity correction.
 *
 * RTMW confidently exchanges the entire lower body's left/right labels:
 * hip+knee+ankle(+heel+foot) swap as a leg-coherent unit, in runs from a
 * single frame to 60+ frames, with per-joint confidence 0.7–0.85 (verified
 * on swings f72e056b f60/f115-124, 3c5f2ce2 f154-213, 729e41bc f98-102;
 * hip exchange verified at f72e056b f60). No confidence or velocity gate
 * catches this: the interior of a sustained swap run has near-zero velocity,
 * so the Layer-1 veto re-anchors onto the swapped track after MAX_GAP and
 * legitimizes it.
 *
 * Fix: per-frame midline-relative disambiguation. Establish the baseline
 * bilateral orientation s0 = majority sign(rightX − leftX) over the first
 * BASELINE_VOTES valid votes (≈ the address window — capture starts at
 * setup, which is still and pre-swing), then relabel any frame whose
 * knee+ankle vote contradicts s0 by exchanging ALL five L/R lower-body
 * pairs (full joint objects — x/y/z/confidence move with the joint, `name`
 * is rewritten to the target label).
 *
 * Hysteresis (two tiers):
 *   - Frames whose vote separation is below VOTE_SEPARATION_MIN abstain
 *     entirely (one-leg collapses, knee convergence) and hold the previous
 *     decision. One-leg collapses are NOT identity errors — they are
 *     deliberately left for the Layer-1 veto/interpolation.
 *   - The swap DECISION only changes on votes with separation ≥
 *     DECISION_SEPARATION_MIN. Real exchanges measure ≥0.10 separation;
 *     0.02–0.04 is collapse-boundary noise (observed marginal vote at
 *     729e41bc f55, separation ≈0.02) and must not flip state.
 *   - Lead-in backfill: frames before the first decision-grade vote take
 *     that first decision (the init-false bias would otherwise leave a
 *     swapped lead-in uncorrected).
 *
 * Baseline trust: s0 is derived from the capture's own data, NOT from an
 * assumed anatomical convention — so the pass is handedness- and
 * camera-side-agnostic by construction (a lefty or an opposite-side camera
 * simply yields the other sign). NOTE the lefty path is corpus-untested:
 * every swing row in the DB is right-handed; coverage comes from the
 * mirrored synthetic fixture in lowerBodyIdentity.test.ts.
 *
 * KNOWN LIMIT (documented, accepted for v1): if the address window itself
 * is majority-swapped, s0 inverts and the whole swing is relabeled
 * consistently mirrored. Observed worst case in the corpus is a 13–2
 * majority (729e41bc, flicker votes at f12/f21); baselineMargin is emitted
 * so weak majorities are visible, and low_confidence_baseline is set in
 * the debug payload when |tally|/votes < 0.5. The clean-swing gate in
 * scripts/identity-validate.ts guards regressions here.
 *
 * Pure and idempotent: a corrected stream votes s0 at every acted frame
 * (the vote sum is antisymmetric under the whole-unit exchange), so
 * re-application is a no-op.
 *
 * Viterbi/track-assignment is the fallback design if this pass fails
 * validation — deliberately NOT implemented.
 */

import type { JointName, NormalizedJoint, PoseFrame } from "../../pose/PoseTypes";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Joints relabeled as a unit when a swap is decided. */
export const LOWER_BODY_PAIRS: ReadonlyArray<readonly [JointName, JointName]> = [
  ["leftHip", "rightHip"],
  ["leftKnee", "rightKnee"],
  ["leftAnkle", "rightAnkle"],
  ["leftHeel", "rightHeel"],
  ["leftFootIndex", "rightFootIndex"],
];

/**
 * Pairs that VOTE on identity. Knee + ankle only: they carry the widest L/R
 * x-separation. Hips sit near the midline (≈0.09 separation vs ≈0.2 for
 * knees on DTL data) and would add noise; they are still RELABELED with the
 * unit when a swap is decided.
 */
const VOTE_PAIRS: ReadonlyArray<readonly [JointName, JointName]> = [
  ["leftKnee", "rightKnee"],
  ["leftAnkle", "rightAnkle"],
];

/** Minimum per-joint confidence for a pair to participate in the vote. */
export const VOTE_CONF_MIN = 0.35;

/**
 * Below this summed |rightX − leftX| a frame abstains entirely (collapse /
 * convergence). Holds the previous decision.
 */
export const VOTE_SEPARATION_MIN = 0.02;

/**
 * The swap decision only changes on votes at or above this separation.
 * Keeps collapse-boundary noise (0.02–0.04) from flipping state; observed
 * real exchanges measure ≥0.10.
 */
export const DECISION_SEPARATION_MIN = 0.04;

/** Number of leading valid votes that establish the baseline. */
export const BASELINE_VOTES = 15;

/** Below this |tally|/votes ratio the baseline is flagged low-confidence. */
export const BASELINE_MARGIN_MIN = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BaselineMargin = {
  /** Sum of vote signs over the baseline window (negative ⇒ s0 = −1). */
  tally: number;
  /** Number of valid votes in the window (≤ BASELINE_VOTES). */
  votes: number;
};

export type LowerBodyIdentityResult = {
  /** Corrected frames. Unswapped frames are passed through by reference. */
  frames: PoseFrame[];
  /** Frame indices where the L/R swap was applied. */
  swappedFrames: number[];
  /** Baseline bilateral orientation, or null if it could not be established. */
  baselineSign: 1 | -1 | null;
  /** Baseline vote strength, or null if no valid votes existed. */
  baselineMargin: BaselineMargin | null;
  /** True when |tally|/votes < BASELINE_MARGIN_MIN — s0 is a weak majority. */
  lowConfidenceBaseline: boolean;
};

/** Serializable diagnostic for swing_debug.keypoint_identity. */
export type LowerBodyIdentityDebug = {
  swapped_frames: number[];
  baseline_sign: 1 | -1 | null;
  baseline_margin: BaselineMargin | null;
  low_confidence_baseline?: true;
};

export function toIdentityDebug(r: LowerBodyIdentityResult): LowerBodyIdentityDebug {
  const debug: LowerBodyIdentityDebug = {
    swapped_frames: r.swappedFrames,
    baseline_sign: r.baselineSign,
    baseline_margin: r.baselineMargin,
  };
  if (r.lowConfidenceBaseline) debug.low_confidence_baseline = true;
  return debug;
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

/**
 * Per-frame bilateral orientation vote: sign of Σ (rightX − leftX) over the
 * vote pairs. Returns null (abstain) when no pair is confident, when the
 * summed separation is below minSeparation, or on an exact tie.
 */
export function voteLowerBodyOrientation(
  frame: PoseFrame,
  minSeparation: number,
): 1 | -1 | null {
  let sum = 0;
  let separation = 0;
  let validPairs = 0;
  for (const [left, right] of VOTE_PAIRS) {
    const l = frame.joints[left];
    const r = frame.joints[right];
    if (!l || !r) continue;
    if ((l.confidence ?? 0) < VOTE_CONF_MIN || (r.confidence ?? 0) < VOTE_CONF_MIN) continue;
    sum += r.x - l.x;
    separation += Math.abs(r.x - l.x);
    validPairs++;
  }
  if (validPairs === 0 || separation < minSeparation || sum === 0) return null;
  return sum > 0 ? 1 : -1;
}

/**
 * Count frames whose decision-grade vote contradicts the baseline — the
 * frames the state machine acts on. Validation metric: a corrected stream
 * must measure 0.
 */
export function countIdentityCrossings(frames: PoseFrame[], baselineSign: 1 | -1): number {
  let count = 0;
  for (const frame of frames) {
    const v = voteLowerBodyOrientation(frame, DECISION_SEPARATION_MIN);
    if (v !== null && v !== baselineSign) count++;
  }
  return count;
}

function computeBaseline(frames: PoseFrame[]): {
  sign: 1 | -1 | null;
  margin: BaselineMargin | null;
} {
  let tally = 0;
  let votes = 0;
  for (const frame of frames) {
    const v = voteLowerBodyOrientation(frame, VOTE_SEPARATION_MIN);
    if (v === null) continue;
    tally += v;
    votes++;
    if (votes >= BASELINE_VOTES) break;
  }
  if (votes === 0) return { sign: null, margin: null };
  const margin: BaselineMargin = { tally, votes };
  if (tally === 0) return { sign: null, margin };
  return { sign: tally > 0 ? 1 : -1, margin };
}

// ---------------------------------------------------------------------------
// Swap
// ---------------------------------------------------------------------------

function relabel(
  joint: NormalizedJoint | undefined,
  name: JointName,
): NormalizedJoint | undefined {
  return joint ? { ...joint, name } : undefined;
}

/** Exchange all LOWER_BODY_PAIRS in a frame. Full joint objects move; `name` is rewritten. */
function swapFrame(frame: PoseFrame): PoseFrame {
  const joints = { ...frame.joints };
  for (const [left, right] of LOWER_BODY_PAIRS) {
    const l = frame.joints[left];
    const r = frame.joints[right];
    joints[left] = relabel(r, left);
    joints[right] = relabel(l, right);
  }
  return { ...frame, joints };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Correct lower-body L/R identity across a capture. Pure: input frames are
 * never mutated. Idempotent: applying to an already-corrected stream swaps
 * nothing.
 */
export function correctLowerBodyIdentity(frames: PoseFrame[]): LowerBodyIdentityResult {
  const baseline = computeBaseline(frames);
  const lowConfidenceBaseline =
    baseline.margin !== null &&
    Math.abs(baseline.margin.tally) / baseline.margin.votes < BASELINE_MARGIN_MIN;

  if (baseline.sign === null) {
    return {
      frames,
      swappedFrames: [],
      baselineSign: null,
      baselineMargin: baseline.margin,
      lowConfidenceBaseline,
    };
  }
  const s0 = baseline.sign;

  // Decision-grade votes only — weak votes (separation in
  // [VOTE_SEPARATION_MIN, DECISION_SEPARATION_MIN)) never change state.
  const votes = frames.map((f) => voteLowerBodyOrientation(f, DECISION_SEPARATION_MIN));
  const firstVoteIdx = votes.findIndex((v) => v !== null);
  if (firstVoteIdx === -1) {
    // No decision-grade evidence anywhere — leave the capture untouched.
    return {
      frames,
      swappedFrames: [],
      baselineSign: s0,
      baselineMargin: baseline.margin,
      lowConfidenceBaseline,
    };
  }

  const swappedFrames: number[] = [];
  // Lead-in backfill: seed from the first decision-grade vote so frames in
  // [0, firstVoteIdx) take a real decision instead of an implicit "false".
  let decision = votes[firstVoteIdx] !== s0;
  const corrected = frames.map((frame, i) => {
    const v = votes[i];
    if (v !== null) decision = v !== s0;
    if (!decision) return frame;
    swappedFrames.push(i);
    return swapFrame(frame);
  });

  return {
    frames: corrected,
    swappedFrames,
    baselineSign: s0,
    baselineMargin: baseline.margin,
    lowConfidenceBaseline,
  };
}
