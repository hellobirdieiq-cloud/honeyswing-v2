import { GolfAngles } from "./angles";
import { MetricConfidenceWeights } from "./cameraAngle";
import { METRIC_DEFINITIONS, type MetricKey } from "./metricDefinitions";
import { SwingTempo } from "./tempoAnalysis";

const ANGLE_METRIC_KEYS: MetricKey[] = [
  'spineAngle', 'leftElbowAngle', 'rightElbowAngle',
  'leftKneeAngle', 'rightKneeAngle', 'shoulderTilt',
];

export type ScoringBreakdownEntry = {
  metric: string;
  score: number;
  weight: number;
  weighted: number;
  dataQuality: 'measured' | 'missing';
};

export type ScoringResult = {
  score: number;
  honeyBoom: boolean;
  breakdown: ScoringBreakdownEntry[];
};

export function scoreAngle(value: number | null, ideal: number, tolerance: number): number {
  if (value == null) return 50;
  const diff = Math.abs(value - ideal);
  const raw = 100 - (diff / tolerance) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function scoreSwing(params: {
  angles: GolfAngles;
  tempo: SwingTempo | null;
  weights?: MetricConfidenceWeights;
}): ScoringResult {
  const { angles, tempo, weights } = params;

  const breakdown: ScoringBreakdownEntry[] = ANGLE_METRIC_KEYS.map((key) => {
    const def = METRIC_DEFINITIONS[key];
    const value = angles[key];
    const score = scoreAngle(value, def.ideal, def.tolerance);
    const weight = (weights?.[key] ?? 1) * (value != null ? 1 : 0.5);
    return { metric: key, score, weight, weighted: score * weight, dataQuality: value != null ? 'measured' as const : 'missing' as const };
  });

  // Tempo — not an angle metric, appended separately
  const tempoScore = tempo ? scoreAngle(tempo.tempoRatio, 3, 1.5) : 50;
  const tempoWeight = (weights?.tempo ?? 1) * (tempo ? 1 : 0.5);
  breakdown.push({ metric: 'tempo', score: tempoScore, weight: tempoWeight, weighted: tempoScore * tempoWeight, dataQuality: tempo != null ? 'measured' as const : 'missing' as const });

  const totalWeight = breakdown.reduce((sum, e) => sum + e.weight, 0);
  const weightedSum = breakdown.reduce((sum, e) => sum + e.weighted, 0);

  const score = totalWeight > 0
    ? Math.max(0, Math.min(100, Math.round(weightedSum / totalWeight)))
    : 50;

  return {
    score,
    honeyBoom: score >= 85,
    breakdown,
  };
}
