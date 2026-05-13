export type Handedness = 'left' | 'right';

export type GripClassification =
  | 'weak'
  | 'neutral'
  | 'strong'
  | 'mixed'
  | 'unknown';

export type FaceAngleClassification =
  | 'open'
  | 'square'
  | 'closed'
  | 'unknown';

export type LumbarCupClassification =
  | 'flat'
  | 'slight'
  | 'pronounced'
  | 'unknown';

export type StanceClassification =
  | 'narrow'
  | 'shoulder-width'
  | 'wide'
  | 'unknown';

// TODO: pipeline emits 'follow_through' (SwingPhase)
// but clinic uses 'finish' — reconcile before
// implementing metricComputation stubs.
export type PhaseTag =
  | 'address'
  | 'takeaway'
  | 'top'
  | 'downswing'
  | 'impact'
  | 'finish';

export type StructuralProblem =
  | 'none'
  | 'reverse-pivot'
  | 'early-extension'
  | 'sway'
  | 'cast'
  | 'over-the-top'
  | 'chicken-wing'
  | 'lift'
  | 'other';

export type BallContact =
  | 'solid'
  | 'thin'
  | 'fat'
  | 'sky'
  | 'shank'
  | 'whiff'
  | 'topped'
  | 'unknown';

export type BallDirection =
  | 'pull'
  | 'pull-fade'
  | 'pull-hook'
  | 'straight'
  | 'fade'
  | 'slice'
  | 'draw'
  | 'hook'
  | 'push'
  | 'push-draw'
  | 'push-fade'
  | 'left'
  | 'right'
  | 'missed'
  | 'unknown';

export type CueFamily =
  | 'tempo'
  | 'spine-stability'
  | 'hip-rotation'
  | 'shoulder-turn'
  | 'wrist-set'
  | 'weight-shift'
  | 'follow-through'
  | 'setup'
  | 'other';

// Free text in v1.3 — UI soft-caps at 5 words via clampWords helper.
export type AttentionTarget = string;

export type PhysicalTest =
  | 'thoracic-rotation'
  | 'hip-internal-rotation'
  | 'hip-external-rotation'
  | 'shoulder-flexibility'
  | 'core-stability'
  | 'ankle-mobility'
  | 'thoracic-extension'
  | 'hamstring-flexibility'
  | 'wrist-mobility'
  | 'other';

export type PhysicalTestResult = 'pass' | 'fail' | 'partial';

export type EffortLevel = 'low' | 'medium' | 'high';

export type ClinicMetricKey =
  | 'spineAngle'
  | 'spineDrift'
  | 'tempoRatio'
  | 'hipSpreadDelta'
  | 'leftElbowAngle'
  | 'rightElbowAngle'
  | 'leftKneeAngle'
  | 'rightKneeAngle'
  | 'shoulderTilt';
