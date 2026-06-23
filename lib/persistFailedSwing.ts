import { persistSwing, type CameraGuidanceSnapshot } from './persistSwing';
import { persistPoseFull } from './persistPoseFull';
import { analyzePoseSequence } from '../packages/domain/swing/analysisPipeline';
import type { CaptureClassification } from './captureValidity';
import type { CaptureFrameStats } from './usePoseFrameHandler';
import type { GravityReading } from '../packages/domain/swing/tiltCorrection';
import type { Rtmw133Frame } from '../packages/pose/rtmw/Rtmw133Frame';
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
  // Raw pose stream retained for debugging (#4) when extraction produced frames
  // but the swing was still rejected. Attached to the stub row's pose_full via a
  // side-effect-free UPDATE. Null/empty for the genuinely-frameless failures.
  rtmw?: Rtmw133Frame[] | null;
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
  const swingId = await persistSwing(
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

  // Retain the raw stream on the stub row for debugging (#4). persistPoseFull is
  // a pure UPDATE of pose_full + pose_source (no count/event/clinic side effect),
  // so the stub stays side-effect-suppressed. Skip when there's no row (anonymous
  // / no user → swingId null) or no frames (genuinely-empty failure).
  if (swingId && ctx.rtmw?.length) {
    await persistPoseFull(swingId, ctx.rtmw).catch((err) =>
      console.warn('[persistFailedSwing] pose_full attach failed', err),
    );
  }

  return swingId;
}
