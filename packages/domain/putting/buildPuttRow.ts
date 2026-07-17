/**
 * buildPuttRow.ts — pure putt-row construction (Phase C, D1 option b).
 *
 * The putting sibling of lib/persistSwing's buildSwingRow, kept SEPARATE by
 * design: reusing the full-swing builder would fire its capture-side
 * machinery (sessionAccumulator counts, tip-frequency debug spreads,
 * positiveReinforcement, swing.recorded payload shape) — all full-swing-only.
 *
 * DISCRIMINATOR: analysis_version = 'putt-v1' (text column, NOT NULL; no read
 * path branches on analysis_version — grep-verified — so the value is a
 * clean, greppable tag). Putt rows are filtered OUT of the full-swing UI
 * queries (History/gallery/coach — see swingStore/coachData). The free
 * swing-limit count query is DELIBERATELY untouched: putts counting toward
 * the limit is ACCEPTED v1 behavior (owner directive).
 *
 * Tempo lands in the native columns (tempo_ratio numeric(4,2), backswing_ms,
 * downswing_ms) and score in the score column (tempo band; null = withheld,
 * never 0 — SwingHistoryList renders no number for null). Everything
 * putting-specific rides swing_debug.putting.
 *
 * Type-only import of database.types — same exception as swingRowBuilders
 * (keeps this file pure/tsx-importable for the fixture test).
 */

import type { Database } from '@/lib/database.types';
import type { PuttingDetectorsResult, SmoothedShaftFrame } from './types';

type SwingInsert = Database['public']['Tables']['swings']['Insert'];

export const PUTT_ANALYSIS_VERSION = 'putt-v1';

export type BuildPuttRowInput = {
  playerProfileId: string | null;
  appVersion: string | null;
  classification: { validity: string; reason?: string | null } | null;
  /** motion_frames payload (PoseFrame[] shape) — persisted as-is for skeleton replay. */
  frames: unknown[];
  durationMs: number;
  fpsActual: number | null;
  detectors: PuttingDetectorsResult;
  score: number | null;
  smoothed: SmoothedShaftFrame[] | null;
  shaftLenPx: number | null;
  analysisWidth: number;
  barCalibration: unknown | null;
  timings: Record<string, number>;
};

export function buildPuttRow(input: BuildPuttRowInput): SwingInsert {
  const {
    playerProfileId,
    appVersion,
    classification,
    frames,
    durationMs,
    fpsActual,
    detectors,
    score,
    smoothed,
    shaftLenPx,
    analysisWidth,
    barCalibration,
    timings,
  } = input;

  const tempo = detectors.tempo;
  const puttingDebug = {
    schema: 1,
    takeaway_frame: detectors.takeawayFrame,
    top_frame: detectors.topFrame,
    impact_frame: detectors.impactFrame,
    tempo,
    score,
    intermediates: detectors.intermediates,
    // Smoothed series (~20KB) persisted so a future putt-history replay can
    // render the shaft overlay without re-running the native bar tracker.
    smoothed_series: smoothed,
    shaft_len_px: shaftLenPx,
    analysis_width: analysisWidth,
    bar_calibration: barCalibration,
    timings,
  };

  const row: SwingInsert = {
    analysis_version: PUTT_ANALYSIS_VERSION,
    score,
    tempo_ratio: tempo?.ratio ?? null,
    backswing_ms: tempo != null ? Math.round(tempo.backswingMs) : null,
    downswing_ms: tempo != null ? Math.round(tempo.downswingMs) : null,
    motion_frames: frames as SwingInsert['motion_frames'],
    frame_count: frames.length,
    duration_ms: Math.round(durationMs),
    fps_actual: fpsActual,
    player_profile_id: playerProfileId,
    capture_validity: classification?.validity ?? 'unknown',
    failure_reason: classification?.reason ?? null,
    app_version: appVersion,
    swing_debug: { putting: puttingDebug } as SwingInsert['swing_debug'],
  };
  return row;
}
