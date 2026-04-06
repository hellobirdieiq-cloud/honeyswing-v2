/**
 * cameraGuidance.ts — Task 13: Camera Guidance
 *
 * Real-time camera angle classification for the record screen.
 * Uses shoulder separation from live pose frames to show
 * red/yellow/green guidance before recording starts.
 *
 * Thresholds derived from cameraAngle.ts (Task 4) but simplified:
 * shoulder-only (no hip spread), tuned for pre-recording positioning.
 */

// ---------------------------------------------------------------------------
// Classification types
// ---------------------------------------------------------------------------

export type CameraGuidanceColor = 'good' | 'borderline' | 'poor';

export interface CameraGuidanceResult {
  color: CameraGuidanceColor;
  label: string;
}

// ---------------------------------------------------------------------------
// Thresholds — named constants for easy tuning after device testing
// ---------------------------------------------------------------------------

/** Minimum shoulder separation (normalized) for "good" angle */
export const GOOD_MIN = 0.15;

/** Maximum shoulder separation (normalized) for "good" angle */
export const GOOD_MAX = 0.35;

/** Minimum shoulder separation for "borderline" (below GOOD_MIN) */
export const BORDERLINE_LOW_MIN = 0.08;

/** Maximum shoulder separation for "borderline" (above GOOD_MAX) */
export const BORDERLINE_HIGH_MAX = 0.45;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const LABELS: Record<CameraGuidanceColor, string> = {
  good: 'Great angle',
  borderline: 'Adjust angle',
  poor: 'Move to the side',
};

export function classifyCameraAngle(separation: number): CameraGuidanceResult {
  let color: CameraGuidanceColor;

  if (separation >= GOOD_MIN && separation <= GOOD_MAX) {
    color = 'good';
  } else if (
    (separation >= BORDERLINE_LOW_MIN && separation < GOOD_MIN) ||
    (separation > GOOD_MAX && separation <= BORDERLINE_HIGH_MAX)
  ) {
    color = 'borderline';
  } else {
    color = 'poor';
  }

  return { color, label: LABELS[color] };
}

// ---------------------------------------------------------------------------
// EMA smoother — prevents flickering from single noisy frames
// ---------------------------------------------------------------------------

/** EMA smoothing factor. Higher = more responsive, lower = more stable. */
export const EMA_ALPHA = 0.3;

/**
 * Compute exponential moving average.
 * Returns newValue when previousEma is null (first frame).
 */
export function emaSmooth(
  previousEma: number | null,
  newValue: number,
  alpha: number = EMA_ALPHA,
): number {
  if (previousEma === null) return newValue;
  return alpha * newValue + (1 - alpha) * previousEma;
}

/**
 * Extract shoulder separation from raw landmarks array.
 * Returns null if shoulders not found or confidence too low.
 *
 * landmarks: array of { name, x, y, inFrameLikelihood } from the native detector
 */
export function extractShoulderSeparation(
  landmarks: readonly { name: string; x: number; y: number; inFrameLikelihood: number }[],
  minConfidence: number = 0.5,
): number | null {
  const left = landmarks.find(l => l.name === 'leftShoulder');
  const right = landmarks.find(l => l.name === 'rightShoulder');

  if (
    !left || !right ||
    left.inFrameLikelihood < minConfidence ||
    right.inFrameLikelihood < minConfidence
  ) {
    return null;
  }

  return Math.abs(right.x - left.x);
}
