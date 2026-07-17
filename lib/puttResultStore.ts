/**
 * puttResultStore.ts — in-memory holder for the just-captured putt (Phase C).
 *
 * The putt-mode sibling of swingMotionStore's motion/analysis half, kept
 * deliberately separate: swingMotionStore.currentAnalysis is typed
 * AnalysisResult (full-swing) and its bottom half is Today's-Focus machinery
 * — none of which applies to putting. Per-render snapshots only; the putting
 * result screen is pushed param-less after these are set (same pattern as
 * the full-swing flow).
 */

import type { PoseFrame } from '@/packages/pose/PoseTypes';
import type { PuttingPipelineOutput } from './puttingPipeline';

export type PuttResultData = {
  poseFrames: PoseFrame[];
  /** Local capture file (video.path) — playable by expo-video's local branch. */
  videoUri: string | null;
  recordedAt: number;
  pipeline: PuttingPipelineOutput;
};

let current: PuttResultData | null = null;

export function setCurrentPuttResult(data: PuttResultData): void {
  current = data;
}

export function getCurrentPuttResult(): PuttResultData | null {
  return current;
}

export function clearCurrentPuttResult(): void {
  current = null;
}
