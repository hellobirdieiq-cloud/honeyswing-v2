import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PoseFrame } from '../packages/pose/PoseTypes';
import type { AnalysisResult } from '../packages/domain/swing/analysisPipeline';
import type { GolfAngles } from '../packages/domain/swing/angles';

export type LiveSwingMotionData = {
  frames: PoseFrame[];
  recordedAt: number;
  source: 'live-camera';
};

let currentMotion: LiveSwingMotionData | null = null;
let currentAnalysis: AnalysisResult | null = null;
let currentVideoUri: string | null = null;

export function setCurrentSwingMotion(data: LiveSwingMotionData): void {
  currentMotion = data;
}

export function getCurrentSwingMotion(): LiveSwingMotionData | null {
  return currentMotion;
}

export function clearCurrentSwingMotion(): void {
  currentMotion = null;
  currentAnalysis = null;
  currentVideoUri = null;
}

export function setCurrentSwingVideoUri(uri: string | null): void {
  currentVideoUri = uri;
}

export function getCurrentSwingVideoUri(): string | null {
  return currentVideoUri;
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

// --- Today's Focus persistence ---

export type FocusData = {
  label: string;
  cue: string;
  score: number;
  savedAt: number;
};

import { STORAGE_KEYS } from './storageKeys';
import { getCachedAgeTier } from './ageTier';

const FOCUS_KEY = STORAGE_KEYS.todaysFocus;

function scoreAngle(value: number | null, ideal: number, tolerance: number): number {
  if (value == null) return 50;
  const diff = Math.abs(value - ideal);
  const raw = 100 - (diff / tolerance) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

type MetricKey = 'spineAngle' | 'leftElbowAngle' | 'rightElbowAngle' | 'leftKneeAngle' | 'rightKneeAngle' | 'shoulderTilt';

const FOCUS_METRICS: Record<MetricKey, { ideal: number; tolerance: number; label: string; cue: (v: number, i: number) => string }> = {
  spineAngle: {
    ideal: 35, tolerance: 20, label: 'Spine tilt',
    cue: (v, i) => {
      const junior = getCachedAgeTier() === 'junior';
      if (v > i) return junior ? 'Try standing a bit taller' : 'You\'re leaning too far forward at address — stand a bit taller';
      return junior ? 'Bend forward just a little' : 'A bit more forward tilt at setup — you\'re standing too upright';
    },
  },
  leftElbowAngle: {
    ideal: 165, tolerance: 40, label: 'Lead arm',
    cue: (v, i) => {
      const junior = getCachedAgeTier() === 'junior';
      if (v < i) return junior ? 'Keep your front arm straighter' : 'Your lead arm is too bent through the swing — try to keep it straighter';
      return junior ? 'Bend your front arm a tiny bit' : 'Your lead arm is locking out — keep a slight bend through impact';
    },
  },
  rightElbowAngle: {
    ideal: 165, tolerance: 40, label: 'Trail arm',
    cue: (v, i) => {
      const junior = getCachedAgeTier() === 'junior';
      if (v < i) return junior ? 'Stretch your back arm out more' : 'Your trail elbow is too bent at the top — extend it more';
      return junior ? 'Let your back arm bend a little' : 'Your trail arm is too straight — let it fold naturally at the top';
    },
  },
  leftKneeAngle: {
    ideal: 155, tolerance: 35, label: 'Lead knee',
    cue: (v, i) => {
      const junior = getCachedAgeTier() === 'junior';
      if (v < i) return junior ? 'Stand a little taller in your legs' : 'Too much knee bend at setup — stay athletic, not crouched';
      return junior ? 'Bend your front knee a tiny bit' : 'Soften your lead knee at address — a little flex helps your turn';
    },
  },
  rightKneeAngle: {
    ideal: 155, tolerance: 35, label: 'Trail knee',
    cue: (v, i) => {
      const junior = getCachedAgeTier() === 'junior';
      if (v < i) return junior ? 'Stand a little taller in your legs' : 'Your trail knee is too bent at setup — straighten up a little';
      return junior ? 'Bend your back knee a tiny bit' : 'Soften your trail knee at address — stay ready to rotate';
    },
  },
  shoulderTilt: {
    ideal: 0, tolerance: 25, label: 'Shoulders',
    cue: (v) => {
      const junior = getCachedAgeTier() === 'junior';
      if (v > 0) return junior ? 'Try to keep your shoulders even' : 'Your lead shoulder is too high at address — try to level them';
      return junior ? 'Try to keep your shoulders even' : 'Your trail shoulder is too high at address — try to level them';
    },
  },
};

export function computeFocus(angles: GolfAngles): FocusData | null {
  const scored: { key: MetricKey; score: number; value: number | null }[] = [];
  for (const labelKey of Object.keys(FOCUS_METRICS) as MetricKey[]) {
    const def = FOCUS_METRICS[labelKey];
    const value = angles[labelKey];
    scored.push({ key: labelKey, score: scoreAngle(value, def.ideal, def.tolerance), value });
  }

  const withValues = scored.filter((s) => s.value != null);
  if (withValues.length === 0) return null;

  const worst = withValues.reduce((min, s) => (s.score < min.score ? s : min), withValues[0]);
  const def = FOCUS_METRICS[worst.key];

  return {
    label: def.label,
    cue: def.cue(worst.value!, def.ideal),
    score: worst.score,
    savedAt: Date.now(),
  };
}

export async function saveFocus(focus: FocusData): Promise<void> {
  await AsyncStorage.setItem(FOCUS_KEY, JSON.stringify(focus));
}

export async function loadFocus(): Promise<FocusData | null> {
  const raw = await AsyncStorage.getItem(FOCUS_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as FocusData;
}