import type { CueBlockRecord } from './CueBlock';
import type { BallOutcome } from './SwingRecord';

export interface PredictionAccuracy {
  cueBlockId: string;
  directionMatch: boolean;
  contactMatch: boolean;
  confidenceWeighted: number;
}

export interface AccuracySummary {
  directionRate: number;
  contactRate: number;
  weightedRate: number;
  blockCount: number;
}

// Compares the cue block's prediction tap to the most-common actual ball outcome across the 5 post-cue swings.
export function evaluatePrediction(
  block: CueBlockRecord,
  postCueOutcomes: BallOutcome[],
): PredictionAccuracy {
  // stub: returns directionMatch=false / contactMatch=false when postCueOutcomes is empty.
  throw new Error('Not implemented');
}

// Aggregates Dave's prediction accuracy across many cue blocks.
export function rollingAccuracy(
  evaluations: PredictionAccuracy[],
): AccuracySummary {
  // stub: returns zeroed summary when evaluations is empty.
  throw new Error('Not implemented');
}
