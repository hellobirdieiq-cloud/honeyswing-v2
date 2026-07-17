/**
 * types.ts — Putting tempo detector types (Phase A1).
 *
 * Pure domain types, no UI/native imports. These detectors consume series the
 * native putting tracker already exports (pose priors + per-frame ball
 * positions); they are NOT the full-swing phase detector and must never call
 * into packages/domain/swing.
 *
 * Coordinate spaces:
 *  - BallPoint x/y: FULL-RESOLUTION video pixels (1080-wide) — LAUNCH_DIST_PX
 *    in detectImpact.ts is a full-res threshold, used unscaled.
 *  - PosePriorSample anchorX/anchorY: normalized 0–1 (as exported by the dev
 *    harness). detectTop only uses velocity SIGNS and zero-crossings, which
 *    are scale-invariant, so no rescale is needed.
 *  - angleDeg: degrees, 0° = shaft straight down, + = head toward target
 *    (same convention as the harness pose priors).
 */

/** One pose-prior grid frame; null = no prior for that frame. */
export type PosePriorSample = {
  angleDeg: number;
  anchorX: number;
  anchorY: number;
  confidence?: number;
} | null;

/** Ball centroid for one grid frame (full-res px); null = not detected. */
export type BallPoint = { x: number; y: number } | null;

export type PuttingTempoResult = {
  backswingFrames: number;
  downswingFrames: number;
  backswingMs: number;
  downswingMs: number;
  /** backswing/downswing, rounded to 2dp. */
  ratio: number;
};

export type PuttingDetectorIntermediates = {
  sentinel_filtered_count: number;
  rest_pos: { x: number; y: number } | null;
  backswing_sign: 1 | -1 | null;
  crossing_frame: number | null;
  plateau: { start: number; end: number } | null;
  warnings: string[];
  /** Present after applyFineTakeaway (Phase A2); absent on coarse-only runs. */
  fine?: FineTakeawayIntermediates;
};

// ---------------------------------------------------------------------------
// Phase A2 — bar-fitter series, smoother, fine takeaway.
// All coordinates below are ANALYSIS px @480w (the native bar fitter's space),
// NOT full-res — matching the v8 playground DATA fixture space so every frozen
// constant (1.2px floor, ellipse 20/15, SHAFT_LEN≈194) stays literal.
// ---------------------------------------------------------------------------

/**
 * One per-frame pinned bar fit from the native tracker (headDetector:"bar").
 * source mirrors the playground acceptance ladder; null = frame not evaluated.
 */
export type ShaftFitSample = {
  angleDeg: number;
  gripX: number;
  gripY: number;
  spanPx: number;
  matX: number | null;
  lengthMatch: number | null;
  score: number;
  pivotOffsetPx: number;
  source: 'cv' | 'recovery' | 'pose_fallback' | 'predicted_hold' | 'none';
} | null;

/** Smoothed shaft series frame; (hx,hy) = predicted head at shaftLen+headExt. */
export type SmoothedShaftFrame = {
  ang: number;
  px: number;
  py: number;
  hx: number;
  hy: number;
  anchor: boolean;
};

/** Refined head point from the native refinePutterHead pass (coast = prediction used). */
export type RefinedHeadPoint = {
  gridIdx: number;
  x: number;
  y: number;
  coasted: boolean;
};

export type FineTakeawayIntermediates = {
  coarse_takeaway: number | null;
  onset: number | null;
  hard_cross: number | null;
  sigma_px: number | null;
  med_rest_px: number | null;
  threshold_px: number | null;
  ramp_floor_px: number | null;
  refine_window: { lo: number; hi: number } | null;
  ref_window: { lo: number; hi: number } | null;
  head_ext_px: number | null;
  disp_by_frame: Record<string, number> | null;
  coasted_count: number | null;
  anchor_count: number | null;
};

/**
 * Return shape of runPuttingDetectors — this exact object is embedded in the
 * dev-harness export JSON as `putting_detectors` (schema_version 2).
 */
export type PuttingDetectorsResult = {
  impactFrame: number | null;
  topFrame: number | null;
  takeawayFrame: number | null;
  tempo: PuttingTempoResult | null;
  intermediates: PuttingDetectorIntermediates;
};
