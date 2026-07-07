import type { PoseFrame } from '../packages/pose/PoseTypes';
import type { Rtmw133Frame } from '../packages/pose/rtmw/Rtmw133Frame';
import { rtmwToPoseFrame } from '../packages/pose/rtmw/rtmwAdapter';
import { extractRtmw, confirmBodyAtVideo } from '../modules/vision-camera-pose/src';

export type ExtractResult = {
  poseFrames: PoseFrame[];
  rtmw: Rtmw133Frame[];
  failure: 'no-person' | null;
  captureFps?: number | null;
  videoDurationMs?: number | null;
  videoFrameCount?: number | null;
  extractionTotalMs?: number | null;
  extractionBreakdown?: {
    decode_ms: number | null;
    inference_ms: number | null;
    metadata_probe_ms: number | null;
  } | null;
};

/**
 * Extract RTMW pose frames from a recorded video clip.
 *
 * EXTERNAL ASSUMPTION (RULE 42) — `captureFps`, `analyzerDecimation`,
 * `fallbackWidth`, and `fallbackHeight` are externally supplied by the
 * caller, sourced from `lib/cameraFormat.ts`. This module does NOT import
 * those constants directly so callers control the assumed source frame
 * rate per recording (a device that falls back below 240 fps yields a
 * different effective decimation rate). The fallback dims are defensive
 * only — used iff native returns 0 for a frame's dimensions (should be
 * unreachable, since copyCGImage success implies non-zero size).
 *
 * Failure shape:
 *   - zero rtmw frames           → { poseFrames: [], rtmw: [], failure: null }
 *   - !humanPresent              → { poseFrames: [], rtmw: [], failure: 'no-person' }
 *   - extractRtmw / AVAsset throw → exception propagates to caller's try/catch
 *
 * Order: confirmBodyAtVideo FIRST → extract → zero-frames early return → adapt.
 * Confirm-first (efficiency-audit Fix 3): a no-person clip must not pay the
 * full RTMW extraction (~seconds) before rejecting — it used to, and then
 * discarded the extracted frames anyway. The confirm runs on every swing
 * either way, so the happy path is net-zero; only the rare zero-frames case
 * now pays one confirm it previously skipped. A confirm REJECTION (decode /
 * Vision throw — distinct from humanPresent=false) fails OPEN into
 * extraction: a flaky confirm must never kill a good clip.
 */
export async function extractPoseFromVideo(
  videoUri: string,
  clipDurationMs: number,
  fallbackWidth: number,
  fallbackHeight: number,
  captureFps: number,
  analyzerDecimation: number,
): Promise<ExtractResult> {
  // Gate BEFORE the expensive extraction. humanPresent=false is a definitive
  // reject; a thrown confirm (frame decode / Vision failure) falls open.
  try {
    const bodyConfirm = await confirmBodyAtVideo(videoUri, clipDurationMs / 2);
    if (!bodyConfirm.humanPresent) {
      return {
        poseFrames: [],
        rtmw: [],
        failure: 'no-person',
        captureFps: null,
        videoDurationMs: null,
        videoFrameCount: null,
        extractionTotalMs: null,
        extractionBreakdown: null,
      };
    }
  } catch (e) {
    console.warn('[HoneySwing][extract] body-confirm threw — proceeding to extraction', e);
  }

  const step = analyzerDecimation * (1000 / captureFps);
  const upperBound = Math.floor(clipDurationMs / step);
  const timestamps: number[] = [];
  // Bound is `<` not `<=`: the final i*step lands past the last decodable PTS,
  // and HoneyRtmwOneShotPlugin's AVAssetImageGenerator uses .zero tolerance so
  // copyCGImage throws and rejects the whole batch. Deferred deeper fix if
  // failures ever appear at non-final timestamps: relax that tolerance to
  // CMTime(value:1,timescale:480) in HoneyRtmwOneShotPlugin.swift:63-64.
  for (let i = 0; i < upperBound; i++) {
    timestamps.push(i * step);
  }

  const rtmwFrames = await extractRtmw(videoUri, timestamps);
  const measuredCaptureFps = rtmwFrames[0]?.captureFps ?? null;
  const measuredVideoDurationMs = rtmwFrames[0]?.videoDurationMs ?? null;
  const measuredVideoFrameCount = rtmwFrames[0]?.videoFrameCount ?? null;
  const extractionBreakdown = {
    decode_ms: rtmwFrames[0]?.decodeTotalMs ?? null,
    inference_ms: rtmwFrames[0]?.inferenceTotalMs ?? null,
    metadata_probe_ms: rtmwFrames[0]?.metadataProbeMs ?? null,
  };
  // Sum per-frame extractionMs. Refuse to silently undercount: if any
  // frame is missing or non-finite, the whole-swing total is null (same
  // failure rule as the measured-fps trio above).
  const extractionTotalMs: number | null =
    rtmwFrames.length === 0
      ? null
      : rtmwFrames.every(
          (f) => typeof f.extractionMs === 'number' && Number.isFinite(f.extractionMs),
        )
        ? rtmwFrames.reduce((acc, f) => acc + f.extractionMs, 0)
        : null;

  if (rtmwFrames.length === 0) {
    return {
      poseFrames: [],
      rtmw: [],
      failure: null,
      captureFps: measuredCaptureFps,
      videoDurationMs: measuredVideoDurationMs,
      videoFrameCount: measuredVideoFrameCount,
      extractionTotalMs,
      extractionBreakdown,
    };
  }

  if (rtmwFrames.some((f) => f.frameWidth === 0 || f.frameHeight === 0)) {
    console.warn('[HoneySwing][extract] native frameWidth/Height was 0 — using fallback');
  }

  const rtmw: Rtmw133Frame[] = rtmwFrames.map((f) => ({
    timestampMs: f.timestampMs,
    keypoints: f.keypoints,
    frameWidth: f.frameWidth > 0 ? f.frameWidth : fallbackWidth,
    frameHeight: f.frameHeight > 0 ? f.frameHeight : fallbackHeight,
    extractionMs: f.extractionMs,
  }));

  for (const f of rtmw) {
    if (f.keypoints.length !== 133) {
      console.warn(
        `[HoneySwing] expected 133 keypoints per frame, got ${f.keypoints.length} at t=${f.timestampMs}ms`,
      );
    }
  }

  const poseFrames: PoseFrame[] = rtmw.map(rtmwToPoseFrame);

  return {
    poseFrames,
    rtmw,
    failure: null,
    captureFps: measuredCaptureFps,
    videoDurationMs: measuredVideoDurationMs,
    videoFrameCount: measuredVideoFrameCount,
    extractionTotalMs,
    extractionBreakdown,
  };
}
