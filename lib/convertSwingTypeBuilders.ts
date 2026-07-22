/**
 * convertSwingTypeBuilders.ts — PURE row-update construction for the
 * type-mismatch repair ("re-analyze as other type").
 *
 * INVARIANT: A row represents the RECORDING; analysis_version is the
 * currently accepted analysis of it. A conversion re-runs the clip through
 * the CORRECT pipeline and rewrites the row in place — same id, same video,
 * same motion_frames — so every swingId-keyed linkage (video outbox, delete,
 * history routing) survives untouched.
 *
 * Kept separate from the orchestrators (convertSwingType.ts) so the tsx test
 * runner can import these builders without pulling supabase / native putting
 * wrappers / AsyncStorage into node.
 *
 * swing_debug rewrite policy (owner A1): start from the row's EXISTING
 * swing_debug and remove only the KNOWN analysis-class and label-class keys,
 * then lay the fresh analysis on top. Unknown keys are PRESERVED — never
 * silently deleted. Capture-provenance keys (handedness, grip_*, fps_*,
 * extraction_*, stop_origin, captured_at_iso, session_*, age_tier, ...)
 * survive by construction because they are not in any discard list.
 */

import type { Database, Json } from '@/lib/database.types';
import type { AnalysisResult } from '@/packages/domain/swing/analysisPipeline';
import type { PuttingPipelineOutput } from '@/lib/puttingPipeline';
import {
  buildPuttRow,
  PUTT_ANALYSIS_VERSION,
} from '@/packages/domain/putting/buildPuttRow';
import {
  calcPoseSuccessRate,
  extractPhaseSource,
} from '@/packages/domain/swing/swingRowBuilders';
import type { PoseFrame } from '@/packages/pose/PoseTypes';

type SwingUpdate = Database['public']['Tables']['swings']['Update'];

export const FULL_SWING_ANALYSIS_VERSION = 'v2';

/**
 * Every top-level swing_debug key the FULL-SWING pipeline writes
 * (analysisPipeline.ts:806-831 explicit block + the frameDebug spread's
 * FrameSelectionDebug keys). Discarded when the accepted analysis stops
 * being a full-swing one; replaced wholesale by the fresh run otherwise.
 */
export const FULL_SWING_ANALYSIS_DEBUG_KEYS = [
  'frame_selection_method',
  'fallback_gate',
  'address_frame_range',
  'impact_frame_index',
  'backswing_peak_frame_index',
  'camera_angle',
  'camera_angle_avg_spread',
  'camera_angle_shoulder_spread',
  'camera_angle_hip_spread',
  'scoring_breakdown',
  'confidence_overall',
  'confidence_tier',
  'confidence_components',
  'foreshortening',
  'tilt_correction',
  'angle_gating',
  'visibility_weighting',
  'implausible_frame_filter',
  'z_trace',
  'keypoint_veto',
  'keypoint_identity',
  'phase_rules',
  'camera_angle_pre',
  'lead_wrist_hinge',
  'synthetic_clubhead_path',
  'face_to_path',
  'watch_imu_present',
] as const;

/** The putting pipeline's swing_debug surface (buildPuttRow.ts:98). */
export const PUTT_ANALYSIS_DEBUG_KEYS = ['putting'] as const;

/**
 * Operator label records reference the WRONG-type phase model once the row
 * converts — dropped on every conversion (owner decision; prior score/tempo
 * survive in the type_conversion provenance key).
 */
export const LABEL_DEBUG_KEYS = ['operator_labels', 'putting_operator_labels'] as const;

/** Prior row values folded into the provenance key. */
export type ConversionPriorRow = {
  score: number | null;
  tempo_ratio: number | null;
  backswing_ms: number | null;
  downswing_ms: number | null;
  honey_boom: boolean | null;
};

function buildTypeConversion(
  from: string,
  prior: ConversionPriorRow,
  nowMs: number,
): Record<string, unknown> {
  return {
    schema: 1,
    from,
    converted_at_ms: nowMs,
    prior: {
      score: prior.score,
      tempo_ratio: prior.tempo_ratio,
      backswing_ms: prior.backswing_ms,
      downswing_ms: prior.downswing_ms,
      honey_boom: prior.honey_boom,
    },
  };
}

/** Copy of `existing` minus the discard classes — unknown keys PRESERVED. */
function preserveDebug(
  existing: Record<string, unknown> | null,
  discard: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (existing) {
    for (const [k, v] of Object.entries(existing)) {
      if (!discard.includes(k)) out[k] = v;
    }
  }
  return out;
}

/**
 * Full-swing row → putt row. ONE atomic update payload (owner A8): version
 * flip + shared tempo/score columns + swing-analysis columns nulled +
 * rebuilt swing_debug, together — never sequential partial updates.
 *
 * Column policy: NULL only the full-swing ANALYSIS outputs (the columns
 * reconstructAnalysisFromRecord reads back). Capture facts describing the
 * recording (gravity_vector, watch_imu, pose_success_rate, coach_name,
 * fps_actual, duration_ms, frame_count, motion_frames, video linkage) are
 * NOT in the payload and therefore survive untouched.
 */
export function buildPuttConversionUpdate(args: {
  pipeline: PuttingPipelineOutput;
  existingDebug: Record<string, unknown> | null;
  prior: ConversionPriorRow;
  nowMs: number;
}): SwingUpdate {
  const { pipeline, existingDebug, prior, nowMs } = args;

  // Reuse buildPuttRow for byte-parity with the capture-path putt row: the
  // putting debug object and the shared tempo/score column mapping come from
  // the exact same code. Frames/duration/classification args only feed
  // columns we discard below (motion_frames/frame_count/duration/validity —
  // all already correct on the row from the original capture).
  const puttRow = buildPuttRow({
    playerProfileId: null,
    appVersion: null,
    classification: null,
    frames: [],
    durationMs: 0,
    fpsActual: null,
    detectors: pipeline.detectors,
    score: pipeline.score,
    smoothed: pipeline.smoothed,
    shaftLenPx: pipeline.shaftLenPx,
    analysisWidth: pipeline.analysisWidth,
    barCalibration: pipeline.barCalibration,
    timings: pipeline.timings,
  });
  const puttingDebug = (puttRow.swing_debug as Record<string, unknown>).putting;

  const preserved = preserveDebug(existingDebug, [
    ...FULL_SWING_ANALYSIS_DEBUG_KEYS,
    ...LABEL_DEBUG_KEYS,
    ...PUTT_ANALYSIS_DEBUG_KEYS, // defensive: repeated conversions never stack
  ]);

  return {
    analysis_version: PUTT_ANALYSIS_VERSION,
    score: puttRow.score,
    tempo_ratio: puttRow.tempo_ratio,
    backswing_ms: puttRow.backswing_ms,
    downswing_ms: puttRow.downswing_ms,
    // Full-swing analysis outputs — no longer the accepted analysis.
    honey_boom: null,
    camera_angle_valid: null,
    angles: null,
    tempo: null,
    phases: null,
    trail_points: null,
    metric_confidences: null,
    category_scores: null,
    phase_source: null,
    swing_debug: {
      ...preserved,
      putting: puttingDebug,
      type_conversion: buildTypeConversion(FULL_SWING_ANALYSIS_VERSION, prior, nowMs),
    } as Json,
  };
}

/**
 * Putt row → full-swing row. Same atomicity rule (A8). Column mapping
 * mirrors persistSwing's buildSwingRow analysis-derived subset
 * (persistSwing.ts:156-170) exactly, including the truthy-ms rounding.
 */
export function buildSwingConversionUpdate(args: {
  analysis: AnalysisResult;
  frames: PoseFrame[];
  isLeftHanded: boolean;
  existingDebug: Record<string, unknown> | null;
  prior: ConversionPriorRow;
  nowMs: number;
}): SwingUpdate {
  const { analysis, frames, isLeftHanded, existingDebug, prior, nowMs } = args;

  const preserved = preserveDebug(existingDebug, [
    ...PUTT_ANALYSIS_DEBUG_KEYS,
    ...LABEL_DEBUG_KEYS,
    ...FULL_SWING_ANALYSIS_DEBUG_KEYS, // defensive: repeated conversions never stack
  ]);

  return {
    analysis_version: FULL_SWING_ANALYSIS_VERSION,
    score: analysis.score,
    honey_boom: analysis.honeyBoom,
    camera_angle_valid: analysis.cameraAngleValid,
    angles: (analysis.angles ?? null) as Json,
    tempo: (analysis.tempo ?? null) as Json,
    phases: (analysis.phases ?? null) as Json,
    trail_points: (analysis.trail ?? null) as Json,
    metric_confidences: (analysis.metricConfidences ?? null) as Json,
    category_scores: analysis.aggregate
      ? (Object.fromEntries(
          Object.entries(analysis.aggregate.categories).map(([k, v]) => [k, v?.score ?? null]),
        ) as Json)
      : null,
    backswing_ms: analysis.tempo?.backswingMs ? Math.round(analysis.tempo.backswingMs) : null,
    downswing_ms: analysis.tempo?.downswingMs ? Math.round(analysis.tempo.downswingMs) : null,
    tempo_ratio: analysis.tempo?.tempoRatio ?? null,
    pose_success_rate: calcPoseSuccessRate(frames),
    phase_source: extractPhaseSource(analysis.phases),
    swing_debug: {
      ...preserved,
      ...(analysis.swing_debug ?? {}),
      handedness: isLeftHanded ? 'left' : 'right',
      type_conversion: buildTypeConversion(PUTT_ANALYSIS_VERSION, prior, nowMs),
    } as unknown as Json,
  };
}
