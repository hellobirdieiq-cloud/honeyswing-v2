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
