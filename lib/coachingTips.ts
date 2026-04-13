/**
 * Coaching tip domain logic extracted from result.tsx.
 * Pure data transformations — no React, no hooks, no store access.
 */

import type { PoseFrame } from '../packages/pose/PoseTypes';
import type { Landmark } from '../components/SkeletonOverlay';
import type { ScoringBreakdownEntry } from '../packages/domain/swing/scoring';
import type { RawCoachingTip } from './tipFrequency';
import type { AgeTier } from './ageTier';

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

/** Static coaching text keyed by scoring metric name. juniorBody for ages 6-8. */
export const COACHING_TEXT: Record<string, { title: string; body: string; juniorBody?: string }> = {
  spineAngle: {
    title: 'Spine Tilt',
    body: 'Check your spine angle at address — aim for an athletic tilt, not too upright or hunched.',
    juniorBody: 'Stand tall like an athlete',
  },
  leftElbowAngle: {
    title: 'Lead Arm',
    body: 'Keep your lead arm straighter through the swing for better extension.',
    juniorBody: 'Try keeping your front arm straight',
  },
  rightElbowAngle: {
    title: 'Trail Arm',
    body: 'Let your trail arm fold naturally at the top and extend through impact.',
    juniorBody: 'Let your back arm bend and stretch',
  },
  leftKneeAngle: {
    title: 'Lead Knee',
    body: 'Check your lead knee flex at setup — stay athletic, not locked or crouched.',
    juniorBody: 'Bend your front knee a little',
  },
  rightKneeAngle: {
    title: 'Trail Knee',
    body: 'Soften your trail knee at address to help your rotation.',
    juniorBody: 'Keep your back knee soft',
  },
  shoulderTilt: {
    title: 'Shoulders',
    body: 'Work on leveling your shoulders at address for a more consistent swing.',
    juniorBody: 'Keep your shoulders more level',
  },
  tempo: {
    title: 'Tempo',
    body: 'Smooth out your tempo — aim for a controlled backswing and accelerating downswing.',
    juniorBody: 'Nice and slow going back',
  },
};

/**
 * Convert scoring breakdown entries into RawCoachingTip[].
 * Pre-filters to score < TIP_SCORE_THRESHOLD. Deduplicates mapped keys
 * (e.g. leftElbowAngle + rightElbowAngle both map to 'elbow') by keeping
 * the worse-scoring entry.
 */
export function buildRawTips(breakdown: ScoringBreakdownEntry[], ageTier: AgeTier): RawCoachingTip[] {
  // Collect worst score per mapped metricKey
  const best: Map<string, { scoringMetric: string; score: number }> = new Map();

  for (const entry of breakdown) {
    if (entry.dataQuality === 'missing') continue;
    if (entry.score >= TIP_SCORE_THRESHOLD) continue;
    const mappedKey = METRIC_KEY_MAP[entry.metric];
    if (!mappedKey) continue;
    const text = COACHING_TEXT[entry.metric];
    if (!text) continue;

    const existing = best.get(mappedKey);
    if (!existing || entry.score < existing.score) {
      best.set(mappedKey, { scoringMetric: entry.metric, score: entry.score });
    }
  }

  const useJunior = ageTier === 'junior';
  const tips: RawCoachingTip[] = [];
  for (const [mappedKey, { scoringMetric }] of best) {
    const text = COACHING_TEXT[scoringMetric]!;
    tips.push({
      metricKey: mappedKey,
      title: text.title,
      body: useJunior && text.juniorBody ? text.juniorBody : text.body,
      shortBody: useJunior && text.juniorBody ? text.juniorBody : null,
    });
  }
  return tips;
}
