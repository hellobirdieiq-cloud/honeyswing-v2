import type { PostgrestError } from '@supabase/supabase-js';
import { supabase, getUserId } from './supabase';
import { ensureProfile } from './ensureProfile';
import { incrementLocalSwingCount } from './swingLimit';
import type { Database, Json } from './database.types';
import type { PoseFrame } from '../packages/pose/PoseTypes';
import type { AnalysisResult } from '../packages/domain/swing/analysisPipeline';
import type { GravityReading } from '../packages/domain/swing/tiltCorrection';
import { analyzePoseSequence } from '../packages/domain/swing/analysisPipeline';
import { CAPTURE_FPS } from './cameraFormat';
import { IMU_BATCH_SEQ_LOOKBACK_MS } from './watchImuConstants';
import type { CaptureClassification } from '@/packages/domain/swing/captureValidity';
import { getCoachCode } from './coachCode';
import { getActiveProfileHandedness } from './handedness';
import { getPrimaryProfile } from './playerProfiles';
import { getFrequencyDebugInfo } from '@/packages/domain/swing/tipFrequency';
import { positiveReinforcementEngine } from '@/packages/domain/swing/positiveReinforcement';
import type { CameraGuidanceColor } from './cameraGuidance';
import { sessionAccumulator } from './sessionAccumulator';
import { getAgeTier } from './ageTier';
import { getGripClassification } from './gripStore';
import { emit as emitEvent } from './eventBus';
import type { CaptureFrameStats } from './usePoseFrameHandler';
import {
  classifyInsertError,
  buildWatchImuDebug,
  calcPoseSuccessRate,
  extractPhaseSource,
  calcFpsEstimate,
  enrichFramesWithVelocity,
  type WatchImuPersist,
} from '@/packages/domain/swing/swingRowBuilders';
import type { StopOrigin } from '@/packages/domain/swing/captureFlow';

export type { WatchImuPersist };

const APP_VERSION = '1.10.0';

/** Optional camera guidance snapshot from Task 13 */
export interface CameraGuidanceSnapshot {
  camera_angle_at_start: number | null;
  camera_guidance_color: CameraGuidanceColor | null;
}

export async function persistSwing(
  frames: PoseFrame[],
  analysis: AnalysisResult,
  classification: CaptureClassification | null,
  cameraGuidance?: CameraGuidanceSnapshot,
  nativeGrip?: Record<string, unknown>[] | null,
  captureFrameStats?: CaptureFrameStats,
  requestedFps?: number | null,
  gravityReadings?: GravityReading[],
  playerProfileId?: string | null,
  captureFps?: number | null,
  videoDurationMs?: number | null,
  videoFrameCount?: number | null,
  extractionTotalMs?: number | null,
  watchImu?: WatchImuPersist | null,
  isLeftHandedOverride?: boolean,
  stopOrigin?: StopOrigin | null,
  extractionBreakdown?: {
    decode_ms: number | null;
    inference_ms: number | null;
    metadata_probe_ms: number | null;
  } | null,
  pipelineMs?: Record<string, number | null> | null,
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

  // For the record flow the caller always supplies a concrete id (snapshotted at
  // button-press, after beginRecording hard-blocks a missing profile). Legacy
  // callers (clinic, failed-swing/IMU stubs) pass undefined → fall back to the
  // primary profile, exactly as before.
  const resolvedPlayerProfileId =
    playerProfileId !== undefined ? playerProfileId : ((await getPrimaryProfile())?.id ?? null);

  const cloudGrip = getGripClassification();

  const coachCode = await getCoachCode();
  // Prefer the button-press snapshot threaded from the caller; fall back to a
  // fresh read only for legacy/stub paths that pass no override.
  const isLeftHanded = isLeftHandedOverride ?? (await getActiveProfileHandedness());
  const ageTier = await getAgeTier();

  const enrichedFrames = enrichFramesWithVelocity(frames);

  let gravityVector: Json | null = null;
  if (gravityReadings && gravityReadings.length > 0) {
    const n = gravityReadings.length;
    const sum = gravityReadings.reduce(
      (acc, g) => ({ x: acc.x + g.x, y: acc.y + g.y, z: acc.z + g.z }),
      { x: 0, y: 0, z: 0 },
    );
    gravityVector = { x: sum.x / n, y: sum.y / n, z: sum.z / n };
  }

  // Watch IMU: persist the raw stream FULL (mirrors motion_frames — no decimation; the
  // stream is bounded by the watch ring buffer, ~2× longer in watch-primary) + a summary +
  // alignment block. Null when no watch / toggle off, exactly like gravity_vector above.
  const hasWatchImu = !!watchImu && watchImu.readings.length > 0;
  const watchImuColumn: Json | null = hasWatchImu
    ? (watchImu!.readings as unknown as Json)
    : null;
  const watchImuDebug: Json | null = buildWatchImuDebug(watchImu);

  const row: Database['public']['Tables']['swings']['Insert'] = {
    ...(profileId ? { user_id: profileId } : {}),
    player_profile_id: resolvedPlayerProfileId ?? null,
    motion_frames: enrichedFrames,
    gravity_vector: gravityVector,
    watch_imu: watchImuColumn,
    frame_count: frames.length,
    duration_ms: Math.round(durationMs),
    fps_actual: durationMs > 0 ? frames.length / (durationMs / 1000.0) : null,
    score: analysis.score,
    honey_boom: analysis.honeyBoom,
    camera_angle_valid: analysis.cameraAngleValid,
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
    analysis_version: 'v2',  // SCR-0b-1
    swing_debug: ({
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
      fps_estimate: calcFpsEstimate(frames),
      fps_requested: requestedFps ?? null,
      fps_capture_measured: captureFps ?? null,
      video_duration_ms: videoDurationMs ?? null,
      video_frame_count: videoFrameCount ?? null,
      extraction_total_ms: extractionTotalMs ?? null,
      extraction_breakdown: extractionBreakdown ?? null,
      pipeline_ms: pipelineMs ?? null,
      // What ended the recording ('window_timer' | 'manual'). Null = the native
      // layer ended it without finalizeCapture (camera deactivation mid-record) —
      // exactly the truncation signature this field exists to diagnose. Discarded
      // sub-minimum fragments produce no row at all (dev log only).
      stop_origin: stopOrigin ?? null,
      capture_frame_stats: captureFrameStats ?? null,
      watch_imu: watchImuDebug,
      // seq→swing mapping for IMU batch late-join; imu_only marks an orphan IMU record.
      capture_seq: watchImu?.captureSeq ?? null,
      imu_only: frames.length === 0 && hasWatchImu,
    }) as unknown as Json,
  };

  let data: { id: string } | null = null;
  let insertError: PostgrestError | null = null;
  let thrown: unknown = null;
  const tInsert = Date.now();
  try {
    const res = await supabase.from('swings').insert(row).select('id').single();
    data = res.data;
    insertError = res.error;
  } catch (err) {
    thrown = err;
  }

  // #9 self-heal: the swings.user_id -> profiles.id FK rejects the insert with
  // code 23503 when this session never got a profiles row (failed/raced
  // ensureProfile at sign-in). Create the row and retry exactly once — no loop.
  if (insertError?.code === '23503') {
    const healed = await ensureProfile(profileId);
    if (healed) {
      thrown = null;
      try {
        const res = await supabase.from('swings').insert(row).select('id').single();
        data = res.data;
        insertError = res.error;
      } catch (err) {
        insertError = null;
        thrown = err;
      }
    }
  }

  // Real swings count toward the anonymous limit; stub rows (failure
  // persists with empty frames) do NOT — they aren't swings.
  if (frames.length > 0) {
    await incrementLocalSwingCount();
  }

  if (insertError || thrown) {
    const failClass = classifyInsertError(insertError, thrown);
    const message =
      insertError?.message ??
      (thrown instanceof Error ? thrown.message : String(thrown));
    // Queryable telemetry (drains to public.events via the offline-capable
    // event bus) so FK/RLS/network failure rates are visible across users.
    emitEvent('error.captured', {
      scope: 'persist_swing',
      message,
      context: {
        code: insertError?.code ?? null,
        classification: failClass,
        captureValidity: classification?.validity ?? null,
        frameCount: frames.length,
      },
    });
    console.error('[HoneySwing] persistSwing DB error:', message);
    throw new Error(`persistSwing failed: ${message}`);
  }

  console.log('[HoneySwing] Swing persisted, frames:', frames.length);
  console.log('[KPI] insert-ms', Date.now() - tInsert);

  const swingId = data?.id ?? null;

  // SCR-PERSIST-ALL-SWINGS: stub rows skip downstream side effects.
  // The row exists in DB for analytics, but event bus / session counter are
  // reserved for real swings (frames.length > 0).
  if (frames.length === 0) return swingId;

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

// ─── Watch IMU late-join (batch drains after the swing is persisted) ─────────────

/**
 * Find a recently-persisted swing whose swing_debug.capture_seq matches `seq`, within the
 * lookback window. The persisted-source-of-truth fallback behind the in-memory seq→swingId
 * map. Filters capture_seq in JS (JSONB equality via the client is awkward); scans the most
 * recent rows only, bounded by created_at.
 */
export async function findSwingIdByCaptureSeq(
  seq: number,
  lookbackMs: number = IMU_BATCH_SEQ_LOOKBACK_MS,
): Promise<string | null> {
  const userId = await getUserId();
  if (!userId) return null;
  const sinceIso = new Date(Date.now() - lookbackMs).toISOString();
  const { data, error } = await supabase
    .from('swings')
    .select('id, swing_debug, created_at')
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error || !data) {
    if (error) console.warn('[persistSwing] findSwingIdByCaptureSeq query failed', error.message);
    return null;
  }
  for (const r of data) {
    const debug = r.swing_debug as { capture_seq?: number | null } | null;
    if (debug && typeof debug.capture_seq === 'number' && debug.capture_seq === seq) {
      return r.id;
    }
  }
  return null;
}

/**
 * Attach a late IMU batch to an already-persisted swing: overwrite the watch_imu column +
 * swing_debug.watch_imu (alignment) + capture_seq. Idempotent — a re-attach writes identical
 * data. Merges into the existing swing_debug rather than replacing it.
 */
export async function attachWatchImuToSwing(
  swingId: string,
  watchImu: WatchImuPersist,
): Promise<void> {
  if (watchImu.readings.length === 0) return;
  const { data, error } = await supabase
    .from('swings')
    .select('swing_debug')
    .eq('id', swingId)
    .single();
  if (error || !data) {
    console.warn('[persistSwing] attachWatchImuToSwing: swing fetch failed', error?.message);
    return;
  }
  const existing = (data.swing_debug as Record<string, unknown> | null) ?? {};
  const mergedDebug = {
    ...existing,
    watch_imu: buildWatchImuDebug(watchImu),
    capture_seq: watchImu.captureSeq ?? (existing.capture_seq ?? null),
  } as unknown as Json;
  const { error: updateError } = await supabase
    .from('swings')
    .update({
      watch_imu: watchImu.readings as unknown as Json,
      swing_debug: mergedDebug,
    })
    .eq('id', swingId);
  if (updateError) {
    console.warn('[persistSwing] attachWatchImuToSwing: update failed', updateError.message);
    return;
  }
  console.log('[persistSwing] late-join attached watch IMU', {
    swingId,
    n: watchImu.readings.length,
    seq: watchImu.captureSeq ?? null,
  });
}

/**
 * Persist an orphan IMU batch (no paired video/pose) as an IMU-only record — never discarded.
 * Reuses the empty-frames stub path (analyzePoseSequence([]) → empty analysis), carrying the
 * watch_imu stream + alignment. swing_debug.imu_only is set by persistSwing when frames=[].
 */
export async function persistImuOnlyRecord(
  watchImu: WatchImuPersist,
): Promise<string | null> {
  if (watchImu.readings.length === 0) return null;
  const emptyAnalysis = analyzePoseSequence(
    { frames: [], source: 'rtmw-l-2d-v1', metadata: { fps: CAPTURE_FPS, durationMs: 0 } },
    false,
    [],
  );
  const stubClassification: CaptureClassification = {
    validity: 'invalid',
    frameCount: 0,
    goodFrameCount: 0,
    poseSuccessRate: 0,
    reason: 'imu-only',
  };
  return persistSwing(
    [],
    emptyAnalysis,
    stubClassification,
    undefined, // cameraGuidance
    null, // nativeGrip
    undefined, // captureFrameStats
    null, // requestedFps
    undefined, // gravityReadings
    undefined, // playerProfileId
    null, // captureFps
    null, // videoDurationMs
    null, // videoFrameCount
    null, // extractionTotalMs
    watchImu,
  );
}
