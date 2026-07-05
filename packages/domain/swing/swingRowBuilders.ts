/**
 * swingRowBuilders.ts — pure, graph-free helpers for assembling a swings-table
 * row. Extracted VERBATIM from persistSwing.ts so they can be unit-tested
 * without importing persistSwing.ts (whose ./supabase → @clerk/expo import graph
 * cannot load under the tsx test harness). No logic changes; persistSwing.ts
 * imports these back.
 */
import type { PostgrestError } from '@supabase/supabase-js';
import type { Json } from '@/lib/database.types';
import type { PoseFrame, NormalizedJoint, JointName } from '../../pose/PoseTypes';
import type { AnalysisResult } from './analysisPipeline';
import type { DetectedPhase } from './phaseDetection';
import { calculateGolfAngles } from './angles';
import {
  WORN_WRIST,
  WATCH_IMU_CLOCK_NOTE,
  type WatchImuReading,
  type WatchImuMeasured,
  type WatchImuAlignment,
} from './watchImu';
import type {
  MetricSnapshot,
  PhaseTagRange,
  PhaseTag,
} from './phaseTags';
import { isGoodFrame } from './captureValidity';

export type InsertFailClass =
  | 'fk_missing_profile'
  | 'rls_denied'
  | 'constraint'
  | 'network'
  | 'unknown';

/**
 * Classify a swings-insert failure so persist_swing telemetry distinguishes a
 * wiring bug (missing profiles row / RLS) from a genuine network failure.
 * A returned PostgrestError carries a Postgres code; a thrown error (fetch
 * reject) has none and is treated as network.
 */
export function classifyInsertError(
  insertError: PostgrestError | null,
  thrown: unknown,
): InsertFailClass {
  if (insertError) {
    const code = insertError.code;
    if (code === '23503') return 'fk_missing_profile';
    if (code === '42501') return 'rls_denied';
    if (code && code.startsWith('23')) return 'constraint';
    return 'unknown';
  }
  if (thrown) return 'network';
  return 'unknown';
}

/**
 * Watch IMU payload persisted alongside a swing: the raw stream, the measured summary, and
 * (watch-primary) the clock-sync alignment block + captureSeq for the seq→swing late-join map.
 */
export interface WatchImuPersist {
  readings: WatchImuReading[];
  summary: WatchImuMeasured;
  alignment?: WatchImuAlignment | null;
  captureSeq?: number | null;
}

/** Assemble the swing_debug.watch_imu block (summary + assumption + clock note + alignment). */
export function buildWatchImuDebug(watchImu: WatchImuPersist | null | undefined): Json | null {
  if (!watchImu || watchImu.readings.length === 0) return null;
  return {
    ...watchImu.summary,
    wornWrist: WORN_WRIST, // EXTERNAL_ASSUMPTION — no wrist detection (Phase 5)
    clockNote: WATCH_IMU_CLOCK_NOTE,
    alignment: watchImu.alignment ?? null,
  } as unknown as Json;
}

export function calcPoseSuccessRate(frames: PoseFrame[]): number {
  if (frames.length === 0) return 0;
  const good = frames.filter(isGoodFrame).length;
  return Math.round((good / frames.length) * 100) / 100;
}

export function extractPhaseSource(phases: DetectedPhase[] | undefined): string {
  if (!phases || phases.length === 0) return 'none';
  const sources = phases.map((p) => p.source).filter(Boolean);
  if (sources.every((s) => s === 'heuristic')) return 'heuristic';
  if (sources.every((s) => s === 'fallback')) return 'fallback';
  return 'mixed';
}

export function buildMetricSnapshotFromAnalysis(analysis: AnalysisResult): MetricSnapshot {
  return {
    spineAngle: analysis.angles?.spineAngle ?? null,
    spineDrift: analysis.angles?.spineDrift ?? null,
    tempoRatio: analysis.tempo?.tempoRatio ?? null,
    hipSpreadDelta: analysis.angles?.hipSpreadDelta ?? null,
    leftElbowAngle: analysis.angles?.leftElbowAngle ?? null,
    rightElbowAngle: analysis.angles?.rightElbowAngle ?? null,
    leftKneeAngle: analysis.angles?.leftKneeAngle ?? null,
    rightKneeAngle: analysis.angles?.rightKneeAngle ?? null,
    shoulderTilt: analysis.angles?.shoulderTilt ?? null,
  };
}

function mapSwingPhaseToClinic(p: DetectedPhase['phase']): PhaseTag {
  return p === 'follow_through' ? 'finish' : p;
}

export function buildPhaseTagsFromAnalysis(
  analysis: AnalysisResult,
  frameCount: number,
): PhaseTagRange[] {
  const detected = analysis.phases;
  if (!detected || detected.length === 0) return [];

  const sorted = [...detected].sort((a, b) => a.index - b.index);

  const seen = new Set<PhaseTag>();
  const deduped: DetectedPhase[] = [];
  for (const p of sorted) {
    const tag = mapSwingPhaseToClinic(p.phase);
    if (seen.has(tag)) continue;
    seen.add(tag);
    deduped.push(p);
  }

  const ranges: PhaseTagRange[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const start = deduped[i].index;
    const end =
      i + 1 < deduped.length
        ? deduped[i + 1].index - 1
        : frameCount - 1;
    ranges.push({
      phase: mapSwingPhaseToClinic(deduped[i].phase),
      startFrameIndex: start,
      endFrameIndex: end,
    });
  }
  return ranges;
}

export function buildSpineAngleSeries(frames: PoseFrame[]): (number | null)[] {
  return frames.map((f) => calculateGolfAngles(f).spineAngle);
}

export function calcFpsEstimate(frames: PoseFrame[]): number | null {
  if (frames.length < 2) return null;
  const sample = frames.slice(0, 20);
  const dts: number[] = [];
  for (let i = 1; i < sample.length; i++) {
    dts.push(sample[i].timestampMs - sample[i - 1].timestampMs);
  }
  if (dts.length === 0) return null;
  dts.sort((a, b) => a - b);
  const mid = Math.floor(dts.length / 2);
  const medianDt =
    dts.length % 2 === 0 ? (dts[mid - 1] + dts[mid]) / 2 : dts[mid];
  if (medianDt === 0) return null;
  return Math.round((1000 / medianDt) * 10) / 10;
}

export function enrichFramesWithVelocity(input: PoseFrame[]): PoseFrame[] {
  return input.map((f, i) => {
    const prev = i > 0 ? input[i - 1] : null;
    const dt = prev ? f.timestampMs - prev.timestampMs : 0;
    const clonedJoints: Record<JointName, NormalizedJoint | undefined> = { ...f.joints };
    for (const key of Object.keys(clonedJoints) as JointName[]) {
      const curr = clonedJoints[key];
      if (!curr) continue;
      const previous = prev?.joints[key];
      if (
        prev &&
        dt > 0 &&
        previous &&
        (curr.confidence ?? 0) > 0 &&
        (previous.confidence ?? 0) > 0
      ) {
        clonedJoints[key] = {
          ...curr,
          vx: (curr.x - previous.x) / dt,
          vy: (curr.y - previous.y) / dt,
          vz: ((curr.z ?? 0) - (previous.z ?? 0)) / dt,
        };
      } else {
        clonedJoints[key] = { ...curr };
      }
    }
    return { ...f, joints: clonedJoints };
  });
}
