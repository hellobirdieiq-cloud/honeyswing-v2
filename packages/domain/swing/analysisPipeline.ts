import { PoseSequence } from "../../pose/PoseTypes";

export type AnalysisResult = {
  score: number;
  feedback: string;
  honeyBoom: boolean;
};

export function analyzeSwing(sequence: PoseSequence): AnalysisResult {
  return {
    score: 80,
    feedback: "Analysis not implemented",
    honeyBoom: false,
  };
}