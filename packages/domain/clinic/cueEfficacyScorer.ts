import type { CueBlockRecord } from './CueBlock';
import type { SwingRecord } from './SwingRecord';
import type { ClinicMetricKey } from './enums';

export interface CueEfficacyScore {
  cueBlockId: string;
  metric: ClinicMetricKey;
  baselineAverage: number;
  postCueAverage: number;
  retentionAverage: number | null;
  accommodation: number;
  retention: number | null;
  metricMovement: number;
}

// Scores how strongly a cue shifted a metric toward the target across the 5 post-cue swings (0..1).
export function scoreAccommodation(
  baselineSwings: SwingRecord[],
  postCueSwings: SwingRecord[],
  metric: ClinicMetricKey,
  targetValue: number,
): number {
  // stub: returns 0 when no movement, 1 when fully reaches target.
  throw new Error('Not implemented');
}

// Scores how well the post-cue shift persisted into the retention probe swings (0..1, or null when retention absent).
export function scoreRetention(
  postCueSwings: SwingRecord[],
  retentionSwings: SwingRecord[],
  metric: ClinicMetricKey,
): number | null {
  // stub: returns null when retentionSwings is empty.
  throw new Error('Not implemented');
}

// Combines accommodation + retention into a per-cue-block efficacy summary.
export function scoreCueBlock(
  block: CueBlockRecord,
  baselineSwings: SwingRecord[],
  postCueSwings: SwingRecord[],
  retentionSwings: SwingRecord[],
  metric: ClinicMetricKey,
  targetValue: number,
): CueEfficacyScore {
  // stub
  throw new Error('Not implemented');
}
