/**
 * Coaching tip domain logic extracted from result.tsx.
 * Pure data transformations — no React, no hooks, no store access.
 */

import type { PoseFrame } from '../packages/pose/PoseTypes';
import type { Landmark } from '../components/SkeletonOverlay';
import type { ScoringBreakdownEntry } from '../packages/domain/swing/scoring';
import type { RawCoachingTip } from '@/packages/domain/swing/tipFrequency';

/** Convert a PoseFrame's joints into the Landmark[] format SkeletonOverlay expects. */
export function frameToLandmarks(frame: PoseFrame): Landmark[] {
  const landmarks: Landmark[] = [];
  for (const joint of Object.values(frame.joints)) {
    if (!joint) continue;
    landmarks.push({
      name: joint.name,
      x: joint.x,
      y: joint.y,
      inFrameLikelihood: joint.confidence ?? 0,
    });
  }
  return landmarks;
}

/** Pick the frame with the most high-confidence joints. */
export function pickKeyFrame(frames: PoseFrame[]): PoseFrame {
  let best = frames[Math.floor(frames.length / 2)];
  let bestCount = 0;
  for (const frame of frames) {
    let count = 0;
    for (const joint of Object.values(frame.joints)) {
      if (joint && (joint.confidence ?? 0) >= 0.3) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = frame;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tip adapter: scoring breakdown → RawCoachingTip[]
// ---------------------------------------------------------------------------

export const TIP_SCORE_THRESHOLD = 80;

/** Mapping from scoring metric names to tipFrequency metricKeys */
export const METRIC_KEY_MAP: Record<string, string> = {
  spineAngle: 'spineAngle',
  leftElbowAngle: 'elbow',
  rightElbowAngle: 'elbow',
  leftKneeAngle: 'kneeFlex',
  rightKneeAngle: 'kneeFlex',
  shoulderTilt: 'shoulderTilt',
  tempo: 'tempo',
};


/**
 * Convert scoring breakdown entries into RawCoachingTip[].
 * Pre-filters to score < TIP_SCORE_THRESHOLD. Deduplicates mapped keys
 * (e.g. leftElbowAngle + rightElbowAngle both map to 'elbow') by keeping
 * the worse-scoring entry.
 */
export function buildRawTips(breakdown: ScoringBreakdownEntry[]): RawCoachingTip[] {
  // Collect worst score per mapped metricKey
  const seen = new Map<string, number>();

  for (const entry of breakdown) {
    if (entry.dataQuality === 'missing') continue;
    if (entry.score >= TIP_SCORE_THRESHOLD) continue;
    const mappedKey = METRIC_KEY_MAP[entry.metric];
    if (!mappedKey) continue;

    const existing = seen.get(mappedKey);
    if (existing === undefined || entry.score < existing) {
      seen.set(mappedKey, entry.score);
    }
  }

  return Array.from(seen.keys()).map((metricKey) => ({ metricKey }));
}
