import { GolfAngles } from "./angles";
import { MetricConfidenceWeights } from "./cameraAngle";
import { METRIC_DEFINITIONS, type MetricKey } from "./metricDefinitions";
import { SwingTempo } from "./tempoAnalysis";

const ANGLE_METRIC_KEYS: MetricKey[] = [
  'spineAngle', 'leftElbowAngle', 'rightElbowAngle',
  'leftKneeAngle', 'rightKneeAngle', 'shoulderTilt',
];

// EXTERNAL ASSUMPTION (SCR-0b-1): re-evaluate at SCR-CAL post-clinic
const HONEYBOOM_MIN_COVERAGE = 0.7;

/**
 * F-v2-2 contract: `score` and `weighted` are coerced to 0 when dataQuality === 'missing'
 * for type stability. Consumers MUST gate by dataQuality === 'measured' (or use isMeasured())
 * before reading them. NEVER sum `breakdown[i].weighted` directly without filtering.
 */
export type ScoringBreakdownEntry = {
  metric: string;
  score: number;       // 0 when dataQuality === 'missing'
  weight: number;
  weighted: number;    // 0 when dataQuality === 'missing'
  dataQuality: 'measured' | 'missing';
};

export type ScoringResult = {
  score: number | null;  // null when zero metrics measured
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
}): ScoringResult {
  const { angles, tempo, weights } = params;

  const breakdown: ScoringBreakdownEntry[] = ANGLE_METRIC_KEYS.map((key) => {
    const def = METRIC_DEFINITIONS[key];
    const value = angles[key];
    const rawScore = scoreAngle(value, def.ideal, def.underTolerance, def.overTolerance);
    const weight = weights?.[key] ?? 1;
    const score = rawScore ?? 0;
    const weighted = rawScore != null ? score * weight : 0;
    return {
      metric: key,
      score,
      weight,
      weighted,
      dataQuality: rawScore != null ? 'measured' as const : 'missing' as const,
    };
  });

  // Tempo: asymmetric (OD-2G; Q-OP-3b' operator lock; Gryc 2019/2020 elite F junior anchor 3.56-3.67). ideal=3.475 (junior elite F midpoint); underTol=2.5 (ratio=1.0 → 0); overTol=1.525 (ratio=5.0 → 0). Numbers post-clinic-recalibration candidates → SCR-CAL-tempo.
  const tempoRaw = tempo ? scoreAngle(tempo.tempoRatio, 3.475, 2.5, 1.525) : null;
  const tempoWeight = weights?.tempo ?? 1;
  const tempoScore = tempoRaw ?? 0;
  breakdown.push({
    metric: 'tempo',
    score: tempoScore,
    weight: tempoWeight,
    weighted: tempoRaw != null ? tempoScore * tempoWeight : 0,
    dataQuality: tempoRaw != null ? 'measured' as const : 'missing' as const,
  });

  const measured = breakdown.filter(isMeasured);
  if (measured.length === 0) {
    return { score: null, honeyBoom: false, breakdown };
  }

  const totalWeight = measured.reduce((s, e) => s + e.weight, 0);
  const weightedSum = measured.reduce((s, e) => s + e.weighted, 0);
  const score = Math.max(0, Math.min(100, Math.round(weightedSum / totalWeight)));

  const minMeasured = Math.ceil(breakdown.length * HONEYBOOM_MIN_COVERAGE);
  const honeyBoom = score >= 85 && measured.length >= minMeasured;

  return { score, honeyBoom, breakdown };
}
