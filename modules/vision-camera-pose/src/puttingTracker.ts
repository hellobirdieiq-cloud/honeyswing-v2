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
  headDetector: 'shaft' | 'blob';
  /** file:// URI of the dot-overlay .mov, or null if the writer failed. */
  overlayUri: string | null;
  frames: PuttingObjectFrame[];
};

export async function trackPuttingObjects(
  videoUri: string,
  stepMs: number,
  options: {
    writeOverlay: boolean;
    ballSeed?: PuttingBallSeed;
    debugCandidates?: boolean;
    /**
     * "shaft" (default) — RANSAC line fit on thin dark/moving/edge pixels,
     * head = lower endpoint. "blob" — legacy dark-blob detector, kept for
     * A/B on fixtures.
     */
    headDetector?: 'shaft' | 'blob';
    /**
     * Indexed by video grid frame; entries beyond the array (or null) fall
     * back to pure-CV gates. Shaft mode only.
     */
    posePriors?: (PuttingPosePrior | null)[];
  },
): Promise<PuttingTrackResult> {
  return HoneyPuttingTrackerPlugin.trackPuttingObjects(videoUri, stepMs, options);
}
