/**
 * Single source of truth for metric ideal values, tolerances, labels,
 * skeleton segment mappings, and coaching cue generators.
 *
 * Consumed by VisualCoachCard, swingMotionStore (computeFocus), and
 * coachingTips. Consolidates what was previously triplicated across those files.
 */

import type { AgeTier } from '../../../lib/ageTier';

export type MetricKey =
  | 'spineAngle'
  | 'leftElbowAngle'
  | 'rightElbowAngle'
  | 'leftKneeAngle'
  | 'rightKneeAngle'
  | 'shoulderTilt';

export interface MetricDefinition {
  segments: [string, string][];
  ideal: number;
  // EXTERNAL ASSUMPTION (SCR-0b-1): asymmetric ratio 1.5; calibrate at SCR-CAL post-clinic
  underTolerance: number;
  overTolerance: number;
  label: string;
  cue: (value: number, ideal: number, ageTier: AgeTier) => string;
}

export const METRIC_DEFINITIONS: Record<MetricKey, MetricDefinition> = {
  spineAngle: {
    segments: [['leftShoulder', 'leftHip'], ['rightShoulder', 'rightHip']],
    ideal: 35, underTolerance: 20, overTolerance: 13.33,
    label: 'Spine tilt',
    cue: (v, i, ageTier) => {
      const junior = ageTier === 'junior';
      if (v > i) return junior ? 'Try standing a bit taller' : 'You\'re leaning too far forward at address — stand a bit taller';
      return junior ? 'Bend forward just a little' : 'A bit more forward tilt at setup — you\'re standing too upright';
    },
  },
  leftElbowAngle: {
    segments: [['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist']],
    ideal: 165, underTolerance: 40, overTolerance: 26.67,
    label: 'Lead arm',
    cue: (v, i, ageTier) => {
      const junior = ageTier === 'junior';
      if (v < i) return junior ? 'Keep your front arm straighter' : 'Your lead arm is too bent through the swing — try to keep it straighter';
      return junior ? 'Bend your front arm a tiny bit' : 'Your lead arm is locking out — keep a slight bend through impact';
    },
  },
  rightElbowAngle: {
    segments: [['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist']],
    ideal: 165, underTolerance: 40, overTolerance: 26.67,
    label: 'Trail arm',
    cue: (v, i, ageTier) => {
      const junior = ageTier === 'junior';
      if (v < i) return junior ? 'Stretch your back arm out more' : 'Your trail elbow is too bent at the top — extend it more';
      return junior ? 'Let your back arm bend a little' : 'Your trail arm is too straight — let it fold naturally at the top';
    },
  },
  leftKneeAngle: {
    segments: [['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle']],
    ideal: 155, underTolerance: 35, overTolerance: 23.33,
    label: 'Lead knee',
    cue: (v, i, ageTier) => {
      const junior = ageTier === 'junior';
      if (v < i) return junior ? 'Stand a little taller in your legs' : 'Too much knee bend at setup — stay athletic, not crouched';
      return junior ? 'Bend your front knee a tiny bit' : 'Soften your lead knee at address — a little flex helps your turn';
    },
  },
  rightKneeAngle: {
    segments: [['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle']],
    ideal: 155, underTolerance: 35, overTolerance: 23.33,
    label: 'Trail knee',
    cue: (v, i, ageTier) => {
      const junior = ageTier === 'junior';
      if (v < i) return junior ? 'Stand a little taller in your legs' : 'Your trail knee is too bent at setup — straighten up a little';
      return junior ? 'Bend your back knee a tiny bit' : 'Soften your trail knee at address — stay ready to rotate';
    },
  },
  shoulderTilt: {
    segments: [['leftShoulder', 'rightShoulder']],
    ideal: 0, underTolerance: 25, overTolerance: 16.67,
    label: 'Shoulders',
    cue: (v, _i, ageTier) => {
      const junior = ageTier === 'junior';
      if (v > 0) return junior ? 'Try to keep your shoulders even' : 'Your lead shoulder is too high at address — try to level them';
      return junior ? 'Try to keep your shoulders even' : 'Your trail shoulder is too high at address — try to level them';
    },
  },
};
