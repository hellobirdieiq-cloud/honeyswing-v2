import { useEffect, useRef, useState } from 'react';
import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Camera } from 'react-native-vision-camera';
import type { Router, Href } from 'expo-router';
import type { AudioPlayer } from 'expo-audio';
import type { PoseSequence } from '../packages/pose/PoseTypes';
import type { Rtmw133Frame } from '../packages/pose/rtmw/Rtmw133Frame';
import {
  clearCurrentSwingAnalysis,
  clearCurrentSwingMotion,
  setCurrentSwingAnalysis,
  setCurrentSwingId,
  setCurrentSwingMotion,
  setCurrentSwingVideoUri,
} from './swingMotionStore';
import { analyzePoseSequence } from '../packages/domain/swing/analysisPipeline';
import { correctLowerBodyIdentity } from '../packages/domain/swing/lowerBodyIdentity';
import { persistSwing } from './persistSwing';
import { persistFailedSwing } from './persistFailedSwing';
import { uploadSwingVideo } from './uploadSwingVideo';
import {
  captureVideoOutbox,
  capturePoseOutbox,
  attachSwingId,
  abandonPending,
  outboxEnabled,
} from './outbox';
import { classifyCapture } from '@/packages/domain/swing/captureValidity';
import { getActiveProfileHandedness } from './handedness';
import { resolveAttribution, type ActiveProfileSnapshot } from './swingAttribution';
import { useWatchImuCapture } from './useWatchImuCapture';
import { STARTED_FRESHNESS_MS } from './watchImuConstants';
import type { CameraGuidanceColor } from './cameraGuidance';
import type { GravityReading } from '../packages/domain/swing/tiltCorrection';
import { classifyGripFrames, releaseGripBuffer } from '../modules/vision-camera-pose/src';
import { resetCaptureFrameStats, getCaptureFrameStats } from './usePoseFrameHandler';
import { extractPoseFromVideo } from './extractPoseFromVideo';
import { persistPoseFull } from './persistPoseFull';
import { recordDriftEvent } from './frameDriftGuard';
import { CAPTURE_FPS, CAPTURE_HEIGHT, CAPTURE_WIDTH, ANALYZER_DECIMATION } from './cameraFormat';
import {
  computeNavigationBlockReason,
  deriveClassification,
  deriveFallbackGateReason,
  selectLeadWristForGrip,
  buildWatchImuPersistPayload,
  planDriftEvent,
  evaluateWatchAutoStart,
  type CapturePhase,
} from '@/packages/domain/swing/captureFlow';

// ─── Constants ──────────────────────────────────────────────────────────────

const CAPTURE_WINDOW_MS = 4000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface UseSwingCaptureOptions {
  cameraRef: React.RefObject<Camera | null>;
  router: Router;
  goPlayer: AudioPlayer;
  startTiltCapture: () => void;
  stopTiltCapture: () => void;
  getTiltReadings: () => GravityReading[];
  smoothedSepRef: React.MutableRefObject<number | null>;
  guidanceColor: CameraGuidanceColor | null;
  hasPermission: boolean | null;
  hasDevice: boolean;
  cameraReady: boolean;
  onBeginRecording: () => void;
  targetFps?: number;
  onSwingPersisted?: (swingId: string | null) => void;
  skipResultNavigation?: boolean;
  // Synchronous read of the active profile shown in the kid chip, sampled at
  // button-press. Returns null when no profile is selected → recording is blocked.
  // Optional: legacy callers (clinic) omit it and keep the persist-time fallback.
  getActiveProfile?: () => ActiveProfileSnapshot | null;
  onMissingProfile?: () => void;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useSwingCapture({
  cameraRef,
  router,
  goPlayer,
  startTiltCapture,
  stopTiltCapture,
  getTiltReadings,
  smoothedSepRef,
  guidanceColor,
  hasPermission,
  hasDevice,
  cameraReady,
  onBeginRecording,
  targetFps,
  onSwingPersisted,
  skipResultNavigation = false,
  getActiveProfile,
  onMissingProfile,
}: UseSwingCaptureOptions) {
  const [capturePhase, setCapturePhase] = useState<CapturePhase>('idle');
  const [countdown, setCountdown] = useState<number | null>(null);
  // Pre-armed "ready" state: the only state in which a fresh watch `started` may auto-start
  // video. Entering it runs the clock-sync handshake (watch reachable-only).
  const [preArmed, setPreArmed] = useState(false);
  const preArmedRef = useRef(false);

  // Apple Watch IMU capture, composed beside tilt capture (tilt is prop-injected;
  // watch is internal so record.tsx needs no change). No-ops entirely when the
  // "Apple Watch capture (beta)" toggle is OFF.
  const watch = useWatchImuCapture();

  const capturePhaseRef = useRef<CapturePhase>('idle');
  const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisReadyRef = useRef(false);
  const videoUriRef = useRef<'pending' | null | string>('pending');
  const navigatedRef = useRef(false);
  const swingIdPromiseRef = useRef<Promise<string | null> | null>(null);
  const isFinalizingRef = useRef(false);
  const gravityReadingsRef = useRef<GravityReading[]>([]);
  const isLeftHandedRef = useRef<boolean>(false);
  // Active-profile snapshot taken at beginRecording (button-press), threaded
  // through analysis + persist so a mid-extraction kid-switch can't re-attribute
  // the swing. getActiveProfileRef is kept fresh each render so the watch-started
  // effect (mounted once) never reads a stale closure.
  const getActiveProfileRef = useRef(getActiveProfile);
  getActiveProfileRef.current = getActiveProfile;
  const activeProfileSnapshotRef = useRef<ActiveProfileSnapshot | null>(null);
  const recordingStopFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  // Watch-IMU alignment inputs threaded from beginRecording → persist.
  const recordIntentAtRef = useRef<number | null>(null);
  const captureOriginRef = useRef<'watch' | 'phone'>('phone');
  // Durable-outbox video entry id for THIS capture. Minted at recording-finish
  // (decoupled from swingId + network); reconciled via attachSwingId on persist
  // success, or abandoned on any terminal capture failure. iOS only.
  const videoOutboxEntryIdRef = useRef<string | null>(null);
  const guidanceSnapshotRef = useRef<{ separation: number | null; color: CameraGuidanceColor | null }>({
    separation: null,
    color: null,
  });

  function updateCapturePhase(nextPhase: CapturePhase) {
    capturePhaseRef.current = nextPhase;
    setCapturePhase(nextPhase);
  }

  function clearTimers() {
    if (captureTimeoutRef.current) {
      clearTimeout(captureTimeoutRef.current);
      captureTimeoutRef.current = null;
    }
    if (countdownRef.current) {
      clearTimeout(countdownRef.current);
      countdownRef.current = null;
    }
    if (recordingStopFallbackTimerRef.current) {
      clearTimeout(recordingStopFallbackTimerRef.current);
      recordingStopFallbackTimerRef.current = null;
    }
  }

  async function tryNavigate() {
    const blockReason = computeNavigationBlockReason({
      phase: capturePhaseRef.current,
      analysisReady: analysisReadyRef.current,
      video: videoUriRef.current,
      navigated: navigatedRef.current,
    });

    console.log(
      `[tryNavigate] phase=${capturePhaseRef.current} analysis=${analysisReadyRef.current} video=${videoUriRef.current === 'pending' ? 'pending' : typeof videoUriRef.current === 'string' ? 'ready' : videoUriRef.current} navigated=${navigatedRef.current} → ${blockReason ? `BLOCKED(${blockReason})` : 'NAVIGATING'}`
    );

    if (capturePhaseRef.current !== 'complete') return;
    if (!analysisReadyRef.current) return;
    if (videoUriRef.current === 'pending') return;
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    setCurrentSwingVideoUri(videoUriRef.current);

    let swingId: string | null = null;
    try {
      swingId = await (swingIdPromiseRef.current ?? Promise.resolve(null));
    } catch {
      // persist failed — navigate without swingId
    }
    if (skipResultNavigation) {
      onSwingPersisted?.(swingId);
      return;
    }
    router.push({ pathname: '/analysis/result', params: swingId ? { swingId } : {} } as Href);
  }

  // rtmw: raw frames retained for debugging when extraction DID produce a stream
  // but the swing was still rejected (no-person, or analysis/phase-detection
  // threw). Attached to the stub row's pose_full so #4 can replay the rejection.
  // Omitted for the genuinely-empty failures (zero-frames, recording-error).
  function handleCaptureFailure(reason: string, rtmw?: Rtmw133Frame[] | null) {
    // A failed capture never uploads its video — abandon the durable entry so it
    // isn't stranded pending until the orphan sweep.
    const strandedVideoEntry = videoOutboxEntryIdRef.current;
    if (strandedVideoEntry) {
      videoOutboxEntryIdRef.current = null;
      abandonPending([strandedVideoEntry]).catch((e) =>
        console.warn('[HoneySwing] abandonPending (capture failure) failed', e),
      );
    }

    const stats = getCaptureFrameStats();
    AsyncStorage.setItem(
      'lastFailedCaptureStats',
      JSON.stringify({
        reason,
        totalCallbacks: stats.total_callbacks,
        nonzeroLandmarkFrames: stats.nonzero_landmark_frames,
        timestamp: Date.now(),
      }),
    ).catch((err) => console.error('[HoneySwing] lastFailedCaptureStats write:', err));

    clearTimers();
    updateCapturePhase('processing');

    swingIdPromiseRef.current = persistFailedSwing(reason, {
      captureFrameStats: stats,
      targetFps: targetFps ?? null,
      cameraGuidance: {
        camera_angle_at_start: guidanceSnapshotRef.current.separation,
        camera_guidance_color: guidanceSnapshotRef.current.color,
      },
      gravityReadings: gravityReadingsRef.current,
      playerProfileId: activeProfileSnapshotRef.current?.id,
      isLeftHanded: activeProfileSnapshotRef.current?.isLeftHanded,
      rtmw: rtmw ?? null,
    }).catch((err) => {
      console.error('[persistFailedSwing] FAILED', err);
      return null;
    });

    analysisReadyRef.current = true;
    videoUriRef.current = null;
    updateCapturePhase('complete');

    swingIdPromiseRef.current.then((swingId) => {
      if (navigatedRef.current) return;
      navigatedRef.current = true;
      if (skipResultNavigation) {
        onSwingPersisted?.(swingId);
        return;
      }
      router.push({
        pathname: '/analysis/no-swing',
        params: { reason, ...(swingId ? { swingId } : {}) },
      } as Href);
    });
  }

  async function finalizeCapture() {
    if (isFinalizingRef.current) return;
    isFinalizingRef.current = true;

    clearTimers();
    stopTiltCapture();
    watch.stopCapture();
    gravityReadingsRef.current = getTiltReadings();
    // Record flow captured handedness from the button-press snapshot
    // (isLeftHandedRef, set in beginRecording). Legacy callers without a profile
    // provider still read it here at finalize, as before.
    if (!activeProfileSnapshotRef.current) {
      isLeftHandedRef.current = await getActiveProfileHandedness();
    }
    cameraRef.current?.stopRecording()?.catch(() => {});

    // EXTERNAL ASSUMPTION — iOS typical stopRecording finalize latency ~100-500ms;
    // 1500ms gives ~3x headroom. Not measured.
    recordingStopFallbackTimerRef.current = setTimeout(() => {
      console.log('[KPI] stop-fallback-fired', Date.now());
      handleCaptureFailure('recording-stop-fallback');
    }, 1500);
  }

  function beginRecording(opts?: { origin?: 'watch' | 'phone' }) {
    // Sample the active profile at button-press and hard-block if none is set —
    // a swing must never be recorded (and later persisted) without a kid to
    // attribute it to. Handedness comes from the same snapshot, so analysis and
    // persistence agree with the kid shown in the chip at this instant. Legacy
    // callers without a provider (clinic) skip this and keep the persist-time
    // fallback (snapshot left null → finalizeCapture reads handedness, persist
    // resolves the primary profile).
    const provider = getActiveProfileRef.current;
    if (provider) {
      const attribution = resolveAttribution(provider());
      if (!attribution) {
        console.warn('[useSwingCapture] beginRecording blocked — no active profile');
        onMissingProfile?.();
        return;
      }
      activeProfileSnapshotRef.current = {
        id: attribution.playerProfileId,
        isLeftHanded: attribution.isLeftHanded,
      };
      isLeftHandedRef.current = attribution.isLeftHanded;
    } else {
      activeProfileSnapshotRef.current = null;
    }

    const origin = opts?.origin ?? 'phone';
    captureOriginRef.current = origin;
    NativeModules.HoneyGripBridge?.resetPoseState?.();
    clearCurrentSwingMotion();
    clearCurrentSwingAnalysis();
    analysisReadyRef.current = false;
    videoUriRef.current = 'pending';
    navigatedRef.current = false;
    isFinalizingRef.current = false;
    videoOutboxEntryIdRef.current = null;
    resetCaptureFrameStats();
    onBeginRecording();

    guidanceSnapshotRef.current = {
      separation: smoothedSepRef.current,
      color: guidanceColor,
    };

    startTiltCapture();
    // Watch-primary: a watch-initiated capture is ALREADY recording — do not re-arm it.
    // The phone warm/legacy path opportunistically arms a reachable watch (IMU absent if not).
    if (origin === 'phone') {
      watch.startCapture().catch(() => {});
    }
    const recordIntentAt = Date.now();
    recordIntentAtRef.current = recordIntentAt;
    console.log('[KPI] record-intent', recordIntentAt);
    // Stamp the monotonic video-start anchor (same clock domain as the sync offset).
    void watch.stampVideoAnchor();
    cameraRef.current?.startRecording({
      videoCodec: 'h265',
      onRecordingFinished: async (video) => {
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
          // EXTERNAL ASSUMPTION — 45s pipeline timeout. Covers observed worst-case extraction (~30s on a 5s clip) plus margin; revisit if clip length grows. Not a measured ceiling.
          const EXTRACTION_TIMEOUT_MS = 45000;
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

          setCurrentSwingMotion({ frames: correctedFrames, recordedAt: Date.now(), source: 'live-camera' });
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
              const poseEntryId = poseEntryIdPromise ? await poseEntryIdPromise : null;
              const ids = [poseEntryId, videoOutboxEntryIdRef.current].filter(
                (x): x is string => typeof x === 'string',
              );
              videoOutboxEntryIdRef.current = null;
              if (swingId) {
                attachSwingId(ids, swingId); // reconcile: fires one drain
              } else if (ids.length > 0) {
                // insert returned null (anonymous / failed) — these can never
                // reconcile; drop them (no dead-letter, no telemetry).
                abandonPending(ids).catch((e) =>
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
      },
      onRecordingError: (e) => {
        console.error('[HoneySwing] REC ERR:', e);
        handleCaptureFailure('recording-error');
      },
    });

    recordingStartedAtRef.current = Date.now();
    updateCapturePhase('capturing');
    goPlayer.play();

    captureTimeoutRef.current = setTimeout(() => {
      finalizeCapture().catch(err => console.error('[finalizeCapture] timeout error:', err));
    }, CAPTURE_WINDOW_MS);
  }

  function startCountdownCapture() {
    if (!hasPermission || !hasDevice || !cameraReady) return;

    clearTimers();
    updateCapturePhase('countdown');
    setCountdown(3);

    let remaining = 3;
    const tick = () => {
      remaining -= 1;
      if (remaining > 0) {
        setCountdown(remaining);
        countdownRef.current = setTimeout(tick, 1000);
      } else {
        setCountdown(null);
        beginRecording();
      }
    };
    countdownRef.current = setTimeout(tick, 1000);
  }

  function startInstantCapture() {
    if (!hasPermission || !hasDevice || !cameraReady) return;

    clearTimers();
    beginRecording();
  }

  // Enter the pre-armed "ready" state: the watch-primary path. Runs the clock-sync handshake
  // (watch reachable-only) so a subsequent watch-initiated `started` can auto-start video.
  function enterReady() {
    preArmedRef.current = true;
    setPreArmed(true);
    void watch.prearm();
  }

  function exitReady() {
    preArmedRef.current = false;
    setPreArmed(false);
  }

  // Auto-start video when the watch initiates a capture AND the screen is pre-armed + the
  // signal is fresh. A stale / not-pre-armed start only adopts the seq (for alignment /
  // late-join) — it never starts a recording.
  useEffect(() => {
    const unsub = watch.registerStartedHandler((started) => {
      const { fresh, shouldStart } = evaluateWatchAutoStart({
        startedAgeMs: started.startedAgeMs,
        freshnessMs: STARTED_FRESHNESS_MS,
        preArmed: preArmedRef.current,
        phase: capturePhaseRef.current,
      });
      if (shouldStart) {
        console.log('[useSwingCapture] watch started → auto-start video', {
          seq: started.seq,
          ageMs: Math.round(started.startedAgeMs),
        });
        preArmedRef.current = false;
        setPreArmed(false);
        beginRecording({ origin: 'watch' });
      } else {
        console.log('[useSwingCapture] watch started (no auto-start)', {
          preArmed: preArmedRef.current,
          fresh,
          phase: capturePhaseRef.current,
          seq: started.seq,
        });
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    capturePhase,
    countdown,
    preArmed,
    enterReady,
    exitReady,
    startCountdownCapture,
    startInstantCapture,
    finalizeCapture,
    updateCapturePhase,
    capturePhaseRef,
    clearTimers,
  };
}
