import { useRef, useState } from 'react';
import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Camera } from 'react-native-vision-camera';
import type { Router, Href } from 'expo-router';
import type { AudioPlayer } from 'expo-audio';
import type { PoseSequence } from '../packages/pose/PoseTypes';
import {
  clearCurrentSwingAnalysis,
  clearCurrentSwingMotion,
  setCurrentSwingAnalysis,
  setCurrentSwingMotion,
  setCurrentSwingVideoUri,
} from './swingMotionStore';
import { analyzePoseSequence } from '../packages/domain/swing/analysisPipeline';
import { persistSwing } from './persistSwing';
import { uploadSwingVideo } from './uploadSwingVideo';
import { classifyCapture } from './captureValidity';
import { getActiveProfileHandedness } from './handedness';
import type { CameraGuidanceColor } from './cameraGuidance';
import type { GravityReading } from '../packages/domain/swing/tiltCorrection';
import { classifyGripFrames, releaseGripBuffer } from '../modules/vision-camera-pose/src';
import { resetCaptureFrameStats, getCaptureFrameStats } from './usePoseFrameHandler';
import { extractPoseFromVideo } from './extractPoseFromVideo';
import { persistPoseFull } from './persistPoseFull';
import { CAPTURE_FPS, CAPTURE_HEIGHT, CAPTURE_WIDTH, ANALYZER_DECIMATION } from './cameraFormat';

// ─── Constants ──────────────────────────────────────────────────────────────

const CAPTURE_WINDOW_MS = 4000;

// ─── Types ──────────────────────────────────────────────────────────────────

export type CapturePhase = 'idle' | 'countdown' | 'capturing' | 'processing' | 'complete' | 'error' | 'weak';

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
  actualFpsRef?: React.MutableRefObject<number>;
  targetFps?: number;
  onSwingPersisted?: (swingId: string | null) => void;
  skipResultNavigation?: boolean;
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
  actualFpsRef,
  targetFps,
  onSwingPersisted,
  skipResultNavigation = false,
}: UseSwingCaptureOptions) {
  const [capturePhase, setCapturePhase] = useState<CapturePhase>('idle');
  const [countdown, setCountdown] = useState<number | null>(null);

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
  const recordingStopFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    const blockReason =
      capturePhaseRef.current !== 'complete' ? 'phase' :
      !analysisReadyRef.current ? 'analysis' :
      videoUriRef.current === 'pending' ? 'video' :
      navigatedRef.current ? 'navigated' :
      null;

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

  function handleCaptureFailure(reason: string) {
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

    clearCurrentSwingMotion();
    clearCurrentSwingAnalysis();
    clearTimers();
    updateCapturePhase('error');
    captureTimeoutRef.current = setTimeout(() => updateCapturePhase('idle'), 2000);
  }

  async function finalizeCapture() {
    if (isFinalizingRef.current) return;
    isFinalizingRef.current = true;

    clearTimers();
    stopTiltCapture();
    gravityReadingsRef.current = getTiltReadings();
    isLeftHandedRef.current = await getActiveProfileHandedness();
    cameraRef.current?.stopRecording();

    // EXTERNAL ASSUMPTION — iOS typical stopRecording finalize latency ~100-500ms;
    // 1500ms gives ~3x headroom. Not measured.
    recordingStopFallbackTimerRef.current = setTimeout(() => {
      handleCaptureFailure('recording-stop-fallback');
    }, 1500);
  }

  function beginRecording() {
    NativeModules.HoneyGripBridge?.resetPoseState?.();
    clearCurrentSwingMotion();
    clearCurrentSwingAnalysis();
    analysisReadyRef.current = false;
    videoUriRef.current = 'pending';
    navigatedRef.current = false;
    isFinalizingRef.current = false;
    resetCaptureFrameStats();
    onBeginRecording();

    guidanceSnapshotRef.current = {
      separation: smoothedSepRef.current,
      color: guidanceColor,
    };

    startTiltCapture();
    cameraRef.current?.startRecording({
      videoCodec: 'h265',
      onRecordingFinished: async (video) => {
        if (recordingStopFallbackTimerRef.current) {
          clearTimeout(recordingStopFallbackTimerRef.current);
          recordingStopFallbackTimerRef.current = null;
        }
        videoUriRef.current = video.path;
        updateCapturePhase('processing');

        let extractionMs = 0;
        let analysisMs = 0;

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
            handleCaptureFailure('no-person');
            return;
          }
          if (result.rtmw.length === 0) {
            handleCaptureFailure('zero-frames');
            return;
          }

          const { poseFrames, rtmw } = result;
          const sequence: PoseSequence = {
            frames: poseFrames,
            source: 'rtmw-l-2d-v1',
            metadata: { fps: CAPTURE_FPS, durationMs: video.duration * 1000 },
          };
          const t0 = Date.now();
          const analysis = analyzePoseSequence(
            sequence,
            isLeftHandedRef.current,
            gravityReadingsRef.current,
          );
          analysisMs = Date.now() - t0;

          if (analysis.swing_debug?.fallback_gate != null) {
            handleCaptureFailure('no-swing');
            return;
          }

          console.log('[HoneySwing] extractionMs', extractionMs, 'analysisMs', analysisMs);

          // Grip estimation — preserves the previous contract for persistSwing's nativeGripResult.
          let nativeGripResult: Record<string, unknown>[] | null = null;
          try {
            const addressPhase = analysis.phases?.find((p) => p.phase === 'address');
            if (addressPhase && addressPhase.index < poseFrames.length) {
              const frame = poseFrames[addressPhase.index];
              const leadWrist = isLeftHandedRef.current ? frame.joints.rightWrist : frame.joints.leftWrist;
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

          setCurrentSwingMotion({ frames: poseFrames, recordedAt: Date.now(), source: 'live-camera' });
          setCurrentSwingAnalysis(analysis);
          updateCapturePhase('complete');

          const classification = classifyCapture(poseFrames);
          const captureFrameStats = getCaptureFrameStats();
          const actualFps = actualFpsRef?.current ?? 0;
          swingIdPromiseRef.current = persistSwing(
            poseFrames,
            analysis,
            classification,
            {
              camera_angle_at_start: guidanceSnapshotRef.current.separation,
              camera_guidance_color: guidanceSnapshotRef.current.color,
            },
            nativeGripResult,
            captureFrameStats,
            actualFps,
            targetFps ?? null,
            gravityReadingsRef.current,
          ).then((swingId) => {
            if (swingId) {
              console.log('[persistSwing] saved', { swingId, frames: poseFrames.length });
            } else {
              console.warn('[persistSwing] skipped (no user)', { frames: poseFrames.length });
            }
            return swingId;
          }).catch((err) => {
            console.error('[persistSwing] FAILED', {
              error: err.message,
              frames: poseFrames.length,
              classification: classification?.validity ?? 'unknown',
            });
            return null;
          });

          // Fire-and-forget uploads off the resolved swingId. MUST run after
          // swingIdPromiseRef is assigned (above); the today's :303 chain at the
          // old source position would see null and no-op.
          swingIdPromiseRef.current?.then((swingId) => {
            if (!swingId) return;
            uploadSwingVideo(swingId, video.path)
              .catch((e) => console.warn('[HoneySwing] uploadSwingVideo failed', e));
            persistPoseFull(swingId, rtmw)
              .catch((e) => console.warn('[HoneySwing] persistPoseFull failed', e));
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
          handleCaptureFailure('extract-or-analyze-threw');
        }
      },
      onRecordingError: (e) => {
        console.error('[HoneySwing] REC ERR:', e);
        handleCaptureFailure('recording-error');
      },
    });

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

  return {
    capturePhase,
    countdown,
    startCountdownCapture,
    startInstantCapture,
    finalizeCapture,
    updateCapturePhase,
    capturePhaseRef,
    clearTimers,
  };
}
