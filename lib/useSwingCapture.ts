import { useEffect, useRef, useState } from 'react';
import { NativeModules } from 'react-native';
import { Camera } from 'react-native-vision-camera';
import type { Router, Href } from 'expo-router';
import type { AudioPlayer } from 'expo-audio';
import type { Rtmw133Frame } from '../packages/pose/rtmw/Rtmw133Frame';
import {
  clearCurrentSwingAnalysis,
  clearCurrentSwingMotion,
  setCurrentSwingVideoUri,
} from './swingMotionStore';
import { persistFailedSwing } from './persistFailedSwing';
import { abandonPending } from './outbox';
import { getActiveProfileHandedness } from './handedness';
import { resolveAttribution, type ActiveProfileSnapshot } from './swingAttribution';
import { useWatchImuCapture } from './useWatchImuCapture';
import { STARTED_FRESHNESS_MS } from './watchImuConstants';
import type { CameraGuidanceColor } from './cameraGuidance';
import type { GravityReading } from '../packages/domain/swing/tiltCorrection';
import {
  processRecordedVideo,
  type CaptureProcessingContext,
  type PipelineVideoEntry,
} from './captureProcessing';
import {
  computeNavigationBlockReason,
  evaluateWatchAutoStart,
  type CapturePhase,
  type StopOrigin,
} from '@/packages/domain/swing/captureFlow';
import { VALID_MIN_MS } from '@/packages/domain/swing/captureValidity';

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
  // What ended THIS capture's recording (window timer vs manual stop) — persisted
  // into swing_debug.stop_origin. Null until finalizeCapture runs; stays null for
  // recordings the native layer ended on its own (camera deactivation).
  const stopOriginRef = useRef<StopOrigin | null>(null);
  // Set when a manual stop lands before VALID_MIN_MS of recording: the clip is a
  // fragment — processRecordedVideo discards it (no analysis, no persist) and
  // returns the phase to idle.
  const discardRequestedRef = useRef(false);
  // Watch-IMU alignment inputs threaded from beginRecording → persist.
  const recordIntentAtRef = useRef<number | null>(null);
  const captureOriginRef = useRef<'watch' | 'phone'>('phone');
  // Durable-outbox video entry id for THIS capture. Minted at recording-finish
  // (decoupled from swingId + network); reconciled via attachSwingId on persist
  // success, or abandoned on any terminal capture failure. iOS only.
  const videoOutboxEntryIdRef = useRef<string | null>(null);
  // Monotonic per-capture generation, minted in beginRecording. Every
  // late-arriving async completion (window timer, stop-fallback, failure
  // stub-insert .then, pipeline failure) checks its own generation against
  // this before touching shared state — the same supersession pattern as the
  // store's capture token, generalized to the hook's refs.
  const captureGenerationRef = useRef(0);
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

    if (skipResultNavigation) {
      // Coach/watch mode: the callback contract delivers the RESOLVED id, so
      // this branch (no router.push, nothing user-visible waiting) still
      // awaits the insert.
      let swingId: string | null = null;
      try {
        swingId = await (swingIdPromiseRef.current ?? Promise.resolve(null));
      } catch {
        // persist failed — deliver null
      }
      onSwingPersisted?.(swingId);
      return;
    }
    // Navigation deliberately does NOT await the insert: the result screen
    // renders from the in-memory store and picks up the swingId later via
    // subscribeCurrentSwingId. KPI now measures true intent→push (pre-change
    // builds included the insert share — compare across versions accordingly;
    // [KPI] insert-ms still times the insert itself).
    if (recordIntentAtRef.current != null) {
      console.log('[KPI] intent-to-result-ms', Date.now() - recordIntentAtRef.current);
    }
    router.push('/analysis/result' as Href);
  }

  // rtmw: raw frames retained for debugging when extraction DID produce a stream
  // but the swing was still rejected (no-person, or analysis/phase-detection
  // threw). Attached to the stub row's pose_full so #4 can replay the rejection.
  // Omitted for the genuinely-empty failures (zero-frames, recording-error).
  function handleCaptureFailure(
    reason: string,
    rtmw?: Rtmw133Frame[] | null,
    opts?: { generation?: number; videoEntry?: PipelineVideoEntry },
  ) {
    const generation = opts?.generation ?? captureGenerationRef.current;
    const stale = generation !== captureGenerationRef.current;

    // A failed capture never uploads its video — abandon the durable entry so it
    // isn't stranded pending until the orphan sweep. The pipeline passes ITS
    // capture's entry by value (a later capture may own the shared ref by now);
    // hook-local failures (recording-error, stop-fallback) predate any entry and
    // fall back to the shared ref — current generation only, so a stale failure
    // can never abandon a newer capture's entry.
    const videoEntry = opts?.videoEntry;
    let strandedVideoEntry: string | null = null;
    if (videoEntry) {
      if (videoEntry.id && !videoEntry.abandoned) {
        videoEntry.abandoned = true;
        strandedVideoEntry = videoEntry.id;
      }
    } else if (!stale) {
      strandedVideoEntry = videoOutboxEntryIdRef.current;
    }
    if (strandedVideoEntry) {
      if (videoOutboxEntryIdRef.current === strandedVideoEntry) {
        videoOutboxEntryIdRef.current = null;
      }
      abandonPending([strandedVideoEntry]).catch((e) =>
        console.warn('[HoneySwing] abandonPending (capture failure) failed', e),
      );
    }

    if (stale) {
      // Late failure from a superseded capture: its own entry is abandoned
      // above; everything else (timers, phase, swingIdPromiseRef, navigation)
      // belongs to the CURRENT capture and stays untouched. No stub row
      // either — the persist inputs (profile snapshot, gravity readings) have
      // been overwritten by the newer capture and would misattribute it.
      console.warn('[useSwingCapture] stale capture failure ignored', { reason, generation });
      return;
    }

    // This (current) capture failed before persist → registerSwingId never runs,
    // so clear the watch in-flight seq here or its late-join IMU batch would be
    // dropped by handleWatchBatch's in-flight skip (G5).
    watch.clearInFlight();

    clearTimers();
    updateCapturePhase('processing');

    swingIdPromiseRef.current = persistFailedSwing(reason, {
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

    if (skipResultNavigation) {
      // Coach/watch mode: the callback contract delivers the RESOLVED id
      // (same as the happy-path branch in tryNavigate), so this branch alone
      // still awaits the stub insert.
      swingIdPromiseRef.current.then((swingId) => {
        // A slow stub insert can resolve after the user has begun another capture
        // (which resets navigatedRef) — never fire for a superseded capture.
        if (generation !== captureGenerationRef.current) return;
        if (navigatedRef.current) return;
        navigatedRef.current = true;
        onSwingPersisted?.(swingId);
      });
      return;
    }

    // Navigate immediately — the no-swing screen reads only `reason`, and the
    // stub insert (still running above) is not allowed to strand the failure
    // screen behind a hung network call.
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    router.push({
      pathname: '/analysis/no-swing',
      params: { reason },
    } as Href);
  }

  async function finalizeCapture(origin: StopOrigin, generation?: number) {
    // Only a live 'capturing' phase for the CURRENT capture may finalize: a
    // late window timer (e.g. armed before a blur ended the recording
    // natively, so processRecordedVideo already moved the phase on) or a
    // superseded generation must not re-enter the stop path.
    if (generation != null && generation !== captureGenerationRef.current) return;
    if (capturePhaseRef.current !== 'capturing') return;
    if (isFinalizingRef.current) return;
    isFinalizingRef.current = true;
    const fallbackGeneration = captureGenerationRef.current;

    stopOriginRef.current = origin;
    // A manual stop below VALID_MIN_MS can only be a fragment (no classifiable
    // swing fits in it) — discard the clip instead of analyzing it. Elapsed
    // wall-clock since startRecording slightly overestimates clip length
    // (camera start latency), which only errs toward analyzing, never toward
    // discarding a keepable clip. Window-timer stops always analyze.
    const startedAt = recordingStartedAtRef.current;
    discardRequestedRef.current =
      origin === 'manual' && startedAt != null && Date.now() - startedAt < VALID_MIN_MS;

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
      // A fallback armed for a superseded capture must not fail the current one.
      if (fallbackGeneration !== captureGenerationRef.current) return;
      console.log('[KPI] stop-fallback-fired', Date.now());
      if (discardRequestedRef.current) {
        // Sub-minimum manual stop: the fragment is discarded wholesale — even
        // the never-finished fallback persists nothing. Just return to idle.
        discardRequestedRef.current = false;
        updateCapturePhase('idle');
        return;
      }
      handleCaptureFailure('recording-stop-fallback', undefined, {
        generation: fallbackGeneration,
      });
    }, 1500);
  }

  function beginRecording(opts?: { origin?: 'watch' | 'phone' }) {
    // Every entry path starts with a clean timer slate. The phone entries
    // (startInstantCapture/startCountdownCapture) already clear before calling;
    // this covers the watch auto-start path, which previously could inherit a
    // still-armed capture-window timer from a prior non-finalized recording and
    // fire finalizeCapture mid-capture.
    clearTimers();

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

    // Mint THIS capture's generation. Everything armed below (window timer,
    // recording callbacks, pipeline context) carries it and no-ops once a
    // newer capture has minted a higher one.
    const generation = ++captureGenerationRef.current;

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
    stopOriginRef.current = null;
    discardRequestedRef.current = false;
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
    // Built at button-press: refs as refs (pipeline reads .current at use time);
    // watch/targetFps by value — the same closure capture the inline callback had.
    const processingCtx: CaptureProcessingContext = {
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
      // Bind the failure route to THIS capture's generation; the pipeline adds
      // its video entry (by value) as the third argument.
      handleCaptureFailure: (reason, rtmw, videoEntry) =>
        handleCaptureFailure(reason, rtmw, { generation, videoEntry }),
      tryNavigate,
    };
    cameraRef.current?.startRecording({
      videoCodec: 'h265',
      // Direct synchronous invocation — deferring (microtask/timeout) would widen
      // the window where a kill strands the video before its durable outbox copy.
      onRecordingFinished: (video) => { void processRecordedVideo(video, processingCtx); },
      onRecordingError: (e) => {
        console.error('[HoneySwing] REC ERR:', e);
        handleCaptureFailure('recording-error', undefined, { generation });
      },
    });

    recordingStartedAtRef.current = Date.now();
    updateCapturePhase('capturing');
    goPlayer.play();

    captureTimeoutRef.current = setTimeout(() => {
      finalizeCapture('window_timer', generation).catch(err => console.error('[finalizeCapture] timeout error:', err));
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
        return true; // accepted → the hook adopts this seq as in-flight
      }
      console.log('[useSwingCapture] watch started (no auto-start)', {
        preArmed: preArmedRef.current,
        fresh,
        phase: capturePhaseRef.current,
        seq: started.seq,
      });
      return false; // refused → hook leaves inFlightSeq unset so the batch drains
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
