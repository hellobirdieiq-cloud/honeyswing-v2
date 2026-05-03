import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, useWindowDimensions } from 'react-native';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { useRouter, type Href } from 'expo-router';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedProps, useSharedValue } from 'react-native-reanimated';
import { Camera, useCameraDevice, useCameraDevices, useCameraFormat, useFrameProcessor } from 'react-native-vision-camera';
import { honeyPoseDetect } from '../../modules/vision-camera-pose/src';
import {
  clearCurrentSwingAnalysis,
  clearCurrentSwingMotion,
  loadFocus,
  type FocusData,
} from '../../lib/swingMotionStore';
import SkeletonOverlay, { type Landmark } from '../../components/SkeletonOverlay';
import CameraGuidance from '../../components/CameraGuidance';
import type { CameraGuidanceColor } from '../../lib/cameraGuidance';
import { checkSwingLimit } from '../../lib/swingLimit';
import { useTiltCapture } from '../../lib/useTiltCapture';
import { useSwingCapture } from '../../lib/useSwingCapture';
import { usePoseFrameHandler } from '../../lib/usePoseFrameHandler';
import { GOLD } from '../../lib/colors';
import { styles } from './recordStyles';

const ReanimatedCamera = Animated.createAnimatedComponent(Camera);

/** Isolated component — landmark state updates only re-render this subtree, not the parent. */
const LiveSkeleton = React.memo(function LiveSkeleton({
  updateRef,
  width,
  height,
  frameAspect,
}: {
  updateRef: React.MutableRefObject<((lms: Landmark[]) => void) | null>;
  width: number;
  height: number;
  frameAspect: number;
}) {
  const [landmarks, setLandmarks] = useState<Landmark[]>([]);
  updateRef.current = setLandmarks;
  return <SkeletonOverlay landmarks={landmarks} width={width} height={height} frameAspect={frameAspect} />;
});

/** Session counter for framing tips — show for first 3 record-screen visits only. */
const TIP_MAX_SESSIONS = 3;
let tipSessionsSeen = 0;

export default function RecordTab() {
  const router = useRouter();
  const goPlayer = useAudioPlayer(require('../../assets/go.wav'));

  const { width: screenW } = useWindowDimensions();
  const [containerH, setContainerH] = useState(0);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [showCameraHint, setShowCameraHint] = useState(false);
  const [showTips, setShowTips] = useState(() => tipSessionsSeen < TIP_MAX_SESSIONS);
  const [focus, setFocus] = useState<FocusData | null>(null);
  const skeletonUpdateRef = useRef<((lms: Landmark[]) => void) | null>(null);
  const frameAspectRef = useRef(0);
  const [frameAspectState, setFrameAspectState] = useState(0);

  const cameraRef = useRef<Camera>(null);
  const { startCapture, stopCapture, getReadings } = useTiltCapture();

  // Camera guidance (Task 13) — EMA-smoothed shoulder separation
  const smoothedSepRef = useRef<number | null>(null);
  const [guidanceColor, setGuidanceColor] = useState<CameraGuidanceColor | null>(null);
  const [guidanceLabel, setGuidanceLabel] = useState<string | null>(null);

  // Camera device/format selection
  const allDevices = useCameraDevices();
  const ultraWide = allDevices.find(d => d.name === 'Back Ultra Wide Camera');
  const fallback = useCameraDevice('back');
  const device = ultraWide || fallback;

  const format = useCameraFormat(device, [
    { fps: 120, videoResolution: { width: 1280, height: 720 } },
  ]);
  const targetFps = Math.min(format?.maxFps ?? 30, 120);
  const skipInterval = 1;

  const zoom = useSharedValue(device?.minZoom ?? 1);
  const zoomAtPinchStart = useSharedValue(device?.minZoom ?? 1);
  const frameSkipCounter = useSharedValue(0);

  // ─── Swing capture hook ─────────────────────────────────────────────────────

  const {
    capturePhase,
    countdown,
    startCountdownCapture,
    startInstantCapture,
    finalizeCapture,
    updateCapturePhase,
    motionFramesRef,
    capturePhaseRef,
    clearTimers,
    bufferPoseFrame,
  } = useSwingCapture({
    cameraRef,
    router,
    goPlayer,
    startTiltCapture: startCapture,
    stopTiltCapture: stopCapture,
    getTiltReadings: getReadings,
    smoothedSepRef,
    guidanceColor,
    hasPermission,
    hasDevice: !!device,
    cameraReady,
    onBeginRecording: () => { frameSkipCounter.value = 0; },
  });

  // ─── Pose frame handler ──────────────────────────────────────────────────────

  const { appendPoseFrame } = usePoseFrameHandler({
    skeletonUpdateRef,
    capturePhaseRef,
    bufferPoseFrame,
    smoothedSepRef,
    frameAspectRef,
    setFrameAspectState,
    setGuidanceColor,
    setGuidanceLabel,
  });

  // ─── Frame processor ─────────────────────────────────────────────────────────

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
      frameSkipCounter.value = frameSkipCounter.value + 1;
      if (frameSkipCounter.value % skipInterval !== 0) return;

      const landmarks = honeyPoseDetect(frame);
      const detected = Array.isArray(landmarks) && landmarks.length > 0;

      if (detected) {
        const aspect = frame.height > 0 && frame.width > 0 ? frame.height / frame.width : 0;
        appendPoseFrame(landmarks, frame.timestamp, frame.width, frame.height, aspect);
      }
    },
    [appendPoseFrame, skipInterval, frameSkipCounter]
  );

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  // Reset stale capture phases on focus return and count screen visits for tips
  useFocusEffect(
    useCallback(() => {
      const phase = capturePhaseRef.current;
      if (phase === 'complete' || phase === 'weak' || phase === 'error') {
        updateCapturePhase('idle');
      }

      checkSwingLimit().then((status) => {
        if (!status.allowed) {
          router.replace('/paywall' as Href);
        }
      }).catch((err) => console.error('[HoneySwing]', err));

      loadFocus().then((nextFocus) => {
        setFocus(nextFocus);
        if (!nextFocus) {
          tipSessionsSeen += 1;
          setShowTips(tipSessionsSeen <= TIP_MAX_SESSIONS);
        }
      }).catch((err) => console.error('[HoneySwing]', err));
    }, [])
  );

  useEffect(() => {
    let mounted = true;

    motionFramesRef.current = [];
    clearCurrentSwingMotion();
    clearCurrentSwingAnalysis();

    async function setupScreen() {
      const limitStatus = await checkSwingLimit();
      if (!mounted) return;
      if (!limitStatus.allowed) {
        router.replace('/paywall' as Href);
        return;
      }

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
        const granted = status === 'granted';
        setHasPermission(granted);
        if (granted) {
          setIsCameraActive(false);
          setTimeout(() => { if (mounted) setIsCameraActive(true); }, 150);
        }
      }
    }

    setupScreen();

    return () => {
      mounted = false;
      clearTimers();
    };
  }, []);

  // Fallback banner: show after 5s if camera hasn't initialized
  useEffect(() => {
    if (hasPermission && !cameraReady) {
      const timer = setTimeout(() => setShowCameraHint(true), 5000);
      return () => clearTimeout(timer);
    }
    if (cameraReady) setShowCameraHint(false);
  }, [hasPermission, cameraReady]);

  // ─── Derived state ──────────────────────────────────────────────────────────

  const showCamera = hasPermission === true && device != null;
  const isCountdown = capturePhase === 'countdown';
  const isCapturing = capturePhase === 'capturing';
  const isWeak = capturePhase === 'weak';
  const isError = capturePhase === 'error';
  const isInitializing = hasPermission === null || (showCamera && !cameraReady);
  const canRecord = cameraReady && !isCapturing && !isWeak && !isCountdown && !isError;

  return (
    <GestureHandlerRootView
      style={styles.container}
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        if (h !== containerH) setContainerH(h);
      }}
    >
      {showCamera ? (
        <>
          <ReanimatedCamera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            device={device}
            isActive={isCameraActive}
            animatedProps={animatedCameraProps}
            format={format}
            fps={targetFps}
            photo={false}
            video={true}
            audio={false}
            frameProcessor={frameProcessor}
            onInitialized={() => setCameraReady(true)}
          />
          <LiveSkeleton
            updateRef={skeletonUpdateRef}
            width={screenW}
            height={containerH}
            frameAspect={frameAspectState}
          />
          {capturePhase === 'idle' && cameraReady && (
            <CameraGuidance color={guidanceColor} label={guidanceLabel} />
          )}
          <GestureDetector gesture={pinchGesture}>
            <Animated.View style={StyleSheet.absoluteFill} />
          </GestureDetector>
          {showCameraHint && (
            <View style={styles.cameraHintBanner} pointerEvents="none">
              <Text style={styles.cameraHintText}>Camera not loading? Close and reopen the app.</Text>
            </View>
          )}
        </>
      ) : (
        <View style={styles.placeholder}>
          <ActivityIndicator size="large" color={GOLD} />
          <Text style={styles.placeholderText}>
            {hasPermission === false ? 'Camera permission denied' : 'Starting camera...'}
          </Text>
        </View>
      )}

      {/* Today's Focus card or framing tips — both gated on idle + cameraReady */}
      {capturePhase === 'idle' && cameraReady && (
        focus ? (
          <View style={styles.focusCard}>
            <Text style={styles.focusTitle}>Today&apos;s Focus</Text>
            <Text style={styles.focusLabel}>{focus.label}</Text>
            <Text style={styles.focusCue}>{focus.cue}</Text>
          </View>
        ) : (showTips ? (
          <TouchableOpacity
            style={styles.tipsOverlay}
            onPress={() => setShowTips(false)}
            activeOpacity={0.8}
          >
            <Text style={styles.tipText}>Step back so your full body is visible</Text>
            <Text style={styles.tipTextSecondary}>Face the camera</Text>
            <Text style={styles.tipDismiss}>Tap to dismiss</Text>
          </TouchableOpacity>
        ) : null)
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
            <ActivityIndicator size="small" color={GOLD} />
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
              Couldn&apos;t see you clearly
            </Text>
            <Text style={styles.weakCaptureHint}>
              Step back so your full body is in frame
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
            <Text style={styles.errorText}>Didn&apos;t catch that — give it another go</Text>
          </View>
        ) : (
          <View style={styles.recordButtonRow}>
            <TouchableOpacity
              style={[styles.countdownButton, !canRecord && styles.recordButtonDisabled]}
              onPress={() => { setShowTips(false); startCountdownCapture(); }}
              disabled={!canRecord}
              activeOpacity={0.7}
            >
              <Text style={styles.countdownButtonText}>3-2-1</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.recordButton, !canRecord && styles.recordButtonDisabled]}
              onPress={() => { setShowTips(false); startInstantCapture(); }}
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
