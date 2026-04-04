import { GolfAngles } from "./angles";
import { MetricConfidenceWeights } from "./cameraAngle";
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

function scoreAngle(value: number | null, ideal: number, tolerance: number): number {
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

  const entries: { score: number; weight: number }[] = [
    { score: scoreAngle(angles.spineAngle, 35, 20),       weight: (weights?.spineAngle ?? 1) * (angles.spineAngle != null ? 1 : 0.5) },
    { score: scoreAngle(angles.leftElbowAngle, 165, 40),  weight: (weights?.leftElbowAngle ?? 1) * (angles.leftElbowAngle != null ? 1 : 0.5) },
    { score: scoreAngle(angles.rightElbowAngle, 165, 40), weight: (weights?.rightElbowAngle ?? 1) * (angles.rightElbowAngle != null ? 1 : 0.5) },
    { score: scoreAngle(angles.leftKneeAngle, 155, 35),   weight: (weights?.leftKneeAngle ?? 1) * (angles.leftKneeAngle != null ? 1 : 0.5) },
    { score: scoreAngle(angles.rightKneeAngle, 155, 35),  weight: (weights?.rightKneeAngle ?? 1) * (angles.rightKneeAngle != null ? 1 : 0.5) },
    { score: scoreAngle(angles.shoulderTilt, 0, 25),       weight: (weights?.shoulderTilt ?? 1) * (angles.shoulderTilt != null ? 1 : 0.5) },
    { score: tempo ? scoreAngle(tempo.tempoRatio, 3, 1.5) : 50, weight: (weights?.tempo ?? 1) * (tempo ? 1 : 0.5) },
  ];

  const metricNames = [
    'spineAngle', 'leftElbowAngle', 'rightElbowAngle',
    'leftKneeAngle', 'rightKneeAngle', 'shoulderTilt', 'tempo',
  ];

  const breakdown: ScoringBreakdownEntry[] = entries.map((e, i) => ({
    metric: metricNames[i],
    score: e.score,
    weight: e.weight,
    weighted: e.score * e.weight,
  }));

  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  const weightedSum = entries.reduce((sum, e) => sum + e.score * e.weight, 0);

  const score = totalWeight > 0
    ? Math.max(0, Math.min(100, Math.round(weightedSum / totalWeight)))
    : 50;

  return {
    score,
    honeyBoom: score >= 85,
    breakdown,
  };
}
