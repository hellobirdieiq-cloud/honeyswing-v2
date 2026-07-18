/**
 * captureProcessing.ts — the post-recording pipeline, moved verbatim from
 * useSwingCapture.ts (Batch 5.1): outbox capture → pose extraction (90s timeout,
 * EXTRACTION_TIMEOUT_MS) → identity correction → watch-IMU alignment → analysis
 * → grip estimation → store writes → navigation (fires as soon as analysis +
 * video are ready — it does NOT await the persist insert, 3de790a) with
 * persistSwing → outbox reconcile → drift telemetry running concurrently.
 * Impure by nature (native modules, supabase, outbox) — lives in lib/, not
 * packages/domain. The capture hook owns state, failure routing and navigation,
 * and injects them via CaptureProcessingContext (refs as refs — see the type).
 */
import type { MutableRefObject } from 'react';
import type { VideoFile } from 'react-native-vision-camera';
import type { PoseSequence } from '../packages/pose/PoseTypes';
import type { Rtmw133Frame } from '../packages/pose/rtmw/Rtmw133Frame';
import {
  getCurrentCaptureToken,
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
  holdSwing,
  outboxEnabled,
} from './outbox';
import { classifyCapture } from '@/packages/domain/swing/captureValidity';
import type { ActiveProfileSnapshot } from './swingAttribution';
import type { VideoAlignAnchor } from './useWatchImuCapture';
import type { WatchImuReading, WatchImuMeasured, WatchImuAlignment } from '../packages/domain/swing/watchImu';
import type { CameraGuidanceColor } from './cameraGuidance';
import type { GravityReading } from '../packages/domain/swing/tiltCorrection';
import { classifyGripFrames, releaseGripBuffer } from '../modules/vision-camera-pose/src';
import { extractPoseFromVideo } from './extractPoseFromVideo';
import { runPuttingPipeline } from './puttingPipeline';
import { setCurrentPuttResult, setCurrentPuttSwingId } from './puttResultStore';
import { persistPutt } from './persistPutt';
import { APP_VERSION } from './appVersion';
import type { PoseFrame } from '../packages/pose/PoseTypes';
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
  type StopOrigin,
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
 * THIS capture's durable video-outbox entry, held BY VALUE with an
 * abandonment flag. The reconcile .then and the failure path coordinate
 * through this object instead of the hook-lifetime shared ref: a later
 * capture's beginRecording resets that ref, so reading it after the awaited
 * insert either stranded this capture's video (never attached → dead-letter)
 * or, worse, attached the NEXT capture's entry to this capture's row.
 */
export interface PipelineVideoEntry {
  id: string | null;
  abandoned: boolean;
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
  // Written in finalizeCapture (after context build) — refs as refs, like the above.
  stopOriginRef: MutableRefObject<StopOrigin | null>;
  discardRequestedRef: MutableRefObject<boolean>;
  watch: WatchCaptureApi;
  targetFps: number | undefined;
  /**
   * Phase C: capture mode snapshotted at button-press (beginRecording). By
   * value deliberately — a mid-extraction pill toggle must not re-classify
   * the capture. 'putt' forks the pipeline after pose extraction.
   */
  mode: 'swing' | 'putt';
  updateCapturePhase: (phase: CapturePhase) => void;
  // The hook binds this to the capture's generation; the pipeline passes its
  // video entry so a failure abandons THIS capture's entry, never the shared ref's.
  handleCaptureFailure: (
    reason: string,
    rtmw?: Rtmw133Frame[] | null,
    videoEntry?: PipelineVideoEntry,
  ) => void;
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
    stopOriginRef,
    discardRequestedRef,
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

  // Sub-minimum manual stop (< VALID_MIN_MS of recording): the clip is a
  // fragment — discard it silently. No extraction, no analysis, no persist,
  // no outbox entry; the phase returns to idle for the next attempt.
  // Telemetry limitation: discarded fragments therefore leave no swing row,
  // so swing_debug.stop_origin never records them — this dev log is the only trace.
  if (discardRequestedRef.current) {
    discardRequestedRef.current = false;
    console.log('[HoneySwing] sub-minimum manual stop — fragment discarded', {
      videoDurationMs: Math.round(video.duration * 1000),
    });
    updateCapturePhase('idle');
    return;
  }

  videoUriRef.current = video.path;
  updateCapturePhase('processing');

  // Decoupled durable capture: copy the temp video into the outbox as
  // early as possible (synchronous id mint + meta write; copy runs in the
  // background). MUST run BEFORE the up-to-45s extraction so a kill during
  // extraction still drains the video later. Extraction reads the ORIGINAL
  // temp path and is never blocked. iOS only; Android stays on fallback.
  const videoEntry: PipelineVideoEntry = { id: null, abandoned: false };
  if (outboxEnabled()) {
    try {
      videoEntry.id = captureVideoOutbox(video.path);
    } catch (e) {
      console.warn('[HoneySwing] captureVideoOutbox threw', e);
    }
    // Shared ref kept in sync for hook-local failure paths that predate any
    // pipeline entry (recording-error, stop-fallback); this pipeline itself
    // only ever acts on the by-value videoEntry above.
    videoOutboxEntryIdRef.current = videoEntry.id;
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
    const tExtract = Date.now();
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
    // Wall time incl. native bridge + body-confirm; the body-confirm share is
    // derivable as extract_wall_ms − extraction_total_ms − metadata_probe_ms.
    const extractWallMs = Date.now() - tExtract;

    extractionMs = result.rtmw.reduce((acc, f) => acc + (f.extractionMs ?? 0), 0);

    if (result.failure === 'no-person') {
      handleCaptureFailure('no-person', result.rtmw, videoEntry);
      return;
    }
    if (result.rtmw.length === 0) {
      handleCaptureFailure('zero-frames', undefined, videoEntry);
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

    // ── PUTT MODE FORK (Phase C) ─────────────────────────────────────────
    // Everything above (outbox video capture, extraction, body-confirm,
    // identity correction) is shared; everything below (watch IMU, full-swing
    // analysis, grip, swing stores, persistSwing) is full-swing-only. The putt
    // branch runs the putting pipeline and returns — mode 'swing' falls
    // through byte-equivalent.
    if (ctx.mode === 'putt') {
      await processPuttCapture({
        video,
        ctx,
        correctedFrames,
        rtmwForFailure,
        videoEntry,
      });
      return;
    }

    const sequence: PoseSequence = {
      frames: poseFrames, // RAW → analysis (corrects internally; see above)
      source: 'rtmw-l-2d-v1',
      metadata: { fps: CAPTURE_FPS, durationMs: video.duration * 1000 },
    };
    // Pull the paired-watch IMU blob now (post-extraction = maximal time for
    // the transfer to land). Empty [] when toggle OFF / no watch / stale.
    const tWatch = Date.now();
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
    const watchFetchMs = Date.now() - tWatch;

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

    console.log('[HoneySwing] extractionMs', extractionMs, 'analysisMs', analysisMs, 'extractWallMs', extractWallMs);

    // Grip estimation — preserves the previous contract for persistSwing's nativeGripResult.
    const tGrip = Date.now();
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
    const gripMs = Date.now() - tGrip;

    setCurrentSwingMotion({
      frames: correctedFrames,
      recordedAt: Date.now(),
      source: 'live-camera',
      isLeftHanded: isLeftHandedRef.current,
    });
    // Claimed by the setCurrentSwingMotion above; passed to the guarded
    // setCurrentSwingId below so a slow insert that outlives this capture
    // (user backed out, recorded another swing) cannot stamp its id onto the
    // newer swing's result screen.
    const captureToken = getCurrentCaptureToken();
    setCurrentSwingAnalysis(analysis);
    updateCapturePhase('complete');

    const baseClassification = classifyCapture(poseFrames);
    const classification = deriveClassification(baseClassification, fallbackGateReason);
    const pipelineMs = {
      extract_wall_ms: extractWallMs,
      analysis_ms: analysisMs,
      watch_fetch_ms: watchFetchMs,
      grip_ms: gripMs,
      intent_to_persist_ms:
        recordIntentAtRef.current != null ? Date.now() - recordIntentAtRef.current : null,
    };
    // Queue-until-login: persistSwing's anon branch surfaces the built row
    // here (second channel — its return value stays null); the reconcile
    // below routes it to holdSwing. Never set on the signed-in path.
    let heldRowForHold: Record<string, unknown> | null = null;
    swingIdPromiseRef.current = persistSwing(
      poseFrames, // RAW by design — persisted motion_frames are the debug source of truth
      analysis,
      classification,
      {
        camera_angle_at_start: guidanceSnapshotRef.current.separation,
        camera_guidance_color: guidanceSnapshotRef.current.color,
      },
      nativeGripResult,
      targetFps ?? null,
      gravityReadingsRef.current,
      activeProfileSnapshotRef.current?.id,
      result.captureFps ?? null,
      result.videoDurationMs ?? null,
      result.videoFrameCount ?? null,
      result.extractionTotalMs ?? null,
      buildWatchImuPersistPayload(watchReadings, watchSummary, watchAlignment, watchSeq),
      activeProfileSnapshotRef.current?.isLeftHanded,
      stopOriginRef.current,
      result.extractionBreakdown ?? null,
      pipelineMs,
      (row) => {
        heldRowForHold = row as unknown as Record<string, unknown>;
      },
    ).then((swingId) => {
      if (swingId) {
        setCurrentSwingId(swingId, captureToken); // no-op if this capture was superseded
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
        const poseEntryId = poseEntryIdPromise ? await poseEntryIdPromise : null;
        // THIS capture's entry by value — mutual exclusion with the failure
        // path is the per-capture abandoned flag, not the shared ref (which a
        // newer capture may own by the time this insert resolves). The shared
        // ref is cleared only while it still points at our entry.
        const videoEntryId = videoEntry.abandoned ? null : videoEntry.id;
        const plan = planOutboxReconcile(
          poseEntryId,
          videoEntryId,
          swingId,
          heldRowForHold !== null,
        );
        if (videoOutboxEntryIdRef.current === videoEntry.id) {
          videoOutboxEntryIdRef.current = null;
        }
        if (plan.action === 'attach') {
          attachSwingId(plan.ids, plan.swingId); // reconcile: fires one drain
        } else if (plan.action === 'hold') {
          // Signed-out real swing: keep the triple (row + video + pose) for
          // retroactive persist at sign-in. Hold failure degrades to today's
          // abandon so PENDING entries are never left stranded.
          holdSwing({
            row: heldRowForHold!,
            videoEntryId,
            poseEntryId,
          })
            .then((heldSwingId) =>
              console.log('[HoneySwing] swing held for sign-in', { heldSwingId }),
            )
            .catch((e) => {
              console.warn('[HoneySwing] holdSwing failed — abandoning', e);
              abandonPending(plan.ids).catch(() => {});
            });
        } else if (plan.action === 'abandon') {
          // insert returned null (failed / stub) — these can never
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
    handleCaptureFailure('extract-or-analyze-threw', rtmwForFailure, videoEntry);
  }
}

// EXTERNAL ASSUMPTION — putt-pipeline timeout: three bar decode passes + the
// windowed refine over a ≤4s clip; unmeasured on device until the batch
// session logs pipeline.timings. Sized like the extraction race, generous.
const PUTT_PIPELINE_TIMEOUT_MS = 60000;

/**
 * Putt-mode post-extraction branch (Phase C). Consumes the shared front half
 * of processRecordedVideo (outbox capture + extraction + identity correction)
 * and runs the putting pipeline instead of full-swing analysis/grip/persist.
 *
 * classifyCapture still applies (validity floors unchanged — the validated
 * putt clips passed them); an invalid classification is recorded in the putt
 * store's pipeline warnings rather than blocking the result screen.
 */
async function processPuttCapture(args: {
  video: VideoFile;
  ctx: CaptureProcessingContext;
  correctedFrames: PoseFrame[];
  rtmwForFailure: Rtmw133Frame[] | null;
  videoEntry: PipelineVideoEntry;
}): Promise<void> {
  const { video, ctx, correctedFrames, rtmwForFailure, videoEntry } = args;
  try {
    const stepMs = ANALYZER_DECIMATION * (1000 / CAPTURE_FPS);
    const pipeline = await Promise.race([
      runPuttingPipeline({
        videoUri: video.path,
        // Corrected frames: hands (the prior source) are identity-invariant;
        // legs render better in the playback skeleton.
        poseFrames: correctedFrames,
        stepMs,
      }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('putt-pipeline-timeout')), PUTT_PIPELINE_TIMEOUT_MS),
      ),
    ]);

    const classification = classifyCapture(correctedFrames);
    if (classification.validity !== 'valid') {
      pipeline.detectors.intermediates.warnings.push(
        `capture_${classification.validity}${classification.reason ? `_${classification.reason}` : ''}`,
      );
    }
    console.log('[HoneySwing] putt pipeline', {
      timings: pipeline.timings,
      score: pipeline.score,
      warnings: pipeline.detectors.intermediates.warnings,
    });

    const puttToken = setCurrentPuttResult({
      poseFrames: correctedFrames,
      videoUri: video.path,
      recordedAt: Date.now(),
      pipeline,
    });
    ctx.updateCapturePhase('complete');
    ctx.analysisReadyRef.current = true;

    // Persist the putt row (D1 option b: swings row, analysis_version
    // 'putt-v1', filtered from full-swing UI queries). Navigation does NOT
    // await the insert (same as full-swing); the video outbox entry
    // reconciles to the row on success, abandons otherwise (anon putts are
    // not persisted in v1 — no hold path).
    ctx.swingIdPromiseRef.current = persistPutt({
      playerProfileId: ctx.activeProfileSnapshotRef.current?.id ?? null,
      appVersion: APP_VERSION,
      classification,
      frames: correctedFrames,
      durationMs: video.duration * 1000,
      fpsActual: ctx.targetFps ?? null,
      detectors: pipeline.detectors,
      score: pipeline.score,
      smoothed: pipeline.smoothed,
      shaftLenPx: pipeline.shaftLenPx,
      analysisWidth: pipeline.analysisWidth,
      barCalibration: pipeline.barCalibration,
      timings: pipeline.timings,
    }).catch((e) => {
      console.error('[HoneySwing] persistPutt failed', e);
      return null;
    });
    ctx.swingIdPromiseRef.current.then((swingId) => {
      // Label mode reads the id from the store (token-guarded — a superseded
      // capture's late insert can't stamp the newer putt).
      setCurrentPuttSwingId(swingId, puttToken);
      if (!videoEntry.id || videoEntry.abandoned) return;
      if (ctx.videoOutboxEntryIdRef.current === videoEntry.id) {
        ctx.videoOutboxEntryIdRef.current = null;
      }
      if (swingId) {
        attachSwingId([videoEntry.id], swingId); // reconcile: fires one drain
      } else {
        videoEntry.abandoned = true;
        abandonPending([videoEntry.id]).catch((e) =>
          console.warn('[HoneySwing] abandonPending (putt video) failed', e),
        );
      }
    });

    ctx.tryNavigate();
  } catch (e) {
    console.warn('[HoneySwing] putt pipeline threw:', e instanceof Error ? e.message : String(e));
    ctx.handleCaptureFailure('putt-pipeline-error', rtmwForFailure, videoEntry);
  }
}
