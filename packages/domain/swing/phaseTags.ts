/**
 * phaseTags.ts — phase-tag and metric-snapshot types used by swingRowBuilders.
 *
 * Relocated VERBATIM from packages/domain/clinic/{enums,SwingRecord}.ts when
 * the clinic wizard was removed (coach pivot Phase 4) — these three types were
 * the only clinic definitions non-clinic code depended on.
 */

// NOTE (pre-existing, from clinic/enums.ts): SwingPhase uses 'follow_through'
// but this taxonomy uses 'finish'.
export type PhaseTag =
  | 'address'
  | 'takeaway'
  | 'top'
  | 'downswing'
  | 'impact'
  | 'finish';

export interface MetricSnapshot {
  spineAngle: number | null;
  spineDrift: number | null;
  tempoRatio: number | null;
  hipSpreadDelta: number | null;
  leftElbowAngle: number | null;
  rightElbowAngle: number | null;
  leftKneeAngle: number | null;
  rightKneeAngle: number | null;
  shoulderTilt: number | null;
}

export interface PhaseTagRange {
  phase: PhaseTag;
  startFrameIndex: number;
  endFrameIndex: number;
}
