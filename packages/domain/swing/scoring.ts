import { GolfAngles } from "./angles";
import { MetricConfidenceWeights } from "./cameraAngle";
import { SwingTempo } from "./tempoAnalysis";

// ─── Tempo 9-band scoring ──────────────────────────────────────────────────
// Headline score is tempo-only. Ratio maps to one of 9 scores, with the
// green band (score 100) sitting at the optimum and scores tapering on
// either side. Lower bands are half-open on the upper side; the green band
// is inclusive on both sides; upper bands are half-open on the lower side.
//   ratio < TEMPO_B1_UPPER                              → TEMPO_SCORE_FAR_LOW
//   ratio in [TEMPO_B1_UPPER, TEMPO_B2_UPPER)           → TEMPO_SCORE_LOW_3
//   ratio in [TEMPO_B2_UPPER, TEMPO_B3_UPPER)           → TEMPO_SCORE_LOW_2
//   ratio in [TEMPO_B3_UPPER, TEMPO_GREEN_LOWER)        → TEMPO_SCORE_LOW_1
//   ratio in [TEMPO_GREEN_LOWER, TEMPO_GREEN_UPPER]     → TEMPO_SCORE_GREEN
//   ratio in (TEMPO_GREEN_UPPER, TEMPO_B6_UPPER]        → TEMPO_SCORE_HIGH_1
//   ratio in (TEMPO_B6_UPPER, TEMPO_B7_UPPER]           → TEMPO_SCORE_HIGH_2
//   ratio in (TEMPO_B7_UPPER, TEMPO_B8_UPPER]           → TEMPO_SCORE_HIGH_3
//   ratio > TEMPO_B8_UPPER                              → TEMPO_SCORE_FAR_HIGH

export const TEMPO_B1_UPPER = 0.5;
export const TEMPO_B2_UPPER = 1.0;
export const TEMPO_B3_UPPER = 1.5;
export const TEMPO_GREEN_LOWER = 2.0;
export const TEMPO_GREEN_UPPER = 4.3;
export const TEMPO_B6_UPPER = 5.0;
export const TEMPO_B7_UPPER = 6.0;
export const TEMPO_B8_UPPER = 7.0;

export const TEMPO_SCORE_FAR_LOW = 25;
export const TEMPO_SCORE_LOW_3 = 60;
export const TEMPO_SCORE_LOW_2 = 70;
export const TEMPO_SCORE_LOW_1 = 80;
export const TEMPO_SCORE_GREEN = 100;
export const TEMPO_SCORE_HIGH_1 = 90;
export const TEMPO_SCORE_HIGH_2 = 75;
export const TEMPO_SCORE_HIGH_3 = 60;
export const TEMPO_SCORE_FAR_HIGH = 25;

export type TempoBand = 'red' | 'yellow' | 'green';

export const TEMPO_BAND_COLORS: Record<TempoBand, string> = {
  green: '#44CC44',
  yellow: '#FFB020',
  red: '#FF4444',
};

export function scoreTempoTrafficLight(ratio: number): {
  score: number;
  isGreen: boolean;
  band: TempoBand;
} {
  let score: number;
  if (ratio < TEMPO_B1_UPPER) score = TEMPO_SCORE_FAR_LOW;
  else if (ratio < TEMPO_B2_UPPER) score = TEMPO_SCORE_LOW_3;
  else if (ratio < TEMPO_B3_UPPER) score = TEMPO_SCORE_LOW_2;
  else if (ratio < TEMPO_GREEN_LOWER) score = TEMPO_SCORE_LOW_1;
  else if (ratio <= TEMPO_GREEN_UPPER) score = TEMPO_SCORE_GREEN;
  else if (ratio <= TEMPO_B6_UPPER) score = TEMPO_SCORE_HIGH_1;
  else if (ratio <= TEMPO_B7_UPPER) score = TEMPO_SCORE_HIGH_2;
  else if (ratio <= TEMPO_B8_UPPER) score = TEMPO_SCORE_HIGH_3;
  else score = TEMPO_SCORE_FAR_HIGH;

  const isGreen = score === TEMPO_SCORE_GREEN;
  const band: TempoBand = isGreen ? 'green' : score >= TEMPO_SCORE_LOW_3 ? 'yellow' : 'red';
  return { score, isGreen, band };
}

// ─── ScoringResult shape (preserved for downstream compatibility) ──────────

export type ScoringBreakdownEntry = {
  metric: string;
  score: number;
  weight: number;
  weighted: number;
  dataQuality: 'measured' | 'missing';
};

export type ScoringResult = {
  score: number | null;
  honeyBoom: boolean;
  breakdown: ScoringBreakdownEntry[];
};

export function isMeasured(entry: ScoringBreakdownEntry): boolean {
  return entry.dataQuality === 'measured';
}

export function scoreAngle(
  value: number | null,
  ideal: number,
  underTolerance: number,
  overTolerance: number,
): number | null {
  if (value == null) return null;
  const diff = value - ideal;
  const tol = diff >= 0 ? overTolerance : underTolerance;
  const raw = 100 - (Math.abs(diff) / tol) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function scoreSwing(params: {
  angles: GolfAngles;
  tempo: SwingTempo | null;
  weights?: MetricConfidenceWeights;
  suppressedMetrics?: ReadonlySet<string>;
}): ScoringResult {
  const { tempo } = params;

  if (tempo == null) {
    return {
      score: null,
      honeyBoom: false,
      breakdown: [
        { metric: 'tempo', score: 0, weight: 1, weighted: 0, dataQuality: 'missing' },
      ],
    };
  }

  const { score, isGreen } = scoreTempoTrafficLight(tempo.tempoRatio);

  return {
    score,
    honeyBoom: isGreen,
    breakdown: [
      { metric: 'tempo', score, weight: 1, weighted: score, dataQuality: 'measured' },
    ],
  };
}
