import type { ClinicMetricKey } from './enums';

export interface PersonalBandSessionEntry {
  sessionId: string;
  clinicNumber: number;
  recordedAt: number;
  average: number;
  standardDeviation: number;
  sampleCount: number;
}

export interface PersonalBand {
  kidId: string;
  metric: ClinicMetricKey;
  average: number;
  standardDeviation: number;
  sampleCount: number;
  sessionHistory: PersonalBandSessionEntry[];
  updatedAt: number;
}
