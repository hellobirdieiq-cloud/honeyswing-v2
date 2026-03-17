import type { PoseFrame } from '../packages/pose/PoseTypes';
import type { AnalysisResult } from '../packages/domain/swing/analysisPipeline';

export type LiveSwingMotionData = {
  frames: PoseFrame[];
  recordedAt: number;
  source: 'live-camera';
};

let currentMotion: LiveSwingMotionData | null = null;
let currentAnalysis: AnalysisResult | null = null;

export function setCurrentSwingMotion(data: LiveSwingMotionData): void {
  currentMotion = data;
}

export function getCurrentSwingMotion(): LiveSwingMotionData | null {
  return currentMotion;
}

export function clearCurrentSwingMotion(): void {
  currentMotion = null;
  currentAnalysis = null;
}

export function setCurrentSwingAnalysis(result: AnalysisResult): void {
  currentAnalysis = result;
}

export function getCurrentSwingAnalysis(): AnalysisResult | null {
  return currentAnalysis;
}

export function clearCurrentSwingAnalysis(): void {
  currentAnalysis = null;
}