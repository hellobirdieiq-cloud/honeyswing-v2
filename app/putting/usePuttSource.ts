/**
 * usePuttSource — live-vs-history resolution for the putting result screen
 * (History v2). The putting sibling of the useSwingSource PATTERN, not the
 * module (that one runs the full-swing analysis pipeline).
 *
 * LIVE (no swingId param): store snapshot (puttResultStore) — byte-equivalent
 * to the pre-History-v2 behavior, including the token-guarded swingId
 * subscription for label-mode saves.
 *
 * HISTORY (swingId param — the param always wins): getSwingById +
 * getSwingMotionFrames in parallel; the detected view is reconstructed from
 * swing_debug.putting (schema-guarded — malformed/missing → 'error' state,
 * never a crash); the Yours view from swing_debug.putting_operator_labels
 * with tempo/score read from the ROW COLUMNS (they hold the Manual values by
 * construction — persistPutt wrote detected, label saves overwrite with
 * merged). Video plays via useSwingVideoClock's remote branch
 * (videoStoragePath → signed URL internally).
 */

import { useEffect, useMemo, useState } from 'react';
import type { PoseFrame } from '@/packages/pose/PoseTypes';
import type { PuttingTempoResult, SmoothedShaftFrame } from '@/packages/domain/putting/types';
import { getSwingById, getSwingMotionFrames } from '@/lib/swingStore';
import {
  getCurrentPuttResult,
  getCurrentPuttCaptureToken,
  getCurrentPuttCorrections,
  getCurrentPuttSwingId,
  subscribeCurrentPuttSwingId,
  type PuttCorrections,
} from '@/lib/puttResultStore';

export type PuttEventFrames = {
  takeaway: number | null;
  top: number | null;
  impact: number | null;
};

export type PuttSource =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      isLive: boolean;
      swingId: string | null;
      poseFrames: PoseFrame[];
      videoUri: string | null;
      videoStoragePath: string | null;
      detected: PuttEventFrames;
      detectedTempo: PuttingTempoResult | null;
      detectedScore: number | null;
      warnings: string[];
      smoothed: SmoothedShaftFrame[] | null;
      shaftLenPx: number | null;
      analysisWidth: number;
      corrections: PuttCorrections | null;
      /** Live only — guards store writes; null in history mode. */
      captureToken: number | null;
    };

type Ready = Extract<PuttSource, { status: 'ready' }>;

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function parseTempo(v: unknown): PuttingTempoResult | null {
  if (v == null || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  const ratio = num(t.ratio);
  if (ratio == null) return null;
  return {
    ratio,
    backswingFrames: num(t.backswingFrames) ?? 0,
    downswingFrames: num(t.downswingFrames) ?? 0,
    backswingMs: num(t.backswingMs) ?? 0,
    downswingMs: num(t.downswingMs) ?? 0,
  };
}

export function usePuttSource(swingId: string | undefined): PuttSource {
  const isHistory = swingId != null;

  // ── Live path (per-render store snapshot + subscribed id) ──
  const live = useMemo(() => (isHistory ? null : getCurrentPuttResult()), [isHistory]);
  const liveToken = useMemo(() => getCurrentPuttCaptureToken(), []);
  const [liveSwingId, setLiveSwingId] = useState<string | null>(() =>
    isHistory ? null : getCurrentPuttSwingId(),
  );
  useEffect(() => {
    if (isHistory) return;
    return subscribeCurrentPuttSwingId(setLiveSwingId);
  }, [isHistory]);

  // ── History path (fetch + reconstruct) ──
  const [historySource, setHistorySource] = useState<PuttSource>({ status: 'loading' });
  useEffect(() => {
    if (!isHistory) return;
    let cancelled = false;
    (async () => {
      const [record, frames] = await Promise.all([
        getSwingById(swingId),
        getSwingMotionFrames(swingId),
      ]);
      if (cancelled) return;
      if (!record) {
        setHistorySource({ status: 'error', message: 'Putt not found.' });
        return;
      }
      const debug = (record.swing_debug ?? null) as Record<string, unknown> | null;
      const putting = debug?.putting as Record<string, unknown> | undefined;
      if (putting == null || typeof putting !== 'object') {
        setHistorySource({
          status: 'error',
          message: "Couldn't load this putt (no putting data on the row).",
        });
        return;
      }

      const detected: PuttEventFrames = {
        takeaway: num(putting.takeaway_frame),
        top: num(putting.top_frame),
        impact: num(putting.impact_frame),
      };
      const intermediates = putting.intermediates as Record<string, unknown> | undefined;
      const warnings = Array.isArray(intermediates?.warnings)
        ? (intermediates!.warnings as unknown[]).filter((w): w is string => typeof w === 'string')
        : [];
      const smoothedRaw = putting.smoothed_series;
      const smoothed = Array.isArray(smoothedRaw)
        ? (smoothedRaw as SmoothedShaftFrame[])
        : null;

      // Yours view from operator labels: effective frames = detected merged
      // with stamped labels; tempo/score from the ROW COLUMNS (Manual values).
      let corrections: PuttCorrections | null = null;
      const labelsRec = debug?.putting_operator_labels as Record<string, unknown> | undefined;
      const stamped =
        labelsRec && typeof labelsRec === 'object'
          ? (labelsRec.labels as Record<string, unknown> | undefined)
          : undefined;
      if (stamped && typeof stamped === 'object' && Object.keys(stamped).length > 0) {
        const effective: PuttEventFrames = {
          takeaway: num(stamped.takeaway) ?? detected.takeaway,
          top: num(stamped.top) ?? detected.top,
          impact: num(stamped.impact) ?? detected.impact,
        };
        const ratio = num(record.tempo_ratio);
        const backswingMs = num(record.backswing_ms);
        const downswingMs = num(record.downswing_ms);
        const stepMs = num(labelsRec!.step_ms);
        const tempo: PuttingTempoResult | null =
          ratio != null && backswingMs != null && downswingMs != null
            ? {
                ratio,
                backswingMs,
                downswingMs,
                backswingFrames:
                  effective.top != null && effective.takeaway != null
                    ? effective.top - effective.takeaway
                    : stepMs
                      ? Math.round(backswingMs / stepMs)
                      : 0,
                downswingFrames:
                  effective.impact != null && effective.top != null
                    ? effective.impact - effective.top
                    : stepMs
                      ? Math.round(downswingMs / stepMs)
                      : 0,
              }
            : null;
        corrections = { effectiveFrames: effective, tempo, score: num(record.score) };
      }

      const ready: Ready = {
        status: 'ready',
        isLive: false,
        swingId,
        poseFrames: frames ?? [],
        videoUri: null,
        videoStoragePath: record.video_storage_path,
        detected,
        detectedTempo: parseTempo(putting.tempo),
        detectedScore: num(putting.score),
        warnings,
        smoothed,
        shaftLenPx: num(putting.shaft_len_px),
        analysisWidth: num(putting.analysis_width) ?? 480,
        corrections,
        captureToken: null,
      };
      setHistorySource(ready);
    })().catch((e) => {
      if (!cancelled) {
        setHistorySource({
          status: 'error',
          message: e instanceof Error ? e.message : 'Failed to load putt.',
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isHistory, swingId]);

  if (isHistory) return historySource;

  if (!live) return { status: 'empty' };
  const { detectors } = live.pipeline;
  return {
    status: 'ready',
    isLive: true,
    swingId: liveSwingId,
    poseFrames: live.poseFrames,
    videoUri: live.videoUri,
    videoStoragePath: null,
    detected: {
      takeaway: detectors.takeawayFrame,
      top: detectors.topFrame,
      impact: detectors.impactFrame,
    },
    detectedTempo: detectors.tempo,
    detectedScore: live.pipeline.score,
    warnings: detectors.intermediates.warnings,
    smoothed: live.pipeline.smoothed,
    shaftLenPx: live.pipeline.shaftLenPx,
    analysisWidth: live.pipeline.analysisWidth,
    corrections: getCurrentPuttCorrections(),
    captureToken: liveToken,
  };
}
