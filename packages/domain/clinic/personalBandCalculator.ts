import type {
  PersonalBand,
  PersonalBandSessionEntry,
} from './PersonalBand';
import type { ClinicMetricKey } from './enums';

export interface BandSnapshot {
  average: number;
  standardDeviation: number;
  sampleCount: number;
}

interface WelfordState {
  count: number;
  mean: number;
  m2: number;
}

function readState(band: PersonalBand): WelfordState {
  const count = band.sampleCount;
  const mean = band.average;
  // SD is sample SD: SD = sqrt(M2 / (n-1)) → M2 = SD^2 * (n-1)
  const m2 = count > 1 ? band.standardDeviation * band.standardDeviation * (count - 1) : 0;
  return { count, mean, m2 };
}

function sampleSd(state: WelfordState): number {
  if (state.count < 2) return 0;
  return Math.sqrt(state.m2 / (state.count - 1));
}

// Creates an empty personal band for a kid + metric pair.
export function createPersonalBand(
  kidId: string,
  metric: ClinicMetricKey,
): PersonalBand {
  return {
    kidId,
    metric,
    average: 0,
    standardDeviation: 0,
    sampleCount: 0,
    sessionHistory: [],
    updatedAt: Date.now(),
  };
}

// Folds a new metric sample into the rolling average and standard deviation (Welford's online algorithm).
export function appendSample(
  band: PersonalBand,
  value: number,
): PersonalBand {
  const state = readState(band);
  const nextCount = state.count + 1;
  const delta = value - state.mean;
  const nextMean = state.mean + delta / nextCount;
  const delta2 = value - nextMean;
  const nextM2 = state.m2 + delta * delta2;
  const nextSd = nextCount < 2 ? 0 : Math.sqrt(nextM2 / (nextCount - 1));

  return {
    kidId: band.kidId,
    metric: band.metric,
    average: nextMean,
    standardDeviation: nextSd,
    sampleCount: nextCount,
    sessionHistory: band.sessionHistory.slice(),
    updatedAt: Date.now(),
  };
}

// Closes out the current session by snapshotting average/SD into sessionHistory.
export function archiveSession(
  band: PersonalBand,
  sessionId: string,
  clinicNumber: number,
  recordedAt: number,
): PersonalBand {
  const entry: PersonalBandSessionEntry = {
    sessionId,
    clinicNumber,
    recordedAt,
    average: band.average,
    standardDeviation: band.standardDeviation,
    sampleCount: band.sampleCount,
  };
  return {
    kidId: band.kidId,
    metric: band.metric,
    average: band.average,
    standardDeviation: band.standardDeviation,
    sampleCount: band.sampleCount,
    sessionHistory: [...band.sessionHistory, entry],
    updatedAt: Date.now(),
  };
}

// Returns true if a metric value falls within tolerance × SD of the band average.
export function isWithinBand(
  band: PersonalBand,
  value: number,
  toleranceSd: number = 1,
): boolean {
  return Math.abs(value - band.average) <= toleranceSd * band.standardDeviation;
}

// Returns the current average / SD / sampleCount snapshot.
export function snapshot(band: PersonalBand): BandSnapshot {
  return {
    average: band.average,
    standardDeviation: band.standardDeviation,
    sampleCount: band.sampleCount,
  };
}
