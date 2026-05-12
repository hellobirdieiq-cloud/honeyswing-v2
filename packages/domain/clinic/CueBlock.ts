import type {
  CueFamily,
  AttentionTarget,
  BallContact,
  BallDirection,
} from './enums';

export interface PredictionTap {
  direction: BallDirection;
  contact: BallContact;
  confidence: number;
}

export interface CueBlockRecord {
  id: string;
  kidId: string;
  sessionId: string;
  clinicNumber: number;
  recordedAt: number;
  cueText: string;
  cueFamily: CueFamily;
  prediction: PredictionTap;
  attentionIntent: AttentionTarget;
  attentionActual: AttentionTarget;
  postCueSwingIds: string[];
  retentionProbeSwingIds: string[];
  notes?: string;
}
