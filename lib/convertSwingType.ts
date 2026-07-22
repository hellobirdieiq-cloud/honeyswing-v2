/**
 * convertSwingType.ts — type-mismatch repair orchestrators.
 *
 * INVARIANT: A row represents the RECORDING; analysis_version is the
 * currently accepted analysis of it.
 *
 * convertToPutt  — live full-swing result only (v1): re-runs the putting
 *                  pipeline (CALLED, never modified) on the LOCAL capture
 *                  video + in-memory frames — identical inputs to the
 *                  capture-time putt fork, so full capture parity.
 *                  History full-swing rows are out of scope in v1: the
 *                  native bar passes need a local file and only a signed
 *                  URL exists (P-105 downloader ticket).
 * convertToSwing — live putt result AND history putt rows: pure recompute
 *                  via analyzePoseSequence on the row's frames. Gravity is
 *                  unavailable post-capture (only the averaged vector
 *                  persists), so tilt correction no-ops: angle metrics/tips
 *                  are degraded, but the HEADLINE score/tempo are faithful —
 *                  scoring is tempo-only and tempo never consumes gravity
 *                  (regression-pinned in convertSwingType.test.ts).
 *
 * Each conversion issues ONE atomic row UPDATE (version flip + all rebuilt
 * analysis columns + rebuilt swing_debug together — owner A8) with
 * `.select('id')` row-count honesty (85ecd53 precedent): an RLS-filtered
 * update fails loud instead of silently converting nothing.
 */

import { supabase } from './supabase';
import { getSwingById } from './swingStore';
import { runPuttingPipeline } from './puttingPipeline';
import { analyzePoseSequence } from '@/packages/domain/swing/analysisPipeline';
import type { PoseFrame, PoseSequence } from '@/packages/pose/PoseTypes';
import { CAPTURE_FPS, ANALYZER_DECIMATION } from './cameraFormat';
import { getProfiles } from './playerProfiles';
import { getActiveProfileHandedness } from './handedness';
import {
  buildPuttConversionUpdate,
  buildSwingConversionUpdate,
  type ConversionPriorRow,
} from './convertSwingTypeBuilders';
import {
  setCurrentPuttResult,
  setCurrentPuttSwingId,
  clearCurrentPuttResult,
} from './puttResultStore';
import { clearCurrentSwingMotion } from './swingMotionStore';
import type { SwingRecord } from './swingStore';
import type { Database } from './database.types';

type SwingUpdate = Database['public']['Tables']['swings']['Update'];

export type ConvertResult =
  | { ok: true; swingId: string }
  | { ok: false; message: string };

// Same generous bound as the capture-time putt fork (captureProcessing.ts).
const CONVERT_PUTT_TIMEOUT_MS = 60000;

function priorFromRecord(record: SwingRecord): ConversionPriorRow {
  return {
    score: record.score,
    tempo_ratio: record.tempo_ratio,
    backswing_ms: record.backswing_ms,
    downswing_ms: record.downswing_ms,
    honey_boom: record.honey_boom ?? null,
  };
}

async function applyConversionUpdate(
  swingId: string,
  update: SwingUpdate,
): Promise<ConvertResult> {
  const { data: updatedRows, error } = await supabase
    .from('swings')
    .update(update)
    .eq('id', swingId)
    .select('id');
  if (error != null || (updatedRows?.length ?? 0) === 0) {
    console.error('[convertSwingType] row update failed', {
      swingId,
      rowCount: updatedRows?.length ?? 0,
      error: error && {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      },
    });
    return { ok: false, message: 'conversion failed — row update rejected; tap to retry' };
  }
  return { ok: true, swingId };
}

/**
 * Live full-swing capture that was actually a putt. Requires the LOCAL
 * capture video (native bar passes decode pixels) and a persisted row.
 * On success the putt store is populated exactly like the capture-time putt
 * fork, so the caller can route to the param-less live putting result (local
 * video playback + shaft overlay intact).
 */
export async function convertToPutt(args: {
  swingId: string;
  videoUri: string;
  frames: PoseFrame[];
}): Promise<ConvertResult> {
  const { swingId, videoUri, frames } = args;
  try {
    const record = await getSwingById(swingId);
    if (!record) return { ok: false, message: 'conversion failed — swing row not found' };

    // Capture-parity step grid (captureProcessing putt fork).
    const stepMs = ANALYZER_DECIMATION * (1000 / CAPTURE_FPS);
    const pipeline = await Promise.race([
      runPuttingPipeline({ videoUri, poseFrames: frames, stepMs }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('convert-putt-timeout')), CONVERT_PUTT_TIMEOUT_MS),
      ),
    ]);

    const update = buildPuttConversionUpdate({
      pipeline,
      existingDebug: record.swing_debug,
      prior: priorFromRecord(record),
      nowMs: Date.now(),
    });
    const result = await applyConversionUpdate(swingId, update);
    if (!result.ok) return result;

    // Hand the live capture to the putt store (same shape as the capture
    // fork) and retire the full-swing store — the recording is a putt now.
    const token = setCurrentPuttResult({
      poseFrames: frames,
      videoUri,
      recordedAt: Date.now(),
      pipeline,
    });
    setCurrentPuttSwingId(swingId, token);
    clearCurrentSwingMotion();
    return result;
  } catch (e) {
    console.warn('[convertSwingType] convertToPutt threw:', e instanceof Error ? e.message : String(e));
    return { ok: false, message: 'conversion failed — putting pipeline error; tap to retry' };
  }
}

/**
 * Putt row (live or history) that was actually a full swing. Pure recompute —
 * no video needed. Handedness precedence (owner A2):
 *   1. the row's own swing_debug.handedness (capture truth, when present);
 *   2. the SWING ROW'S kid profile (player_profile_id linkage) — NOT the
 *      active profile, which can be a different child;
 *   3. only when neither resolves: the current active profile, as a last
 *      resort (putt rows historically stored no handedness and the profile
 *      may have been deleted — nothing better exists).
 */
export async function convertToSwing(args: {
  swingId: string;
  frames: PoseFrame[];
}): Promise<ConvertResult> {
  const { swingId, frames } = args;
  try {
    const record = await getSwingById(swingId);
    if (!record) return { ok: false, message: 'conversion failed — swing row not found' };
    if (frames.length === 0) {
      return { ok: false, message: 'conversion failed — no motion frames for this putt' };
    }

    const debugHandedness = record.swing_debug?.handedness;
    let isLeftHanded: boolean;
    if (debugHandedness === 'left' || debugHandedness === 'right') {
      isLeftHanded = debugHandedness === 'left';
    } else {
      const rowProfile = record.player_profile_id
        ? (await getProfiles()).find((p) => p.id === record.player_profile_id)
        : undefined;
      isLeftHanded =
        rowProfile?.isLeftHanded ?? (await getActiveProfileHandedness());
    }

    const first = frames[0]?.timestampMs ?? 0;
    const last = frames[frames.length - 1]?.timestampMs ?? 0;
    const sequence: PoseSequence = {
      frames,
      source: 'type-conversion',
      metadata: { durationMs: Math.max(0, last - first) },
    };
    // Empty gravity: the per-frame stream is never persisted, so tilt
    // correction no-ops. Headline score/tempo are unaffected (tempo-only
    // scoring); angle metrics render uncorrected — disclosed limitation.
    const analysis = analyzePoseSequence(sequence, isLeftHanded, []);

    const update = buildSwingConversionUpdate({
      analysis,
      frames,
      isLeftHanded,
      existingDebug: record.swing_debug,
      prior: priorFromRecord(record),
      nowMs: Date.now(),
    });
    const result = await applyConversionUpdate(swingId, update);
    if (!result.ok) return result;

    // The putt store (if it held this capture) is wrong-type now. The caller
    // routes to /analysis/result?swingId=… — the history path reconstructs
    // from the freshly written row and fires NONE of the live-only side
    // effects (sessionAccumulator / Today's Focus / session_insight), keeping
    // "no retroactive analytics" honest.
    clearCurrentPuttResult();
    return result;
  } catch (e) {
    console.warn('[convertSwingType] convertToSwing threw:', e instanceof Error ? e.message : String(e));
    return { ok: false, message: 'conversion failed — analysis error; tap to retry' };
  }
}
