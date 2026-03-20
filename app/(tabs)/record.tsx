import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, useWindowDimensions } from 'react-native';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { useRouter } from 'expo-router';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedProps, useSharedValue } from 'react-native-reanimated';
import { Camera, useCameraDevice, useCameraDevices, useFrameProcessor } from 'react-native-vision-camera';

const ReanimatedCamera = Animated.createAnimatedComponent(Camera);
import { Worklets } from 'react-native-worklets-core';
import { honeyPoseDetect } from '../../modules/vision-camera-pose/src';
import type { PoseFrame, PoseSequence } from '../../packages/pose/PoseTypes';
import { MLKitProvider } from '../../packages/pose/providers/MLKitProvider';
import {
  clearCurrentSwingAnalysis,
  clearCurrentSwingMotion,
  setCurrentSwingAnalysis,
  setCurrentSwingMotion,
} from '../../lib/swingMotionStore';
import {
  analyzePoseSequence,
  type AnalysisResult,
} from '../../packages/domain/swing/analysisPipeline';
import SkeletonOverlay, { type Landmark } from '../../components/SkeletonOverlay';

/** Isolated component — landmark state updates only re-render this subtree, not the parent. */
const LiveSkeleton = React.memo(function LiveSkeleton({
  updateRef,
  width,
  height,
}: {
  updateRef: React.MutableRefObject<((lms: Landmark[]) => void) | null>;
  width: number;
  height: number;
}) {
  const [landmarks, setLandmarks] = useState<Landmark[]>([]);
  updateRef.current = setLandmarks;
  return <SkeletonOverlay landmarks={landmarks} width={width} height={height} />;
});

const MAX_BUFFERED_POSE_FRAMES = 180;
const MIN_FRAMES_FOR_ANALYSIS = 6;
const CAPTURE_WINDOW_MS = 4000;

/** Quality gate: a frame is "good" if at least this many key joints have confidence above threshold */
const JOINT_CONFIDENCE_THRESHOLD = 0.3;
const KEY_JOINTS: Array<import('../../packages/pose/PoseTypes').JointName> = [
  'leftShoulder', 'rightShoulder', 'leftHip', 'rightHip',
  'leftElbow', 'rightElbow', 'leftKnee', 'rightKnee',
];
const MIN_KEY_JOINTS_PER_FRAME = 4;
const MIN_GOOD_FRAMES = 4;

type CapturePhase = 'idle' | 'countdown' | 'capturing' | 'complete' | 'error' | 'weak';

export default function RecordTab() {
  const router = useRouter();
  const goPlayer = useAudioPlayer(require('../../assets/go.wav'));

  const { width: screenW, height: screenH } = useWindowDimensions();

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturePhase, setCapturePhase] = useState<CapturePhase>('idle');
  const [showTips, setShowTips] = useState(true);
  const skeletonUpdateRef = useRef<((lms: Landmark[]) => void) | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  const motionFramesRef = useRef<PoseFrame[]>([]);
  const providerRef = useRef(new MLKitProvider());
  const capturePhaseRef = useRef<CapturePhase>('idle');
  const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }

  const updateLandmarks = useCallback((lms: Landmark[]) => {
    skeletonUpdateRef.current?.(lms);
  }, []);

  const appendPoseFrame = Worklets.createRunOnJS(
    async (
      landmarks: unknown,
      timestampMs: number,
      frameWidth: number,
      frameHeight: number
    ) => {
      // Throttle logging to once every 60 frames
      frameCountRef.current += 1;
      if (frameCountRef.current % 60 === 1) {
        console.log('[HoneySwing] FRAME PROCESSOR frame #' + frameCountRef.current + ' ' + frameWidth + 'x' + frameHeight + ' landmarks=' + (Array.isArray(landmarks) ? landmarks.length : 0));
      }

      // Surface native-side diagnostics
      if (Array.isArray(landmarks) && landmarks.length === 1 && (landmarks[0] as any)?._diagnostic) {
        if (frameCountRef.current % 60 === 1) {
          console.warn('[HoneySwing] NATIVE DIAGNOSTIC: ' + (landmarks[0] as any)._diagnostic);
        }
        return;
      }

      // Update skeleton overlay with raw landmarks every frame
      if (Array.isArray(landmarks)) {
        updateLandmarks(landmarks as Landmark[]);
      }

      if (capturePhaseRef.current !== 'capturing') {
        return;
      }

      const poseFrame = await providerRef.current.detectFromFrame?.({
        frame: landmarks,
        timestampMs,
        frameWidth,
        frameHeight,
      });

      if (!poseFrame) return;

      const nextFrames = [...motionFramesRef.current, poseFrame].slice(-MAX_BUFFERED_POSE_FRAMES);
      motionFramesRef.current = nextFrames;
    }
  );

  function isGoodFrame(frame: PoseFrame): boolean {
    let confidentJoints = 0;
    for (const jointName of KEY_JOINTS) {
      const joint = frame.joints[jointName];
      if (joint && (joint.confidence ?? 0) >= JOINT_CONFIDENCE_THRESHOLD) {
        confidentJoints++;
      }
    }
    return confidentJoints >= MIN_KEY_JOINTS_PER_FRAME;
  }

  function finalizeCapture() {
    clearTimers();

    const frames = [...motionFramesRef.current];

    if (frames.length < MIN_FRAMES_FOR_ANALYSIS) {
      clearCurrentSwingMotion();
      clearCurrentSwingAnalysis();
      updateCapturePhase('error');
      setTimeout(() => updateCapturePhase('idle'), 2000);
      return;
    }

    // Quality gate: check that enough frames have reliable pose data
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

    const analysis = analyzePoseSequence(sequence);

    setCurrentSwingMotion({
      frames,
      recordedAt: Date.now(),
      source: 'live-camera',
    });
    setCurrentSwingAnalysis(analysis);
    updateCapturePhase('complete');

    router.push('/analysis/result');
  }

  function beginRecording() {
    clearCurrentSwingMotion();
    clearCurrentSwingAnalysis();
    motionFramesRef.current = [];

    updateCapturePhase('capturing');
    goPlayer.play();

    captureTimeoutRef.current = setTimeout(() => {
      finalizeCapture();
    }, CAPTURE_WINDOW_MS);
  }

  function startCountdownCapture() {
    if (!hasPermission || !device || !cameraReady) return;

    clearTimers();
    setShowTips(false);
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
    if (!hasPermission || !device || !cameraReady) return;

    clearTimers();
    setShowTips(false);
    beginRecording();
  }

  useEffect(() => {
    let mounted = true;

    motionFramesRef.current = [];
    clearCurrentSwingMotion();
    clearCurrentSwingAnalysis();

    async function setupScreen() {
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: 'doNotMix',
      });

      let status = await Camera.getCameraPermissionStatus();
      
      if (status === 'not-determined') {
        status = await Camera.requestCameraPermission();
      }
      
      if (mounted) {
        setHasPermission(status === 'granted');
      }
    }

    setupScreen();

    return () => {
      mounted = false;
      clearTimers();
    };
  }, []);

  const allDevices = useCameraDevices();
  const ultraWide = allDevices.find(d => d.name === 'Back Ultra Wide Camera');
  const fallback = useCameraDevice('back');
  const device = ultraWide || fallback;

  const zoom = useSharedValue(device?.minZoom ?? 1);
  const zoomAtPinchStart = useSharedValue(device?.minZoom ?? 1);
  const frameCountRef = useRef(0);

  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      zoomAtPinchStart.value = zoom.value;
    })
    .onUpdate((e) => {
      const min = device?.minZoom ?? 1;
      const max = device?.maxZoom ?? 1;
      zoom.value = Math.min(max, Math.max(min, zoomAtPinchStart.value * e.scale));
    });

  const animatedCameraProps = useAnimatedProps(() => ({
    zoom: zoom.value,
  }));

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';

      const landmarks = honeyPoseDetect(frame);

      if (Array.isArray(landmarks) && landmarks.length > 0) {
        appendPoseFrame(landmarks, frame.timestamp, frame.width, frame.height);
      }
    },
    [appendPoseFrame]
  );

  const showCamera = hasPermission === true && device != null;
  const isCountdown = capturePhase === 'countdown';
  const isCapturing = capturePhase === 'capturing';
  const isWeak = capturePhase === 'weak';
  const isError = capturePhase === 'error';
  const isInitializing = hasPermission === null || (showCamera && !cameraReady);
  const canRecord = cameraReady && !isCapturing && !isWeak && !isCountdown && !isError;

  return (
    <GestureHandlerRootView style={styles.container}>
      {showCamera ? (
        <>
          <ReanimatedCamera
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            device={device}
            isActive={true}
            animatedProps={animatedCameraProps}
            photo={false}
            video={true}
            audio={false}
            frameProcessor={frameProcessor}
            onInitialized={() => setCameraReady(true)}
          />
          <LiveSkeleton
            updateRef={skeletonUpdateRef}
            width={screenW}
            height={screenH}
          />
          <GestureDetector gesture={pinchGesture}>
            <Animated.View style={StyleSheet.absoluteFill} />
          </GestureDetector>
        </>
      ) : (
        <View style={styles.placeholder}>
          <ActivityIndicator size="large" color="#F5A623" />
          <Text style={styles.placeholderText}>
            {hasPermission === false ? 'Camera permission denied' : 'Starting camera...'}
          </Text>
        </View>
      )}

      {/* Framing tips */}
      {showTips && capturePhase === 'idle' && cameraReady && (
        <TouchableOpacity
          style={styles.tipsOverlay}
          onPress={() => setShowTips(false)}
          activeOpacity={0.8}
        >
          <Text style={styles.tipText}>Step back so full body is visible</Text>
          <Text style={styles.tipText}>Hold phone steady</Text>
          <Text style={styles.tipDismiss}>Tap to dismiss</Text>
        </TouchableOpacity>
      )}

      {/* Countdown overlay */}
      {isCountdown && countdown != null && (
        <View style={styles.countdownOverlay} pointerEvents="none">
          <Text style={styles.countdownText}>{countdown}</Text>
        </View>
      )}

      {/* Overlay */}
      <View style={styles.overlay} pointerEvents="box-none">
        {isInitializing ? (
          <View style={styles.recordingIndicator}>
            <ActivityIndicator size="small" color="#F5A623" />
            <Text style={styles.recordingText}>Preparing camera...</Text>
          </View>
        ) : isCapturing ? (
          <TouchableOpacity
            style={styles.stopButton}
            onPress={finalizeCapture}
            activeOpacity={0.7}
          >
            <View style={styles.stopIcon} />
          </TouchableOpacity>
        ) : isWeak ? (
          <View style={styles.weakCaptureContainer}>
            <Text style={styles.weakCaptureText}>
              Weak capture — not enough body detected
            </Text>
            <Text style={styles.weakCaptureHint}>
              Make sure your full body is visible
            </Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => {
                updateCapturePhase('idle');
              }}
              activeOpacity={0.7}
            >
              <Text style={styles.retryButtonText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        ) : isError ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>No swing detected — try again</Text>
          </View>
        ) : (
          <View style={styles.recordButtonRow}>
            <TouchableOpacity
              style={[styles.recordButton, !canRecord && styles.recordButtonDisabled]}
              onPress={startCountdownCapture}
              disabled={!canRecord}
              activeOpacity={0.7}
            >
              <Text style={styles.recordButtonText}>3-2-1</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.recordButton, !canRecord && styles.recordButtonDisabled]}
              onPress={startInstantCapture}
              disabled={!canRecord}
              activeOpacity={0.7}
            >
              <Text style={styles.recordButtonText}>Record Now</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
  },
  placeholderText: {
    color: '#fff',
    fontSize: 16,
    marginTop: 16,
  },
  tipsOverlay: {
    position: 'absolute',
    top: 80,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  tipText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
    marginBottom: 6,
    textAlign: 'center',
  },
  tipDismiss: {
    color: '#999',
    fontSize: 12,
    marginTop: 6,
  },
  overlay: {
    position: 'absolute',
    bottom: 100,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  recordButtonRow: {
    flexDirection: 'row',
    gap: 16,
  },
  recordButton: {
    backgroundColor: '#F5A623',
    paddingVertical: 16,
    paddingHorizontal: 28,
    borderRadius: 32,
  },
  recordButtonDisabled: {
    opacity: 0.5,
  },
  recordButtonText: {
    color: '#111',
    fontSize: 20,
    fontWeight: '700',
  },
  recordingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 24,
  },
  recordingText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  stopButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: 4,
    borderColor: '#FF3B30',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopIcon: {
    width: 28,
    height: 28,
    borderRadius: 4,
    backgroundColor: '#FF3B30',
  },
  weakCaptureContainer: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingVertical: 20,
    paddingHorizontal: 28,
    borderRadius: 20,
  },
  weakCaptureText: {
    color: '#FFD060',
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  weakCaptureHint: {
    color: '#ccc',
    fontSize: 14,
    marginTop: 6,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 16,
    backgroundColor: '#F5A623',
    paddingVertical: 12,
    paddingHorizontal: 36,
    borderRadius: 24,
  },
  retryButtonText: {
    color: '#111',
    fontSize: 17,
    fontWeight: '700',
  },
  errorContainer: {
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingVertical: 16,
    paddingHorizontal: 28,
    borderRadius: 16,
  },
  errorText: {
    color: '#FF6B6B',
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  countdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countdownText: {
    color: '#fff',
    fontSize: 120,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 12,
  },
});