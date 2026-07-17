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
