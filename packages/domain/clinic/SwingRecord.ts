import type {
  PhaseTag,
  StructuralProblem,
  BallContact,
  BallDirection,
  EffortLevel,
} from './enums';

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

export interface BallOutcome {
  direction: BallDirection;
  contact: BallContact;
}

export interface SwingRecord {
  id: string;
  kidId: string;
  sessionId: string;
  clinicNumber: number;
  recordedAt: number;
  metrics: MetricSnapshot;
  phaseTags: PhaseTagRange[];
  setupOk: boolean;
  effortLevel: EffortLevel;
  normalSwing: boolean;
  structuralProblem: StructuralProblem;
  ballOutcome: BallOutcome;
  notes?: string;
}
