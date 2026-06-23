import { persistSwing, type CameraGuidanceSnapshot } from './persistSwing';
import { analyzePoseSequence } from '../packages/domain/swing/analysisPipeline';
import type { CaptureClassification } from './captureValidity';
import type { CaptureFrameStats } from './usePoseFrameHandler';
import type { GravityReading } from '../packages/domain/swing/tiltCorrection';
import { CAPTURE_FPS } from './cameraFormat';

export interface FailedSwingContext {
  captureFrameStats: CaptureFrameStats;
  targetFps: number | null;
  cameraGuidance: CameraGuidanceSnapshot;
  gravityReadings: GravityReading[];
  // Button-press snapshot, threaded so a failed capture is attributed to the
  // same kid as a successful one (no stale/default re-read at persist time).
  playerProfileId?: string | null;
  isLeftHanded?: boolean;
}

export async function persistFailedSwing(
  reason: string,
  ctx: FailedSwingContext,
): Promise<string | null> {
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
    reason,
  };
  return persistSwing(
    [],
    emptyAnalysis,
    stubClassification,
    ctx.cameraGuidance,
    null,
    ctx.captureFrameStats,
    ctx.targetFps,
    ctx.gravityReadings,
    ctx.playerProfileId,
    null, // captureFps
    null, // videoDurationMs
    null, // videoFrameCount
    null, // extractionTotalMs
    null, // watchImu
    ctx.isLeftHanded,
  );
}
