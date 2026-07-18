/**
 * puttResultStore.ts — in-memory holder for the just-captured putt (Phase C;
 * extended for operator label mode).
 *
 * The putt-mode sibling of swingMotionStore's motion/analysis half, kept
 * deliberately separate: swingMotionStore.currentAnalysis is typed
 * AnalysisResult (full-swing) and its bottom half is Today's-Focus machinery
 * — none of which applies to putting. Per-render snapshots only, EXCEPT the
 * swingId (arrives after the screen mounts — subscribable) — the same shape
 * as swingMotionStore's subscribeCurrentSwingId + capture-token guard
 * (swingMotionStore.ts:70-100): a slow persistPutt outliving a superseded
 * capture must not stamp its id (or corrections) onto the newer putt.
 *
 * `corrections` = the operator's saved Manual view (label mode): merged
 * event frames + recomputed tempo/score. The DETECTED pipeline snapshot is
 * never mutated — the card's Auto | Yours toggle reads `pipeline` for Auto
 * and `corrections` for Yours.
 */

import type { PoseFrame } from '@/packages/pose/PoseTypes';
import type { PuttingPipelineOutput } from './puttingPipeline';
import type { PuttingTempoResult } from '@/packages/domain/putting/types';

export type PuttResultData = {
  poseFrames: PoseFrame[];
  /** Local capture file (video.path) — playable by expo-video's local branch. */
  videoUri: string | null;
  recordedAt: number;
  pipeline: PuttingPipelineOutput;
};

export type PuttCorrections = {
  /** Merged event frames: operator where stamped, detected where not. */
  effectiveFrames: {
    takeaway: number | null;
    top: number | null;
    impact: number | null;
  };
  tempo: PuttingTempoResult | null;
  score: number | null;
};

let current: PuttResultData | null = null;
let currentSwingId: string | null = null;
let currentCorrections: PuttCorrections | null = null;
let captureToken = 0;
const swingIdListeners = new Set<(id: string | null) => void>();

/** Replaces the current putt and mints a new capture token (returned). */
export function setCurrentPuttResult(data: PuttResultData): number {
  current = data;
  currentSwingId = null;
  currentCorrections = null;
  captureToken += 1;
  for (const l of swingIdListeners) l(null);
  return captureToken;
}

export function getCurrentPuttResult(): PuttResultData | null {
  return current;
}

export function getCurrentPuttCaptureToken(): number {
  return captureToken;
}

/** Guarded id stamp — no-ops when a newer capture superseded `forToken`. */
export function setCurrentPuttSwingId(id: string | null, forToken: number): void {
  if (forToken !== captureToken) {
    console.warn('[puttResultStore] stale swingId ignored', { id, forToken, captureToken });
    return;
  }
  currentSwingId = id;
  for (const l of swingIdListeners) l(id);
}

export function getCurrentPuttSwingId(): string | null {
  return currentSwingId;
}

export function subscribeCurrentPuttSwingId(listener: (id: string | null) => void): () => void {
  swingIdListeners.add(listener);
  return () => {
    swingIdListeners.delete(listener);
  };
}

/** Saved Manual view (label mode). Guarded by the same token. */
export function setCurrentPuttCorrections(
  corrections: PuttCorrections | null,
  forToken: number,
): void {
  if (forToken !== captureToken) {
    console.warn('[puttResultStore] stale corrections ignored', { forToken, captureToken });
    return;
  }
  currentCorrections = corrections;
}

export function getCurrentPuttCorrections(): PuttCorrections | null {
  return currentCorrections;
}

export function clearCurrentPuttResult(): void {
  current = null;
  currentSwingId = null;
  currentCorrections = null;
  captureToken += 1;
  for (const l of swingIdListeners) l(null);
}
