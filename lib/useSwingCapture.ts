import { useRef, useState } from 'react';
import { Camera } from 'react-native-vision-camera';
import type { Router, Href } from 'expo-router';
import type { AudioPlayer } from 'expo-audio';
import type { PoseFrame, PoseSequence } from '../packages/pose/PoseTypes';
import {
  clearCurrentSwingAnalysis,
  clearCurrentSwingMotion,
  setCurrentSwingAnalysis,
  setCurrentSwingMotion,
  setCurrentSwingVideoUri,
} from './swingMotionStore';
import {
  analyzePoseSequence,
} from '../packages/domain/swing/analysisPipeline';
import { persistSwing } from './persistSwing';
import { uploadSwingVideo } from './uploadSwingVideo';
import { classifyCapture, isGoodFrame } from './captureValidity';
import { getIsLeftHanded } from './handedness';
import type { CameraGuidanceColor } from './cameraGuidance';
import type { GravityReading } from '../packages/domain/swing/tiltCorrection';
import { classifyGripFrames, releaseGripBuffer } from '../modules/vision-camera-pose/src';

// ─── Constants ──────────────────────────────────────────────────────────────

export const MAX_BUFFERED_POSE_FRAMES = 180;
const MIN_FRAMES_FOR_ANALYSIS = 6;
const CAPTURE_WINDOW_MS = 4000;

const MIN_GOOD_FRAMES = 4;

// ─── Types ──────────────────────────────────────────────────────────────────

export type CapturePhase = 'idle' | 'countdown' | 'capturing' | 'complete' | 'error' | 'weak';

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
}: UseSwingCaptureOptions) {
  const [capturePhase, setCapturePhase] = useState<CapturePhase>('idle');
  const [countdown, setCountdown] = useState<number | null>(null);

  const motionFramesRef = useRef<PoseFrame[]>([]);
  const capturePhaseRef = useRef<CapturePhase>('idle');
  const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisReadyRef = useRef(false);
  const videoUriRef = useRef<'pending' | null | string>('pending');
  const navigatedRef = useRef(false);
  const safetyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swingIdPromiseRef = useRef<Promise<string | null> | null>(null);
  const isFinalizingRef = useRef(false);
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
    if (safetyTimeoutRef.current) {
      clearTimeout(safetyTimeoutRef.current);
      safetyTimeoutRef.current = null;
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
    if (safetyTimeoutRef.current) {
      clearTimeout(safetyTimeoutRef.current);
      safetyTimeoutRef.current = null;
    }
    setCurrentSwingVideoUri(videoUriRef.current);

    let swingId: string | null = null;
    try {
      swingId = await (swingIdPromiseRef.current ?? Promise.resolve(null));
    } catch {
      // persist failed — navigate without swingId
    }
    router.push({ pathname: '/analysis/result', params: swingId ? { swingId } : {} } as Href);
  }

  async function finalizeCapture() {
    if (isFinalizingRef.current) return;
    isFinalizingRef.current = true;

    clearTimers();
    stopTiltCapture();
    const gravityReadings = getTiltReadings();
    cameraRef.current?.stopRecording();

    const frames = [...motionFramesRef.current];

    if (frames.length < MIN_FRAMES_FOR_ANALYSIS) {
      clearCurrentSwingMotion();
      clearCurrentSwingAnalysis();
      updateCapturePhase('error');
      captureTimeoutRef.current = setTimeout(() => updateCapturePhase('idle'), 2000);
      return;
    }

    const goodFrameCount = frames.filter(isGoodFrame).length;
    if (goodFrameCount < MIN_GOOD_FRAMES) {
      clearCurrentSwingMotion();
      clearCurrentSwingAnalysis();
      updateCapturePhase('weak');
      return;
    }

    const sequence: PoseSequence = {
      frames,
      source: 'live-camera',
      metadata: {
        durationMs:
          frames.length > 1 ? frames[frames.length - 1].timestampMs - frames[0].timestampMs : 0,
      },
    };

    const isLeftHanded = await getIsLeftHanded();
    const analysis = analyzePoseSequence(sequence, isLeftHanded, gravityReadings);

    // Grip estimation — awaited with 500ms timeout, result passed to persistSwing
    let nativeGripResult: Record<string, unknown>[] | null = null;
    try {
      const addressPhase = analysis.phases?.find(p => p.phase === 'address');
      if (addressPhase && addressPhase.index < frames.length) {
        const frame = frames[addressPhase.index];
        const leadWrist = isLeftHanded ? frame.joints.rightWrist : frame.joints.leftWrist;
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
      frames,
      recordedAt: Date.now(),
      source: 'live-camera',
    });
    setCurrentSwingAnalysis(analysis);

    updateCapturePhase('complete');

    const classification = classifyCapture(frames);
    swingIdPromiseRef.current = persistSwing(frames, analysis, classification, {
      camera_angle_at_start: guidanceSnapshotRef.current.separation,
      camera_guidance_color: guidanceSnapshotRef.current.color,
    }, nativeGripResult).then((swingId) => {
      if (swingId) {
        console.log('[persistSwing] ✅ saved', { swingId, frames: frames.length });
      } else {
        console.warn('[persistSwing] ⚠️ skipped (no user)', { frames: frames.length });
      }
      return swingId;
    }).catch((err) => {
      console.error('[persistSwing] ❌ FAILED', {
        error: err.message,
        frames: frames.length,
        hasUser: true,
        classification: classification?.validity ?? 'unknown',
      });
      return null;
    });

    analysisReadyRef.current = true;
    safetyTimeoutRef.current = setTimeout(() => {
      videoUriRef.current = null;
      tryNavigate();
    }, 3000);
    tryNavigate();
  }

  function beginRecording() {
    clearCurrentSwingMotion();
    clearCurrentSwingAnalysis();
    motionFramesRef.current = [];
    analysisReadyRef.current = false;
    videoUriRef.current = 'pending';
    navigatedRef.current = false;
    isFinalizingRef.current = false;
    onBeginRecording();

    guidanceSnapshotRef.current = {
      separation: smoothedSepRef.current,
      color: guidanceColor,
    };

    startTiltCapture();
    cameraRef.current?.startRecording({
      videoCodec: 'h265',
      onRecordingFinished: (video) => {
        videoUriRef.current = video.path;
        swingIdPromiseRef.current?.then((swingId) => {
          if (swingId) uploadSwingVideo(swingId, video.path).catch((err) => console.error('[HoneySwing]', err));
        }).catch((err) => console.error('[HoneySwing]', err));
        tryNavigate();
      },
      onRecordingError: (e) => console.error('REC ERR:', e),
    });

    updateCapturePhase('capturing');
    goPlayer.play();

    captureTimeoutRef.current = setTimeout(() => {
      finalizeCapture();
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
    motionFramesRef,
    capturePhaseRef,
    clearTimers,
  };
}
