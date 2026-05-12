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

export type PhaseTag =
  | 'address'
  | 'takeaway'
  | 'top'
  | 'transition'
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
  | 'flush'
  | 'thin'
  | 'fat'
  | 'toe'
  | 'heel'
  | 'topped'
  | 'whiff'
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

export type AttentionTarget =
  | 'hands'
  | 'club'
  | 'hips'
  | 'shoulders'
  | 'head'
  | 'spine'
  | 'feet'
  | 'ball'
  | 'target'
  | 'tempo-feel'
  | 'rhythm'
  | 'pressure'
  | 'release'
  | 'other';

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

export type EffortLevel = 'easy' | 'medium' | 'hard' | 'max';

export type ClinicMetricKey =
  | 'spineAngle'
  | 'spineDrift'
  | 'tempoRatio'
  | 'hipSpreadDelta'
  | 'leftElbowAngle'
  | 'rightElbowAngle'
  | 'leftKneeAngle'
  | 'rightKneeAngle'
  | 'hipRotation'
  | 'shoulderTilt';
