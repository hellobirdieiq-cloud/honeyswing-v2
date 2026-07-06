/**
 * captureProcessing.ts — the post-recording pipeline, moved verbatim from
 * useSwingCapture.ts (Batch 5.1): outbox capture → pose extraction (45s timeout)
 * → identity correction → watch-IMU alignment → analysis → grip estimation →
 * store writes → persistSwing → outbox reconcile → drift telemetry → navigation.
 * Impure by nature (native modules, supabase, outbox) — lives in lib/, not
 * packages/domain. The capture hook owns state, failure routing and navigation,
 * and injects them via CaptureProcessingContext (refs as refs — see the type).
 */
import type { MutableRefObject } from 'react';
import type { VideoFile } from 'react-native-vision-camera';
import type { PoseSequence } from '../packages/pose/PoseTypes';
import type { Rtmw133Frame } from '../packages/pose/rtmw/Rtmw133Frame';
import {
  setCurrentSwingAnalysis,
  setCurrentSwingId,
  setCurrentSwingMotion,
} from './swingMotionStore';
import { analyzePoseSequence } from '../packages/domain/swing/analysisPipeline';
import { correctLowerBodyIdentity } from '../packages/domain/swing/lowerBodyIdentity';
import { persistSwing } from './persistSwing';
import { uploadSwingVideo } from './uploadSwingVideo';
import {
  captureVideoOutbox,
  capturePoseOutbox,
  attachSwingId,
  abandonPending,
  outboxEnabled,
} from './outbox';
import { classifyCapture } from '@/packages/domain/swing/captureValidity';
import type { ActiveProfileSnapshot } from './swingAttribution';
import type { VideoAlignAnchor } from './useWatchImuCapture';
import type { WatchImuReading, WatchImuMeasured, WatchImuAlignment } from '../packages/domain/swing/watchImu';
import type { CameraGuidanceColor } from './cameraGuidance';
import type { GravityReading } from '../packages/domain/swing/tiltCorrection';
import { classifyGripFrames, releaseGripBuffer } from '../modules/vision-camera-pose/src';
import { getCaptureFrameStats } from './usePoseFrameHandler';
import { extractPoseFromVideo } from './extractPoseFromVideo';
import { persistPoseFull } from './persistPoseFull';
import { recordDriftEvent } from './frameDriftGuard';
import { CAPTURE_FPS, CAPTURE_HEIGHT, CAPTURE_WIDTH, ANALYZER_DECIMATION } from './cameraFormat';
import {
  deriveClassification,
  deriveFallbackGateReason,
  selectLeadWristForGrip,
  buildWatchImuPersistPayload,
  planDriftEvent,
  planOutboxReconcile,
  type CapturePhase,
} from '@/packages/domain/swing/captureFlow';

/**
 * The watch surface the pipeline needs (narrow on purpose — the runtime object
 * is useWatchImuCapture's return; a fake with these five methods is enough to
 * exercise the pipeline).
 */
export interface WatchCaptureApi {
  getReadings(): Promise<WatchImuReading[]>;
  getSummary(): WatchImuMeasured | null;
  getAlignment(readings: WatchImuReading[], anchor: VideoAlignAnchor): Promise<WatchImuAlignment | null>;
  getCurrentSeq(): number;
  registerSwingId(seq: number, swingId: string | null): void;
}

/**
 * Everything the pipeline reads from the capture in flight. Refs are passed AS
 * REFS (never dereferenced at build time): gravityReadingsRef, isLeftHandedRef
 * and recordingStopFallbackTimerRef are written in finalizeCapture AFTER the
 * context is built at button-press — a by-value snapshot would silently read
 * stale data. Non-ref fields (watch, targetFps) are deliberately captured at
 * press time: identical to the closure the inline callback previously formed
 * (including the first-render staleness on the watch-initiated path).
 */
export interface CaptureProcessingContext {
  videoUriRef: MutableRefObject<'pending' | null | string>;
  videoOutboxEntryIdRef: MutableRefObject<string | null>;
  swingIdPromiseRef: MutableRefObject<Promise<string | null> | null>;
  analysisReadyRef: MutableRefObject<boolean>;
  isLeftHandedRef: MutableRefObject<boolean>;
  gravityReadingsRef: MutableRefObject<GravityReading[]>;
  guidanceSnapshotRef: MutableRefObject<{ separation: number | null; color: CameraGuidanceColor | null }>;
  activeProfileSnapshotRef: MutableRefObject<ActiveProfileSnapshot | null>;
  recordIntentAtRef: MutableRefObject<number | null>;
  captureOriginRef: MutableRefObject<'watch' | 'phone'>;
  recordingStopFallbackTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  watch: WatchCaptureApi;
  targetFps: number | undefined;
  updateCapturePhase: (phase: CapturePhase) => void;
  handleCaptureFailure: (reason: string, rtmw?: Rtmw133Frame[] | null) => void;
  tryNavigate: () => void;
}

/**
 * Post-recording pipeline: outbox capture → extraction → analysis → grip →
 * store writes → persist → outbox reconcile → drift telemetry → navigation.
 * Body moved VERBATIM from the former inline onRecordingFinished callback
 * (de-closured: free variables arrive via ctx; the destructure restores the
 * original names so the body is unchanged).
 */
export async function processRecordedVideo(video: VideoFile, ctx: CaptureProcessingContext): Promise<void> {
  const {
    videoUriRef,
    videoOutboxEntryIdRef,
    swingIdPromiseRef,
    analysisReadyRef,
    isLeftHandedRef,
    gravityReadingsRef,
    guidanceSnapshotRef,
    activeProfileSnapshotRef,
    recordIntentAtRef,
    captureOriginRef,
    recordingStopFallbackTimerRef,
    watch,
    targetFps,
    updateCapturePhase,
    handleCaptureFailure,
    tryNavigate,
  } = ctx;

  if (recordingStopFallbackTimerRef.current) {
    clearTimeout(recordingStopFallbackTimerRef.current);
    recordingStopFallbackTimerRef.current = null;
  }
  videoUriRef.current = video.path;
  updateCapturePhase('processing');

  // Decoupled durable capture: copy the temp video into the outbox as
  // early as possible (synchronous id mint + meta write; copy runs in the
  // background). MUST run BEFORE the up-to-45s extraction so a kill during
  // extraction still drains the video later. Extraction reads the ORIGINAL
  // temp path and is never blocked. iOS only; Android stays on fallback.
  if (outboxEnabled()) {
    try {
      videoOutboxEntryIdRef.current = captureVideoOutbox(video.path);
    } catch (e) {
      console.warn('[HoneySwing] captureVideoOutbox threw', e);
      videoOutboxEntryIdRef.current = null;
    }
  }

  let extractionMs = 0;
  let analysisMs = 0;
  // Hoisted so the catch can retain the raw stream on a post-extraction
  // throw (e.g. face-on phase-detection breach) — null until extraction
  // succeeds, so a pre-extraction throw correctly persists no frames.
  let rtmwForFailure: Rtmw133Frame[] | null = null;

  try {
    // EXTERNAL ASSUMPTION — 90s pipeline timeout, sized for decimation 2 (120fps): extraction
    // scales with frame count, so the 60fps observed worst case (~30s on a 5s clip) doubles to
    // ~60s < 90s. Revisit if clip length grows. Not a measured ceiling; unverified on-device at
    // decimation 2 until the 120fps test swing logs extractionMs.
    const EXTRACTION_TIMEOUT_MS = 90000;
    const result = await Promise.race([
      extractPoseFromVideo(
        video.path,
        video.duration * 1000,
        CAPTURE_WIDTH,
        CAPTURE_HEIGHT,
        CAPTURE_FPS,
        ANALYZER_DECIMATION,
      ),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('extraction-timeout')), EXTRACTION_TIMEOUT_MS),
      ),
    ]);

    extractionMs = result.rtmw.reduce((acc, f) => acc + (f.extractionMs ?? 0), 0);

    if (result.failure === 'no-person') {
      handleCaptureFailure('no-person', result.rtmw);
      return;
    }
    if (result.rtmw.length === 0) {
      handleCaptureFailure('zero-frames');
      return;
    }

    const { poseFrames, rtmw } = result;
    rtmwForFailure = rtmw; // retain for a post-extraction throw (see catch)
    // Layer 0 routing — corrected stream feeds ONE consumer: the live
    // replay store (setCurrentSwingMotion), i.e. the kid-visible
    // skeleton. Everything else deliberately reads RAW poseFrames:
    //   - analyzePoseSequence: applies the same idempotent pass at its
    //     canonical chokepoint — bit-identical output, and RAW input
    //     preserves the true swap set in swing_debug.keypoint_identity.
    //   - grip block: wrist joints only; identity never touches wrists.
    //   - classifyCapture: confidence-count over symmetric L/R pairs —
    //     provably swap-invariant (packages/domain/swing/captureValidity.ts).
    //   - persistSwing: persisted motion_frames are the debug source of
    //     truth; historical reads re-apply this pure pass at fetch time
    //     (lib/swingStore.ts getSwingMotionFrames/Batch).
    const correctedFrames = correctLowerBodyIdentity(poseFrames).frames;
    const sequence: PoseSequence = {
      frames: poseFrames, // RAW → analysis (corrects internally; see above)
      source: 'rtmw-l-2d-v1',
      metadata: { fps: CAPTURE_FPS, durationMs: video.duration * 1000 },
    };
    // Pull the paired-watch IMU blob now (post-extraction = maximal time for
    // the transfer to land). Empty [] when toggle OFF / no watch / stale.
    const watchReadings = await watch.getReadings();
    const watchSummary = watch.getSummary();
    const watchSeq = watch.getCurrentSeq();
    const watchAlignment =
      watchReadings.length > 0
        ? await watch.getAlignment(watchReadings, {
            videoDurationMs: video.duration * 1000,
            recordIntentAtMs: recordIntentAtRef.current,
            captureOrigin: captureOriginRef.current,
          })
        : null;

    const t0 = Date.now();
    const analysis = analyzePoseSequence(
      sequence,
      isLeftHandedRef.current,
      gravityReadingsRef.current,
      undefined,
      undefined,
      watchReadings,
    );
    analysisMs = Date.now() - t0;

    const fallbackGateReason = deriveFallbackGateReason(analysis.swing_debug);

    console.log('[HoneySwing] extractionMs', extractionMs, 'analysisMs', analysisMs);

    // Grip estimation — preserves the previous contract for persistSwing's nativeGripResult.
    let nativeGripResult: Record<string, unknown>[] | null = null;
    try {
      const addressPhase = analysis.phases?.find((p) => p.phase === 'takeaway');
      if (addressPhase && addressPhase.index < poseFrames.length) {
        const frame = poseFrames[addressPhase.index];
        const leadWrist = selectLeadWristForGrip(frame.joints, isLeftHandedRef.current);
        if (leadWrist) {
          nativeGripResult = await Promise.race([
            classifyGripFrames({
              timestamps: [addressPhase.timestamp],
              wristX: [leadWrist.x],
              wristY: [leadWrist.y],
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
          ]);
          console.log('[GripEstimation]', JSON.stringify(nativeGripResult));
        }
      }
    } catch (e) {
      console.warn('[GripEstimation] Error:', e);
    } finally {
      try { await releaseGripBuffer(); } catch {}
    }

    setCurrentSwingMotion({
      frames: correctedFrames,
      recordedAt: Date.now(),
      source: 'live-camera',
      isLeftHanded: isLeftHandedRef.current,
    });
    setCurrentSwingAnalysis(analysis);
    updateCapturePhase('complete');

    const baseClassification = classifyCapture(poseFrames);
    const classification = deriveClassification(baseClassification, fallbackGateReason);
    const captureFrameStats = getCaptureFrameStats();
    swingIdPromiseRef.current = persistSwing(
      poseFrames, // RAW by design — persisted motion_frames are the debug source of truth
      analysis,
      classification,
      {
        camera_angle_at_start: guidanceSnapshotRef.current.separation,
        camera_guidance_color: guidanceSnapshotRef.current.color,
      },
      nativeGripResult,
      captureFrameStats,
      targetFps ?? null,
      gravityReadingsRef.current,
      activeProfileSnapshotRef.current?.id,
      result.captureFps ?? null,
      result.videoDurationMs ?? null,
      result.videoFrameCount ?? null,
      result.extractionTotalMs ?? null,
      buildWatchImuPersistPayload(watchReadings, watchSummary, watchAlignment, watchSeq),
      activeProfileSnapshotRef.current?.isLeftHanded,
    ).then((swingId) => {
      if (swingId) {
        setCurrentSwingId(swingId);
        console.log('[persistSwing] saved', { swingId, frames: poseFrames.length });
      } else {
        console.warn('[persistSwing] skipped (no user)', { frames: poseFrames.length });
      }
      // Record seq→swingId for the watch-IMU late-join map (and clear in-flight).
      watch.registerSwingId(watchSeq, swingId);
      return swingId;
    }).catch((err) => {
      console.error('[persistSwing] FAILED', {
        error: err.message,
        frames: poseFrames.length,
        classification: classification?.validity ?? 'unknown',
      });
      // Clear the in-flight seq even on failure so a late batch for this seq can still
      // drain (→ IMU-only, since no swing row exists) rather than being suppressed.
      watch.registerSwingId(watchSeq, null);
      return null;
    });

    // Snapshot drift inputs before the .then so the closure captures by
    // value — keeps the Phase 8 sensor independent of any future
    // result-scope refactor.
    const driftFrameCount = result.videoFrameCount;
    const driftDurationMs = result.videoDurationMs;
    const driftFailure = result.failure;

    // Durable outbox (iOS) vs legacy fire-and-forget (Android). The pose
    // payload is captured here (awaited write inside capturePoseOutbox =
    // durable) and, together with the video entry, reconciled once
    // persistSwing resolves a swingId. MUST run after swingIdPromiseRef is
    // assigned (above) — otherwise this .then chain would see null.
    const poseEntryIdPromise = outboxEnabled()
      ? capturePoseOutbox(rtmw).catch((e) => {
          console.warn('[HoneySwing] capturePoseOutbox failed', e);
          return null;
        })
      : null;

    swingIdPromiseRef.current?.then(async (swingId) => {
      if (outboxEnabled()) {
        // Ref read stays AFTER the await (mutual-exclusion window with the
        // failure path's read-and-null); only the decision itself is lifted.
        const poseEntryId = poseEntryIdPromise ? await poseEntryIdPromise : null;
        const plan = planOutboxReconcile(poseEntryId, videoOutboxEntryIdRef.current, swingId);
        videoOutboxEntryIdRef.current = null;
        if (plan.action === 'attach') {
          attachSwingId(plan.ids, plan.swingId); // reconcile: fires one drain
        } else if (plan.action === 'abandon') {
          // insert returned null (anonymous / failed) — these can never
          // reconcile; drop them (no dead-letter, no telemetry).
          abandonPending(plan.ids).catch((e) =>
            console.warn('[HoneySwing] abandonPending failed', e),
          );
        }
      } else if (swingId) {
        uploadSwingVideo(swingId, video.path)
          .catch((e) => console.warn('[HoneySwing] uploadSwingVideo failed', e));
        persistPoseFull(swingId, rtmw)
          .catch((e) => console.warn('[HoneySwing] persistPoseFull failed', e));
      }

      const drift = planDriftEvent({
        swingId,
        failure: driftFailure,
        frameCount: driftFrameCount,
        durationMs: driftDurationMs,
      });
      if (drift) {
        recordDriftEvent(drift.swingId, drift.frameCount, drift.durationMs, CAPTURE_FPS)
          .catch((e) => console.warn('[HoneySwing] recordDriftEvent failed', e));
      }
    });

    analysisReadyRef.current = true;
    tryNavigate();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('trail timestamp not found in frames')) {
      // detectFaceOnPhases invariant breach (phaseDetectionFaceOn.ts:410) —
      // dev telemetry; user-facing path is the same as any other extract failure.
      console.warn('[HoneySwing] phase detection invariant breach (dev telemetry):', msg);
    } else {
      console.warn('[HoneySwing] extract-or-analyze threw:', msg);
    }
    handleCaptureFailure('extract-or-analyze-threw', rtmwForFailure);
  }
}
