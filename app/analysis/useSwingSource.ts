/**
 * useSwingSource — the result screen's swing-data resolution layer, extracted
 * VERBATIM from result.tsx (Batch 5.2): live in-memory store vs history fetch
 * vs record reconstruction, plus capture classification and the analysis pick.
 *
 * INVARIANT: the swingMotionStore reads below are per-render snapshots (the
 * store has no subscription mechanism — result.tsx re-renders are what refresh
 * them). They MUST stay plain calls in the hook body; wrapping them in
 * useState/useMemo would freeze the first render's values and silently break
 * the live-capture path.
 *
 * Navigation stays screen-owned: the no-data redirect lives in result.tsx,
 * which is why swingRecord is returned raw.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  getCurrentSwingMotion,
  getCurrentSwingAnalysis,
  getCurrentSwingVideoUri,
  getCurrentSwingId,
} from '../../lib/swingMotionStore';
import { getSwingById, getSwingMotionFrames, type SwingRecord } from '../../lib/swingStore';
import { classifyCapture, type CaptureClassification } from '@/packages/domain/swing/captureValidity';
import {
  analyzePoseSequence,
  type AnalysisResult,
} from '../../packages/domain/swing/analysisPipeline';
import type { PoseSequence, PoseFrame } from '../../packages/pose/PoseTypes';
import { derivePartialReason } from '../../packages/domain/swing/tempoDisplay';
import { reconstructAnalysisFromRecord } from '../../lib/reconstructAnalysis';
import type { GripClassification } from '../../lib/classifyGrip';

export function useSwingSource(swingId: string | undefined, isLeftHanded: boolean | null) {
  const motion = getCurrentSwingMotion();
  const storedAnalysis = getCurrentSwingAnalysis();
  const videoUri = getCurrentSwingVideoUri();
  const liveSwingId = getCurrentSwingId();
  // "live" means: the in-memory store holds the swing being viewed. True when
  // either (a) URL carries no swingId AND in-memory has data (live capture
  // path where persist returned no id), or (b) URL swingId matches the
  // in-memory id (live capture path with successful persist). History-tap
  // navigation falls through to false because the tapped swingId won't match.
  const isLiveSwing = motion !== null && (!swingId || swingId === liveSwingId);
  const [swingRecord, setSwingRecord] = useState<SwingRecord | null>(null);
  const [recordLoaded, setRecordLoaded] = useState(false);
  // Vanished-feature state (grip chip UI gone since c2f7d5a; parked product
  // decision — keep the state + set alive, see memory).
  const [gripCloud, setGripCloud] = useState<GripClassification | null>(null);
  const [historicalFrames, setHistoricalFrames] = useState<PoseFrame[] | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);

  const effectiveMotion = useMemo(
    () =>
      isLiveSwing
        ? motion
        : historicalFrames
          ? {
              frames: historicalFrames,
              recordedAt: 0,
              // EXTERNAL ASSUMPTION: source='live-camera' for historical frames.
              // Verified no consumer branches on this value (only assigned to
              // sequence.source).
              source: 'live-camera' as const,
            }
          : null,
    [isLiveSwing, motion, historicalFrames],
  );

  useEffect(() => {
    if (!swingId) return;
    setRecordLoaded(false);
    getSwingById(swingId)
      .then((swing) => {
        if (!swing) return;
        setSwingRecord(swing);
        const gc = swing.swing_debug?.grip_cloud as GripClassification | undefined;
        if (gc && !gc.analysis_failed) setGripCloud(gc);
      })
      .catch((err) => console.error('[HoneySwing]', err))
      .finally(() => setRecordLoaded(true));
  }, [swingId]);

  useEffect(() => {
    if (!swingId || isLiveSwing) return;
    setFramesLoading(true);
    getSwingMotionFrames(swingId)
      .then((frames) => setHistoricalFrames(frames))
      .catch((err) => console.error('[HoneySwing]', err))
      .finally(() => setFramesLoading(false));
  }, [swingId, isLiveSwing]);

  const classification: CaptureClassification | null = useMemo(
    () => (effectiveMotion ? classifyCapture(effectiveMotion.frames) : null),
    [effectiveMotion],
  );

  const sequence: PoseSequence | null = useMemo(() => {
    if (!effectiveMotion) return null;
    return {
      frames: effectiveMotion.frames,
      source: effectiveMotion.source,
      metadata: {
        durationMs:
          effectiveMotion.frames.length > 1
            ? effectiveMotion.frames[effectiveMotion.frames.length - 1].timestampMs - effectiveMotion.frames[0].timestampMs
            : 0,
      },
    };
  }, [effectiveMotion]);

  const fallbackAnalysis: AnalysisResult | null = useMemo(() => {
    if (isLeftHanded === null) return null;
    if (!isLiveSwing) return null;
    if (!sequence || classification?.validity === 'invalid' || storedAnalysis) return null;
    return analyzePoseSequence(sequence, isLeftHanded);
  }, [sequence, classification, storedAnalysis, isLiveSwing, isLeftHanded]);

  const reconstructedAnalysis: AnalysisResult | null = useMemo(
    () => (swingRecord && !isLiveSwing ? reconstructAnalysisFromRecord(swingRecord) : null),
    [swingRecord, isLiveSwing],
  );

  const analysis: AnalysisResult | null = isLiveSwing
    ? (storedAnalysis ?? fallbackAnalysis)
    : reconstructedAnalysis;
  const partialReason: string | null = derivePartialReason(
    analysis?.swing_debug,
    swingRecord?.failure_reason,
  );

  return {
    isLiveSwing,
    effectiveMotion,
    swingRecord,
    recordLoaded,
    framesLoading,
    classification,
    analysis,
    partialReason,
    videoUri,
    gripCloud,
  };
}
