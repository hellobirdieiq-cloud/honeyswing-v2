import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PoseFrame } from '../packages/pose/PoseTypes';
import type { AnalysisResult } from '../packages/domain/swing/analysisPipeline';
import type { GolfAngles } from '../packages/domain/swing/angles';
import { scoreAngle } from '../packages/domain/swing/scoring';

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
import { METRIC_DEFINITIONS, type MetricKey } from '../packages/domain/swing/metricDefinitions';
import { isMetricEligible } from './tipFrequency';


export function computeFocus(angles: GolfAngles): FocusData | null {
  const ageTier = getCachedAgeTier();
  const scored: { key: MetricKey; score: number | null; value: number | null }[] = [];
  for (const labelKey of Object.keys(METRIC_DEFINITIONS) as MetricKey[]) {
    if (!isMetricEligible(labelKey, ageTier)) continue;
    const def = METRIC_DEFINITIONS[labelKey];
    const value = angles[labelKey];
    scored.push({
      key: labelKey,
      score: scoreAngle(value, def.ideal, def.underTolerance, def.overTolerance),
      value,
    });
  }

  // Type-narrowing flatMap: keep only entries with both value and score non-null
  const measured = scored.flatMap((s) =>
    s.value != null && s.score != null
      ? [{ key: s.key, score: s.score, value: s.value }]
      : []
  );
  if (measured.length === 0) return null;

  const worst = measured.reduce((min, s) => (s.score < min.score ? s : min), measured[0]);
  const def = METRIC_DEFINITIONS[worst.key];

  return {
    label: def.label,
    cue: def.cue(worst.value, def.ideal, ageTier),
    score: worst.score,
    savedAt: Date.now(),
  };
}

export async function saveFocus(focus: FocusData): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.todaysFocus, JSON.stringify(focus));
}

export async function loadFocus(): Promise<FocusData | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.todaysFocus);
  if (!raw) return null;
  return JSON.parse(raw) as FocusData;
}