import type { PoseFrame } from '../packages/pose/PoseTypes';
import type { Rtmw133Frame } from '../packages/pose/rtmw/Rtmw133Frame';
import { rtmwToPoseFrame } from '../packages/pose/rtmw/rtmwAdapter';
import { extractRtmw, confirmBodyAtVideo } from '../modules/vision-camera-pose/src';

export type ExtractResult = {
  poseFrames: PoseFrame[];
  rtmw: Rtmw133Frame[];
  failure: 'no-person' | null;
};

/**
 * Extract RTMW pose frames from a recorded video clip.
 *
 * EXTERNAL ASSUMPTION (RULE 42) — `captureFps` and `analyzerDecimation` are
 * externally supplied by the caller, sourced from `lib/cameraFormat.ts`.
 * This module does NOT import those constants directly so callers control
 * the assumed source frame rate per recording (a device that falls back
 * below 240 fps yields a different effective decimation rate).
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
  videoWidth: number,
  videoHeight: number,
  captureFps: number,
  analyzerDecimation: number,
): Promise<ExtractResult> {
  const step = analyzerDecimation * (1000 / captureFps);
  const upperBound = Math.floor(clipDurationMs / step);
  const timestamps: number[] = [];
  for (let i = 0; i <= upperBound; i++) {
    timestamps.push(i * step);
  }

  const rtmwFrames = await extractRtmw(videoUri, timestamps);

  if (rtmwFrames.length === 0) {
    return { poseFrames: [], rtmw: [], failure: null };
  }

  const middleTimestamp = clipDurationMs / 2;
  const bodyConfirm = await confirmBodyAtVideo(videoUri, middleTimestamp);
  if (!bodyConfirm.humanPresent) {
    return { poseFrames: [], rtmw: [], failure: 'no-person' };
  }

  const rtmw: Rtmw133Frame[] = rtmwFrames.map((f) => ({
    timestampMs: f.timestampMs,
    keypoints: f.keypoints,
    frameWidth: videoWidth,
    frameHeight: videoHeight,
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

  return { poseFrames, rtmw, failure: null };
}
