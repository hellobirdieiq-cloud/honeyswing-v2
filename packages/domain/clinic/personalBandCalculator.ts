import type { PersonalBand } from './PersonalBand';
import type { ClinicMetricKey } from './enums';

export interface BandSnapshot {
  average: number;
  standardDeviation: number;
  sampleCount: number;
}

// Creates an empty personal band for a kid + metric pair.
export function createPersonalBand(
  kidId: string,
  metric: ClinicMetricKey,
): PersonalBand {
  // stub: returns a band with zeroed stats and empty sessionHistory.
  throw new Error('Not implemented');
}

// Folds a new metric sample into the rolling average and standard deviation.
export function appendSample(
  band: PersonalBand,
  value: number,
): PersonalBand {
  // stub: returns a new band with updated average / SD / sampleCount; does not mutate input.
  throw new Error('Not implemented');
}

// Closes out the current session by snapshotting average/SD into sessionHistory.
export function archiveSession(
  band: PersonalBand,
  sessionId: string,
  clinicNumber: number,
  recordedAt: number,
): PersonalBand {
  // stub: appends a PersonalBandSessionEntry to band.sessionHistory.
  throw new Error('Not implemented');
}

// Returns true if a metric value falls within tolerance × SD of the band average.
export function isWithinBand(
  band: PersonalBand,
  value: number,
  toleranceSd?: number,
): boolean {
  // stub: defaults toleranceSd to 1.0 when not provided.
  throw new Error('Not implemented');
}

// Returns the current average / SD / sampleCount snapshot.
export function snapshot(band: PersonalBand): BandSnapshot {
  // stub
  throw new Error('Not implemented');
}
