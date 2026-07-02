import { useEffect, useRef, useState } from 'react';
import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
import { resetCaptureFrameStats, getCaptureFrameStats } from './usePoseFrameHandler';
import { processRecordedVideo, type CaptureProcessingContext } from './captureProcessing';
import {
  computeNavigationBlockReason,
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
      watch,
      targetFps,
      updateCapturePhase,
      handleCaptureFailure,
      tryNavigate,
    };
    cameraRef.current?.startRecording({
      videoCodec: 'h265',
      // Direct synchronous invocation — deferring (microtask/timeout) would widen
      // the window where a kill strands the video before its durable outbox copy.
      onRecordingFinished: (video) => { void processRecordedVideo(video, processingCtx); },
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
