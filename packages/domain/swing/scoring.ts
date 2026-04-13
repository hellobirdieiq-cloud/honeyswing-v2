import { GolfAngles } from "./angles";
import { MetricConfidenceWeights } from "./cameraAngle";
import { METRIC_DEFINITIONS, type MetricKey } from "./metricDefinitions";
import { SwingTempo } from "./tempoAnalysis";

export type ScoringBreakdownEntry = {
  metric: string;
  score: number;
  weight: number;
  weighted: number;
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

  const metricKeys = Object.keys(METRIC_DEFINITIONS) as MetricKey[];
  const breakdown: ScoringBreakdownEntry[] = metricKeys.map((key) => {
    const def = METRIC_DEFINITIONS[key];
    const value = key === 'tempo'
      ? (tempo?.tempoRatio ?? null)
      : (angles[key as keyof GolfAngles] ?? null);
    const score = scoreAngle(value, def.ideal, def.tolerance);
    const weight = (weights?.[key as keyof MetricConfidenceWeights] ?? 1) * (value != null ? 1 : 0.5);
    return { metric: key, score, weight, weighted: score * weight };
  });

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
