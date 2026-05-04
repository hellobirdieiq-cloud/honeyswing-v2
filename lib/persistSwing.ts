import { supabase, getUserId } from './supabase';
import { incrementLocalSwingCount } from './swingLimit';
import type { PoseFrame } from '../packages/pose/PoseTypes';
import type { AnalysisResult } from '../packages/domain/swing/analysisPipeline';
import type { DetectedPhase } from '../packages/domain/swing/phaseDetection';
import { isGoodFrame, type CaptureClassification } from './captureValidity';
import { getCoachCode } from './coachCode';
import { getIsLeftHanded } from './handedness';
import { getFrequencyDebugInfo } from './tipFrequency';
import { positiveReinforcementEngine } from './positiveReinforcement';
import type { CameraGuidanceColor } from './cameraGuidance';
import { sessionAccumulator } from './sessionAccumulator';
import { getAgeTier } from './ageTier';
import { getGripClassification } from './gripStore';
import { emit as emitEvent } from './eventBus';

const APP_VERSION = '1.9.6';

/** Optional camera guidance snapshot from Task 13 */
export interface CameraGuidanceSnapshot {
  camera_angle_at_start: number | null;
  camera_guidance_color: CameraGuidanceColor | null;
}

function calcPoseSuccessRate(frames: PoseFrame[]): number {
  if (frames.length === 0) return 0;
  const good = frames.filter(isGoodFrame).length;
  return Math.round((good / frames.length) * 100) / 100;
}

function extractPhaseSource(phases: DetectedPhase[] | undefined): string {
  if (!phases || phases.length === 0) return 'none';
  const sources = phases.map((p) => p.source).filter(Boolean);
  if (sources.every((s) => s === 'heuristic')) return 'heuristic';
  if (sources.every((s) => s === 'fallback')) return 'fallback';
  return 'mixed';
}

export async function persistSwing(
  frames: PoseFrame[],
  analysis: AnalysisResult,
  classification: CaptureClassification | null,
  cameraGuidance?: CameraGuidanceSnapshot,
  nativeGrip?: Record<string, unknown>[] | null,
): Promise<string | null> {
  const durationMs =
    frames.length > 1
      ? frames[frames.length - 1].timestampMs - frames[0].timestampMs
      : 0;

  // Prefer auth user ID, fall back to anonymous profileId
  const authUserId = await getUserId();
  if (!authUserId) {
    console.log("[persistSwing] No user, skipping DB write");
    return null;
  }
  const profileId = authUserId;

  const cloudGrip = getGripClassification();

  const coachCode = await getCoachCode();
  const isLeftHanded = await getIsLeftHanded();
  const ageTier = await getAgeTier();

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
    trail_points: analysis.trail ?? null,
    metric_confidences: analysis.metricConfidences ?? null,
    category_scores: analysis.aggregate
      ? Object.fromEntries(Object.entries(analysis.aggregate.categories).map(([k, v]) => [k, v?.score ?? null])) : null,
    backswing_ms: analysis.tempo?.backswingMs ? Math.round(analysis.tempo.backswingMs) : null,
    downswing_ms: analysis.tempo?.downswingMs ? Math.round(analysis.tempo.downswingMs) : null,
    tempo_ratio: analysis.tempo?.tempoRatio ?? null,
    pose_success_rate: calcPoseSuccessRate(frames),
    phase_source: extractPhaseSource(analysis.phases),
    failure_reason: classification?.reason ?? null,
    capture_validity: classification?.validity ?? 'unknown',
    app_version: APP_VERSION,
    coach_name: coachCode ?? null,
    analysis_version: 'v1',  // SCR-0b-1
    swing_debug: {
      classification_reason: classification?.reason ?? null,
      handedness: isLeftHanded ? 'left' : 'right',
      ...analysis.swing_debug,
      ...getFrequencyDebugInfo(),
      positiveReinforcement: positiveReinforcementEngine.buildDebugInfo(),
      camera_angle_at_start: cameraGuidance?.camera_angle_at_start ?? null,
      camera_guidance_color: cameraGuidance?.camera_guidance_color ?? null,
      session_swing_number: sessionAccumulator.swingCount + 1,
      session_insight_shown: null, // Set by result screen after persist — logged to Metro
      age_tier: ageTier,
      grip_native: nativeGrip ?? null,
      grip_cloud: cloudGrip ?? null,
    },
  };

  const { data, error } = await supabase.from('swings').insert(row).select('id').single();

  // Always increment local count for anonymous limit tracking, even on DB error
  await incrementLocalSwingCount();

  if (error) {
    console.error('[HoneySwing] persistSwing DB error:', error.message);
    throw new Error(`persistSwing failed: ${error.message}`);
  }

  console.log('[HoneySwing] Swing persisted, frames:', frames.length);

  const swingId = data?.id ?? null;
  if (swingId) {
    emitEvent('swing.recorded', {
      swingId,
      userId: profileId,
      score: analysis.score,
      honeyBoom: analysis.honeyBoom,
      tempoRatio: analysis.tempo?.tempoRatio ?? null,
      confidenceTier: analysis.swingConfidence.tier,
      cameraAngle: analysis.cameraAngleResult.angle,
      captureValidity: classification?.validity ?? null,
      sessionSwingNumber: sessionAccumulator.swingCount + 1,
      coachCode: coachCode ?? null,
      isLeftHanded,
      ageTier: ageTier ?? null,
      appVersion: APP_VERSION,
    });
  }

  return swingId;
}
