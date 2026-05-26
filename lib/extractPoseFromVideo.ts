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
 * Order: extract → zero-frames early return (skips the body-confirm native
 * round-trip when there's nothing to confirm) → confirmBodyAtVideo → adapt.
 */
export async function extractPoseFromVideo(
  videoUri: string,
  clipDurationMs: number,
  fallbackWidth: number,
  fallbackHeight: number,
  captureFps: number,
  analyzerDecimation: number,
): Promise<ExtractResult> {
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

  if (rtmwFrames.length === 0) {
    return {
      poseFrames: [],
      rtmw: [],
      failure: null,
      captureFps: measuredCaptureFps,
      videoDurationMs: measuredVideoDurationMs,
      videoFrameCount: measuredVideoFrameCount,
    };
  }

  const middleTimestamp = clipDurationMs / 2;
  const bodyConfirm = await confirmBodyAtVideo(videoUri, middleTimestamp);
  if (!bodyConfirm.humanPresent) {
    return {
      poseFrames: [],
      rtmw: [],
      failure: 'no-person',
      captureFps: measuredCaptureFps,
      videoDurationMs: measuredVideoDurationMs,
      videoFrameCount: measuredVideoFrameCount,
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
  };
}
