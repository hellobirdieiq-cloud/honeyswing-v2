import type { PoseSequence } from '@/packages/pose/PoseTypes';
import type { PhaseTagRange } from './SwingRecord';

// Computes net spine-angle delta from address-phase median to impact-phase frame.
export function computeSpineDrift(
  sequence: PoseSequence,
  phases: PhaseTagRange[],
): number | null {
  // stub: returns null when address or impact phase frames are missing.
  throw new Error('Not implemented');
}

// Computes the backswing-to-downswing duration ratio (takeaway→top vs top→impact).
export function computeTempoRatio(
  sequence: PoseSequence,
  phases: PhaseTagRange[],
): number | null {
  // stub: returns null when either phase has < 2 frames.
  throw new Error('Not implemented');
}

// Computes the change in horizontal hip-spread (left-hip↔right-hip distance) from address to impact.
export function computeHipSpreadDelta(
  sequence: PoseSequence,
  phases: PhaseTagRange[],
): number | null {
  // stub: returns null when hip joint confidence falls below threshold in either phase.
  throw new Error('Not implemented');
}
