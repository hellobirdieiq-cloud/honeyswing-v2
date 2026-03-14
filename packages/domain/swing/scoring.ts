import { GolfAngles } from "./angles";
import { SwingTempo } from "./tempoAnalysis";

export type ScoringResult = {
  score: number;
  honeyBoom: boolean;
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
}): ScoringResult {
  const { angles, tempo } = params;

  const parts = [
    scoreAngle(angles.spineAngle, 35, 20),
    scoreAngle(angles.leftElbowAngle, 165, 40),
    scoreAngle(angles.rightElbowAngle, 165, 40),
    scoreAngle(angles.leftKneeAngle, 155, 35),
    scoreAngle(angles.rightKneeAngle, 155, 35),
    scoreAngle(angles.shoulderTilt, 0, 25),
    tempo ? scoreAngle(tempo.tempoRatio, 3, 1.5) : 50,
  ];

  const score = Math.max(
    0,
    Math.min(100, Math.round(parts.reduce((sum, value) => sum + value, 0) / parts.length))
  );

  return {
    score,
    honeyBoom: score >= 85,
  };
}
