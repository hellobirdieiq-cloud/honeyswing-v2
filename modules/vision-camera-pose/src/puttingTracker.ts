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

export type PuttingHeadDetection = {
  x: number;
  y: number;
  areaPx: number;
  confidence: number;
  source: 'color' | 'vision';
};

export type PuttingObjectFrame = {
  timestampMs: number;
  ball: PuttingBallDetection | null;
  head: PuttingHeadDetection | null;
  frameWidth: number;
  frameHeight: number;
};

export type PuttingTrackResult = {
  videoDurationMs: number;
  frameWidth: number;
  frameHeight: number;
  /**
   * "ball_rest" — head ROI anchored to the median ball centroid of the first
   * anchor-window frames. "unanchored" — the ball was moving (or undetected)
   * during the anchor window, so the head ROI widened to full frame width.
   */
  roiAnchor: 'ball_rest' | 'unanchored';
  /** file:// URI of the dot-overlay .mov, or null if the writer failed. */
  overlayUri: string | null;
  frames: PuttingObjectFrame[];
};

export async function trackPuttingObjects(
  videoUri: string,
  stepMs: number,
  options: { writeOverlay: boolean },
): Promise<PuttingTrackResult> {
  return HoneyPuttingTrackerPlugin.trackPuttingObjects(videoUri, stepMs, options);
}
