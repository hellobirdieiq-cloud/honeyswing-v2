/**
 * confidenceScore.ts — Task 6: Composite Confidence Score
 *
 * Produces a 0-1 confidence signal per swing. Consumed by:
 *   - Task 7 (frequency limiter): suppress tips when confidence < threshold
 *   - Task 8 (positive reinforcement): only celebrate when confidence is high
 *   - swing_debug: full breakdown for tuning
 *
 * Does NOT touch scoring integration — Task 4 already wired camera-angle
 * weights into scoreSwing(). This module adds an *overall* confidence
 * signal alongside the score.
 *
 * Weight allocation (sums to 1.0):
 *   Joint visibility:         0.40  (can you see the landmarks?)
 *   Camera angle clarity:     0.30  (do you know which metrics to trust?)
 *   Phase detection quality:  0.20  (are you measuring at the right swing phase?)
 *   Frame coverage:           0.10  (more frames → more averaging → less noise)
 *
 * Unknown angle design note:
 *   Unknown camera scores 0.10–0.30 (based on nearness to a classification
 *   boundary). With everything else perfect, a dead-center unknown produces
 *   overall ≈ 0.74 → medium tier. A near-boundary unknown produces ≈ 0.79 →
 *   high tier. This is intentional: truly ambiguous angles get conservative
 *   treatment, while nearly-classifiable angles aren't penalized.
 */

import type { PoseFrame } from '../../pose/PoseTypes';
import type { CameraAngleResult, MetricConfidenceWeights } from './cameraAngle';
import type { GatedMetricKey, VisibilityWeightingResult } from './visibilityWeighting';
import { msPerFrameFromFrames, msToFrames } from './phaseDetectionShared';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SwingConfidence {
  /** Composite confidence 0-1 */
  overall: number;

  /** Confidence tier for downstream gating */
  tier: 'high' | 'medium' | 'low';

  /** Per-signal breakdown for swing_debug */
  components: ConfidenceComponents;
}

export interface ConfidenceComponents {
  /** 0-1: key joints visible across measurement frames */
  jointVisibility: number;
  /** 0-1: camera angle classified clearly (front/side) vs unknown */
  cameraAngle: number;
  /** 0-1: heuristic phase windows (1.0) vs mid-frame fallback (0.3) */
  phaseDetection: number;
  /** 0-1: capture coverage relative to the GOOD_MS threshold */
  frameCoverage: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Signal weights — sum to 1.0 */
const WEIGHT_JOINT_VISIBILITY = 0.40;
const WEIGHT_CAMERA_ANGLE = 0.30;
const WEIGHT_PHASE_DETECTION = 0.20;
const WEIGHT_FRAME_COVERAGE = 0.10;

/** Tier thresholds (on 0-1 scale) */
export const CONFIDENCE_HIGH = 0.75;
export const CONFIDENCE_MEDIUM = 0.50;

/**
 * Frame coverage scoring curve, in ms of capture (1c A4: the ramp measures
 * physical coverage, not frame counts — 15/60 frames were 60fps-only).
 * 0 frames → 0.0.
 * Below MIN_MS → linear ramp to 0.3.
 * MIN_MS to GOOD_MS → linear ramp 0.3 to 1.0.
 * Above GOOD_MS → 1.0.
 */
const MIN_MS = 250;
const GOOD_MS = 1000;
// 60fps frame-count fallbacks, used only when frame timestamps are
// degenerate (span 0 → msPerFrameFromFrames returns 0).
const MIN_FRAMES = 15;
const GOOD_FRAMES = 60;

/** Key joints for visibility scoring — the joints swing analysis depends on. */
const KEY_JOINTS = [
  'leftShoulder',
  'rightShoulder',
  'leftHip',
  'rightHip',
  'leftElbow',
  'rightElbow',
  'leftWrist',
  'rightWrist',
  'leftKnee',
  'rightKnee',
] as const;

/** Minimum landmark confidence to count as "visible" */
const VISIBILITY_THRESHOLD = 0.5;

/** Below this camera weight, a metric is hidden regardless of tier. */
const CAMERA_WEIGHT_THRESHOLD = 0.3;

/**
 * Metrics allowed at medium confidence tier.
 * Stable enough to show even when overall confidence isn't high.
 * Excludes hipSpreadDelta (camera-angle dependent) and elbows (noisy).
 */
const MEDIUM_TIER_METRICS: ReadonlySet<string> = new Set([
  'tempo',
  'spineAngle',
  'shoulderTilt',
  'leftKneeAngle',
  'rightKneeAngle',
]);

// ─── Scoring Functions ────────────────────────────────────────────────────────

/**
 * Camera angle sub-score.
 * Known angle (front or side): 0.80–1.0, scaled by distance past classification threshold.
 * Unknown: 0.10–0.30, scaled by nearness to a classification boundary.
 */
function scoreCameraAngle(cameraAngle: CameraAngleResult): number {
  const { angle, avgSpread, footIndexNorm } = cameraAngle;

  if (angle === 'face_on') {
    // [EXTERNAL ASSUMPTION] thresholds empirically derived from 6 swings (3 DTL, 3 face-on)
    const primary = footIndexNorm ?? avgSpread;
    const lo = footIndexNorm != null ? 0.131 : 0.008;
    const hi = footIndexNorm != null ? 0.827 : 0.015;
    const clarity = Math.min((primary - lo) / (hi - lo), 1.0);
    return 0.80 + 0.20 * Math.max(clarity, 0);
  }

  if (angle === 'dtl') {
    const clarity = Math.min((0.08 - avgSpread) / 0.04, 1.0);
    return 0.80 + 0.20 * Math.max(clarity, 0);
  }

  // Unknown: 0.10 base + up to 0.20 bonus for nearness to a threshold.
  const distToFront = Math.abs(avgSpread - 0.15);
  const distToSide = Math.abs(avgSpread - 0.08);
  const closestDist = Math.min(distToFront, distToSide);
  const nearness = Math.max(0, 1.0 - closestDist / 0.04);
  return 0.10 + 0.20 * nearness;
}

/**
 * Phase detection sub-score.
 * Heuristic phase windows → 1.0.
 * Mid-frame fallback → 0.3.
 */
function scorePhaseDetection(method: 'heuristic' | 'fallback'): number {
  return method === 'heuristic' ? 1.0 : 0.3;
}

/**
 * Frame count sub-score against rate-resolved thresholds.
 * Graduated: 0 → 0.0, below minFrames → up to 0.3,
 * minFrames to goodFrames → 0.3 to 1.0, above → 1.0.
 */
function scoreFrameCount(frameCount: number, minFrames: number, goodFrames: number): number {
  if (frameCount >= goodFrames) return 1.0;
  if (frameCount <= 0) return 0.0;
  if (frameCount < minFrames) return (frameCount / minFrames) * 0.3;
  return 0.3 + 0.7 * ((frameCount - minFrames) / (goodFrames - minFrames));
}

/**
 * Joint visibility sub-score.
 * Blends average joint visibility (60%) with clean-frame ratio (40%).
 * Accesses frame.joints[jointName] per PoseFrame type.
 */
function scoreJointVisibility(frames: PoseFrame[]): number {
  if (frames.length === 0) return 0.0;

  let totalVisible = 0;
  let totalChecked = 0;
  let allVisibleFrames = 0;

  for (const frame of frames) {
    let allVisibleThisFrame = true;
    const joints = frame.joints as Record<
      string,
      { x: number; y: number; z: number; confidence: number } | undefined
    >;

    for (const joint of KEY_JOINTS) {
      totalChecked++;
      const landmark = joints[joint];
      if (landmark && (landmark.confidence ?? 0) >= VISIBILITY_THRESHOLD) {
        totalVisible++;
      } else {
        allVisibleThisFrame = false;
      }
    }

    if (allVisibleThisFrame) {
      allVisibleFrames++;
    }
  }

  const avgVisibility = totalChecked > 0 ? totalVisible / totalChecked : 0;
  const cleanFrameRatio = allVisibleFrames / frames.length;
  return 0.6 * avgVisibility + 0.4 * cleanFrameRatio;
}

// ─── Main Function ────────────────────────────────────────────────────────────

/**
 * Compute composite confidence score for a swing.
 *
 * @param frames - Full PoseSequence (for visibility + frame count)
 * @param cameraAngle - From detectCameraAngle() (Task 4)
 * @param isHeuristicPhases - true if phase detection used heuristic windows
 * @param measurementFrameIndices - Only score visibility on these indices (optional)
 */
export function computeSwingConfidence(
  frames: PoseFrame[],
  cameraAngle: CameraAngleResult,
  isHeuristicPhases: boolean,
  measurementFrameIndices?: number[],
): SwingConfidence {
  if (frames.length === 0) {
    return {
      overall: 0,
      tier: 'low',
      components: { jointVisibility: 0, cameraAngle: 0, phaseDetection: 0, frameCoverage: 0 },
    };
  }

  const visibilityFrames = measurementFrameIndices
    ? measurementFrameIndices.map(i => frames[i]).filter(Boolean)
    : frames;

  const jointVisibility = scoreJointVisibility(visibilityFrames);
  const cameraAngleScore = scoreCameraAngle(cameraAngle);
  const phaseDetection = scorePhaseDetection(isHeuristicPhases ? 'heuristic' : 'fallback');
  const msPerFrame = msPerFrameFromFrames(frames);
  const minFrames = msPerFrame > 0 ? msToFrames(MIN_MS, msPerFrame) : MIN_FRAMES;
  const goodFrames = msPerFrame > 0 ? msToFrames(GOOD_MS, msPerFrame) : GOOD_FRAMES;
  const frameCoverage = scoreFrameCount(frames.length, minFrames, goodFrames);

  const raw =
    WEIGHT_JOINT_VISIBILITY * jointVisibility +
    WEIGHT_CAMERA_ANGLE * cameraAngleScore +
    WEIGHT_PHASE_DETECTION * phaseDetection +
    WEIGHT_FRAME_COVERAGE * frameCoverage;

  const overall = Math.max(0, Math.min(1, raw));

  const tier: SwingConfidence['tier'] =
    overall >= CONFIDENCE_HIGH ? 'high' :
    overall >= CONFIDENCE_MEDIUM ? 'medium' :
    'low';

  return {
    overall: Math.round(overall * 1000) / 1000,
    tier,
    components: {
      jointVisibility: Math.round(jointVisibility * 1000) / 1000,
      cameraAngle: Math.round(cameraAngleScore * 1000) / 1000,
      phaseDetection: Math.round(phaseDetection * 1000) / 1000,
      frameCoverage: Math.round(frameCoverage * 1000) / 1000,
    },
  };
}

// ─── Downstream Helpers (Task 7/8) ────────────────────────────────────────────

/**
 * Determines whether a specific metric should be shown to the user.
 * Combines confidence tier gating with camera-angle weight gating.
 *
 * 1. Low tier → block everything
 * 2. Camera weight < 0.3 → block (regardless of tier)
 * 3. Medium tier → only allow MEDIUM_TIER_METRICS
 * 4. High tier + sufficient weight → show
 */
export function shouldShowMetric(
  metric: string,
  confidence: SwingConfidence,
  cameraAngle: CameraAngleResult,
): boolean {
  if (confidence.tier === 'low') return false;

  const weight = cameraAngle.weights[metric as keyof MetricConfidenceWeights];
  if (weight === undefined || weight < CAMERA_WEIGHT_THRESHOLD) return false;

  if (confidence.tier === 'medium') {
    return MEDIUM_TIER_METRICS.has(metric);
  }

  return true;
}

// ─── SCR-0b-0: Per-metric measurement confidence exposure ─────────────────────

/**
 * Decompose per-metric measurement confidence into its two independent signals
 * for the scoring layer (SCR-0b-2 will weight scores by these). Pure, additive,
 * no aggregation — SCR-0b-2 owns aggregation math.
 *
 * - visibilityConfidence: from per-metric MetricWeightingResult.avgWeight
 *   (landmark-derived, per-frame-aggregated). Defaults to 1 when visibility
 *   data is unavailable (e.g. mid_frame_fallback path).
 * - cameraConfidence: from camera-angle MetricConfidenceWeights table
 *   (front/side/unknown). Defaults to 1 if the key is absent.
 */
export function getMetricConfidence(
  metric: GatedMetricKey,
  cameraWeights: MetricConfidenceWeights,
  visibility: VisibilityWeightingResult | null,
): { visibilityConfidence: number; cameraConfidence: number } {
  return {
    visibilityConfidence: visibility?.metrics[metric]?.avgWeight ?? 1,
    cameraConfidence: cameraWeights[metric] ?? 1,
  };
}
