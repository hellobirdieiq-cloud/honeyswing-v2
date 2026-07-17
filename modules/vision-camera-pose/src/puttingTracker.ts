import { NativeModules } from 'react-native';

const { HoneyPuttingTrackerPlugin } = NativeModules;

/**
 * Putting CV go/no-go gate (Phase 1). Post-hoc ball + putter-head tracker over
 * a recorded front-on clip — classical CV in HoneyPuttingTrackerPlugin.swift,
 * NOT body pose. All detection thresholds are EXTERNAL ASSUMPTIONS in the
 * Swift plugin, uncalibrated until the Phase 0 fixture corpus exists.
 *
 * Coordinates are full-resolution upright-video pixels. `source` records which
 * detector produced the hit: "color" (threshold + connected components,
 * primary) or "vision" (VNDetectContoursRequest fallback — runs ONLY on frames
 * where the color pass's best confidence fell below the floor).
 */
export type PuttingBallDetection = {
  x: number;
  y: number;
  radiusPx: number;
  confidence: number;
  source: 'color' | 'vision';
};

/**
 * Head `source` values: "color"/"vision" — legacy blob detector (headDetector
 * "blob"); "shaft" — lower endpoint (or mat-level intersection when occluded)
 * of the RANSAC-fitted shaft line; "shaft_held" — no accepted fit this frame,
 * previous head re-emitted at decayed confidence (≤ 5 frames).
 */
export type PuttingHeadDetection = {
  x: number;
  y: number;
  areaPx: number;
  confidence: number;
  source: 'color' | 'vision' | 'shaft' | 'shaft_held';
};

/**
 * DIAGNOSTIC (options.debugCandidates) — one dark-blob candidate from the
 * head ROI, its factors broken out exactly as the live confidence formula
 * computed them (confidence = areaFactor × shapeFactor × proximityFactor,
 * raw pre-floor). Coordinates are full-resolution upright-video pixels.
 * Observation only — never influences selection.
 */
export type PuttingHeadCandidate = {
  x: number;
  y: number;
  areaPx: number;
  areaFactor: number;
  shapeFactor: number;
  proximityFactor: number;
  motionFactor: number;
  confidence: number;
};

/**
 * DIAGNOSTIC (options.debugCandidates, headDetector "shaft") — per-frame
 * shaft-fit telemetry. angleDeg is the signed lean of the fitted line (0 =
 * straight down, null when no line survived the gates); usedMask counts the
 * post-thin-filter candidates by source predicate (a pixel can count in
 * several); held = no accepted fit this frame, previous line/head re-emitted.
 */
export type PuttingShaftDebug = {
  angleDeg: number | null;
  inliers: number;
  span: number;
  candidateCount: number;
  usedMask: { dark: number; motion: number; edge: number };
  held: boolean;
  /** The frame's pose-prior angle (post-calibration), null when no prior. */
  poseAngleDeg: number | null;
  /** True when a pose prior gated this frame's fit (angle + anchor). */
  poseAnchorUsed: boolean;
};

/**
 * Pose-guided shaft prior (headDetector "shaft"), one entry per VIDEO GRID
 * frame (motion_frames indices align 1:1 with the 8.33ms grid — verified in
 * poseAngleScan). angleDeg = folded LeadWrist→TrailThumbTip pixel-space angle
 * minus the measured +3.0° bias; anchor = hand-cluster mean, NORMALIZED 0-1
 * upright frame space; confidence = min of the pair's confidences. null entry
 * (either pair joint ≤ 0.3 confidence) → that frame uses pure-CV gates.
 * PRIOR ONLY — gates the CV line fit; never a head position source, and the
 * pose phase detector is never invoked.
 */
export type PuttingPosePrior = {
  angleDeg: number;
  anchorX: number;
  anchorY: number;
  confidence: number;
};

/**
 * Per-frame pinned bar fit (headDetector "bar", Phase A2) — the v7.6.5
 * playground tracker's accepted line for this frame. COORDINATES ARE
 * ANALYSIS px @480w (NOT full-res — the frozen bar constants are literal in
 * that space). `source` is the acceptance ladder: "cv"/"recovery" = scored
 * sweep fits, "pose_fallback" = pre-impact pose line (no passing CV fit),
 * "predicted_hold" = post-impact prevAng+angVel hold, "none" = nothing this
 * frame (tracker state untouched). lengthMatch = 1−min(1,|spanPx−L|/L), null
 * while uncalibrated.
 */
export type PuttingShaftFit = {
  angleDeg: number;
  gripX: number;
  gripY: number;
  spanPx: number;
  matX: number | null;
  lengthMatch: number | null;
  score: number;
  pivotOffsetPx: number;
  source: 'cv' | 'recovery' | 'pose_fallback' | 'predicted_hold' | 'none';
};

/**
 * SHAFT_LEN rest-window calibration result (headDetector "bar"): shaftLenPx =
 * median contiguous tube extent of accepted UNCALIBRATED pinned fits over the
 * rest window (first 60% of pre-launch ball-present frames), FROZEN for the
 * swing. launchFrameIdx = the native guarded ball-launch frame (must equal the
 * TS detectImpact result — cross-checked on device). Analysis px @480w.
 */
export type PuttingBarCalibration = {
  shaftLenPx: number;
  restStartIdx: number;
  restEndIdx: number;
  acceptedFitCount: number;
  launchFrameIdx: number | null;
};

export type PuttingObjectFrame = {
  timestampMs: number;
  ball: PuttingBallDetection | null;
  head: PuttingHeadDetection | null;
  frameWidth: number;
  frameHeight: number;
  /**
   * Present only when options.debugCandidates AND headDetector "blob" — up to
   * the top-3 head-ROI dark blobs by raw pre-floor confidence.
   */
  headCandidates?: PuttingHeadCandidate[];
  /** Present only when options.debugCandidates AND headDetector "shaft". */
  shaftDebug?: PuttingShaftDebug;
  /** Present only when headDetector "bar" (analysis px @480w). */
  shaftFit?: PuttingShaftFit;
};

/**
 * Optional caller-supplied ball rest position, normalized 0-1 in upright
 * frame space. Presence switches the plugin into seeded mode (salvages
 * fixtures with multiple white objects): the rest-anchor pass only accepts
 * candidates within SEED_LOCK_RADIUS_PX of the seed, and per-frame ball
 * selection HARD-gates candidates farther than SEEDED_MAX_JUMP_PX from the
 * last accepted centroid (the seed until the first acceptance). Both radii
 * are EXTERNAL ASSUMPTION constants in HoneyPuttingTrackerPlugin.swift.
 */
export type PuttingBallSeed = { x: number; y: number };

export type PuttingTrackResult = {
  videoDurationMs: number;
  frameWidth: number;
  frameHeight: number;
  /**
   * "ball_rest" — head ROI anchored to the median ball centroid of the first
   * anchor-window frames. "unanchored" — the ball was moving (or undetected)
   * during the anchor window, so the head ROI widened to full frame width.
   * "seeded" — options.ballSeed was provided; the head ROI anchors around the
   * median of the seed-locked rest detections (the seed itself if none).
   */
  roiAnchor: 'ball_rest' | 'unanchored' | 'seeded';
  /** Which head detector ran (echoed from the plugin). Ball path unaffected. */
  headDetector: 'shaft' | 'blob' | 'bar';
  /** file:// URI of the dot-overlay .mov, or null if the writer failed. */
  overlayUri: string | null;
  frames: PuttingObjectFrame[];
  /**
   * headDetector "bar" only: SHAFT_LEN calibration result, or null when the
   * rest window produced no accepted fits (fitter ran uncalibrated with
   * span scoring; lengthMatch is null on every shaftFit). Absent in
   * shaft/blob modes.
   */
  barCalibration?: PuttingBarCalibration | null;
  /** headDetector "bar" only: the analysis-space dimensions shaftFit uses. */
  analysisWidth?: number;
  analysisHeight?: number;
};

export async function trackPuttingObjects(
  videoUri: string,
  stepMs: number,
  options: {
    writeOverlay: boolean;
    /**
     * "clean" (default) — the overlay .mov is raw decoded frames, nothing
     * drawn. "annotated" — markers/line/ROI burned in (debug). Tracking and
     * the ball path are unaffected either way.
     */
    overlayMode?: 'clean' | 'annotated';
    ballSeed?: PuttingBallSeed;
    debugCandidates?: boolean;
    /**
     * "shaft" (default) — RANSAC line fit on thin dark/moving/edge pixels,
     * head = lower endpoint. "blob" — legacy dark-blob detector, kept for
     * A/B on fixtures. "bar" — v7.6.5 pinned twin-edge bar fitter (Phase A2):
     * per-frame shaftFit export + SHAFT_LEN calibration; requires posePriors.
     */
    headDetector?: 'shaft' | 'blob' | 'bar';
    /**
     * Indexed by video grid frame; entries beyond the array (or null) fall
     * back to pure-CV gates. Shaft/bar modes only.
     */
    posePriors?: (PuttingPosePrior | null)[];
  },
): Promise<PuttingTrackResult> {
  return HoneyPuttingTrackerPlugin.trackPuttingObjects(videoUri, stepMs, options);
}

/**
 * One frame of the refinePutterHead spec: the predicted shaft state from the
 * TS smoothed series (packages/domain/putting/smoothShaftSeries). ANALYSIS px
 * @480w. The native pass computes the ellipse center itself as
 * (gripX,gripY) + unit(angleDeg) × (shaftLenPx + headExtPx).
 */
export type PuttingRefineSpecFrame = {
  gridIdx: number;
  gripX: number;
  gripY: number;
  angleDeg: number;
};

export type PuttingRefineSpec = {
  frames: PuttingRefineSpecFrame[];
  shaftLenPx: number;
  headExtPx: number;
};

/**
 * Refined head point (analysis px @480w). coasted = the greenness ellipse had
 * <12 candidate pixels, so the PREDICTED center was emitted (never a jump,
 * never a gap). candidateCount = pixels that voted (0 when coasted).
 */
export type PuttingRefinedPoint = {
  gridIdx: number;
  x: number;
  y: number;
  coasted: boolean;
  candidateCount: number;
};

export type PuttingRefineResult = {
  points: PuttingRefinedPoint[];
};

/**
 * Phase A2 fine-takeaway support: greenness-ellipse head refinement over a
 * ~41-frame window (spec §4.4 FINE). Decodes only up to the last requested
 * grid frame — cheap relative to a full tracking pass. Per-frame refine
 * failure coasts on the prediction; only malformed input rejects the call.
 */
export async function refinePutterHead(
  videoUri: string,
  stepMs: number,
  spec: PuttingRefineSpec,
): Promise<PuttingRefineResult> {
  return HoneyPuttingTrackerPlugin.refinePutterHead(videoUri, stepMs, spec);
}
