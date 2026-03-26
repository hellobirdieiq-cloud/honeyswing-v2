import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, getUserId } from './supabase';
import { incrementLocalSwingCount } from './swingLimit';
import type { PoseFrame } from '../packages/pose/PoseTypes';
import type { AnalysisResult } from '../packages/domain/swing/analysisPipeline';
import type { CaptureClassification } from './captureValidity';

const APP_VERSION = '1.3.0';

const JOINT_CONFIDENCE_THRESHOLD = 0.3;
const KEY_JOINTS = [
  'leftShoulder', 'rightShoulder', 'leftHip', 'rightHip',
  'leftElbow', 'rightElbow', 'leftKnee', 'rightKnee',
];
const MIN_KEY_JOINTS = 4;

function calcPoseSuccessRate(frames: PoseFrame[]): number {
  if (frames.length === 0) return 0;
  let good = 0;
  for (const frame of frames) {
    let confident = 0;
    for (const name of KEY_JOINTS) {
      const joint = frame.joints[name as keyof typeof frame.joints];
      if (joint && (joint.confidence ?? 0) >= JOINT_CONFIDENCE_THRESHOLD) {
        confident++;
      }
    }
    if (confident >= MIN_KEY_JOINTS) good++;
  }
  return Math.round((good / frames.length) * 100) / 100;
}

function extractPhaseSource(phases: any[] | undefined): string {
  if (!phases || phases.length === 0) return 'none';
  const sources = phases.map((p: any) => p.source).filter(Boolean);
  if (sources.every((s: string) => s === 'heuristic')) return 'heuristic';
  if (sources.every((s: string) => s === 'fallback')) return 'fallback';
  return 'mixed';
}

export async function persistSwing(
  frames: PoseFrame[],
  analysis: AnalysisResult,
  classification: CaptureClassification | null,
): Promise<string | null> {
  const durationMs =
    frames.length > 1
      ? frames[frames.length - 1].timestampMs - frames[0].timestampMs
      : 0;

  // Prefer auth user ID, fall back to anonymous profileId
  const authUserId = await getUserId();
  const profileId = authUserId ?? await AsyncStorage.getItem('honeyswing:profileId');

  const row: Record<string, unknown> = {
    ...(profileId ? { user_id: profileId } : {}),
    motion_frames: frames,
    frame_count: frames.length,
    duration_ms: Math.round(durationMs),
    score: analysis.score,
    honey_boom: analysis.honeyBoom,
    angles: analysis.angles ?? null,
    tempo: analysis.tempo ?? null,
    phases: analysis.phases ?? null,
    backswing_ms: analysis.tempo?.backswingMs ? Math.round(analysis.tempo.backswingMs) : null,
    downswing_ms: analysis.tempo?.downswingMs ? Math.round(analysis.tempo.downswingMs) : null,
    tempo_ratio: analysis.tempo?.ratio ?? null,
    pose_success_rate: calcPoseSuccessRate(frames),
    phase_source: extractPhaseSource(analysis.phases),
    failure_reason: null,
    capture_validity: classification?.validity ?? 'unknown',
    app_version: APP_VERSION,
  };

  const { data, error } = await supabase.from('swings').insert(row).select('id').single();

  if (error) {
    console.error('[HoneySwing] persistSwing error:', error.message);
  } else {
    console.log('[HoneySwing] Swing persisted, frames:', frames.length);
  }

  // Always increment local count for anonymous limit tracking
  await incrementLocalSwingCount();

  return data?.id ?? null;
}
