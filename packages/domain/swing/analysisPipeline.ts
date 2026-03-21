import { PoseSequence } from "../../pose/PoseTypes";
import { calculateGolfAngles } from "./angles";
import { detectSwingPhases, SwingTrailPoint } from "./phaseDetection";
import { calculateTempo, isTempoTrustworthy } from "./tempoAnalysis";
import { scoreSwing } from "./scoring";

export type AnalysisResult = {
  score: number;
  honeyBoom: boolean;
  angles?: any;
  tempo?: any;
  phases?: any[];
};

function buildTrailPoints(sequence: PoseSequence): SwingTrailPoint[] {
  const points: SwingTrailPoint[] = [];

  for (const frame of sequence.frames) {
    const lw = frame.joints.leftWrist;
    const rw = frame.joints.rightWrist;

    if (!lw || !rw) continue;

    points.push({
      x: (lw.x + rw.x) / 2,
      y: (lw.y + rw.y) / 2,
      timestamp: frame.timestampMs,
    });
  }

  return points;
}

export function analyzePoseSequence(sequence: PoseSequence): AnalysisResult {
  if (!sequence.frames || sequence.frames.length === 0) {
    return {
      score: 0,
      honeyBoom: false,
    };
  }

  const midFrame = sequence.frames[Math.floor(sequence.frames.length / 2)];
  const angles = calculateGolfAngles(midFrame);

  const trail = buildTrailPoints(sequence);
  const phases = detectSwingPhases(trail);
  const rawTempo = calculateTempo(phases);

  // Withhold tempo when phase detection is unreliable — scores neutral 50 instead
  const tempo = rawTempo && isTempoTrustworthy(rawTempo, phases) ? rawTempo : null;

  const scoring = scoreSwing({
    angles,
    tempo,
  });

  return {
    score: scoring.score,
    honeyBoom: scoring.honeyBoom,
    angles,
    tempo,
    phases,
  };
}