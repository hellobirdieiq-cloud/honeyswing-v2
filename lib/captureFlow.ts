/**
 * captureFlow.ts — pure decision helpers extracted VERBATIM from useSwingCapture.ts
 * so they can be unit-tested without a React-Native renderer. Type-only imports
 * (erased at runtime) keep this module graph-free for the tsx test harness.
 * No logic changes; useSwingCapture.ts calls these.
 */
import type { CapturePhase } from './useSwingCapture';
import type { CaptureClassification } from './captureValidity';

export type NavigationBlockReason = 'phase' | 'analysis' | 'video' | 'navigated' | null;

/**
 * Reason navigation is blocked, or null when clear to navigate. Same precedence
 * as tryNavigate's inline gate: phase → analysis → video → navigated.
 */
export function computeNavigationBlockReason(state: {
  phase: CapturePhase;
  analysisReady: boolean;
  video: 'pending' | null | string;
  navigated: boolean;
}): NavigationBlockReason {
  return (
    state.phase !== 'complete' ? 'phase' :
    !state.analysisReady ? 'analysis' :
    state.video === 'pending' ? 'video' :
    state.navigated ? 'navigated' :
    null
  );
}

/**
 * Override the capture classification to a partial "no-swing" when phase detection
 * fell back; otherwise pass the base classification through unchanged.
 */
export function deriveClassification(
  base: CaptureClassification,
  fallbackGateReason: string | null,
): CaptureClassification {
  return fallbackGateReason
    ? {
        ...base,
        validity: 'partial' as const,
        reason: 'no-swing',
      }
    : base;
}
