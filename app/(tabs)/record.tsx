import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, useWindowDimensions, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { useRouter, type Href } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedProps, useSharedValue } from 'react-native-reanimated';
import { Camera, useCameraDevice, useCameraFormat } from 'react-native-vision-camera';
import { CAPTURE_FPS, CAPTURE_WIDTH, CAPTURE_HEIGHT } from '@/lib/cameraFormat';
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
import { clinicSessionActive } from '@/lib/clinic/clinicSessionStore';
import { GOLD } from '../../lib/colors';
import {
  registerShutter,
  clearShutter,
  registerStop,
  clearStop,
  setRecording,
} from '../../lib/shutterStore';
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

  const [captureMode, setCaptureMode] = useState<'instant' | 'countdown'>('instant');
  // Camera device/format selection
  const device = useCameraDevice('back');

  const format = useCameraFormat(device, [
    { fps: CAPTURE_FPS, videoResolution: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT } },
  ]);
  const targetFps = Math.min(format?.maxFps ?? 30, CAPTURE_FPS);
  const skipInterval = 1;

  const loggedDeviceIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!format || !device || loggedDeviceIdRef.current === device.id) return;
    loggedDeviceIdRef.current = device.id;
    console.log('[HoneySwing] resolved format', {
      deviceId: device.id,
      deviceName: device.name,
      maxFps: format.maxFps,
      minFps: format.minFps,
      videoWidth: format.videoWidth,
      videoHeight: format.videoHeight,
      videoResolution:
        format.videoWidth && format.videoHeight
          ? `${format.videoWidth}x${format.videoHeight}`
          : 'unknown',
      targetFps,
    });
  }, [format, device, targetFps]);

  const zoom = useSharedValue(device?.minZoom ?? 1);
  const zoomAtPinchStart = useSharedValue(device?.minZoom ?? 1);

  // ─── Swing capture hook ─────────────────────────────────────────────────────

  const {
    capturePhase,
    countdown,
    startCountdownCapture,
    startInstantCapture,
    finalizeCapture,
    updateCapturePhase,
    capturePhaseRef,
    clearTimers,
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
    onBeginRecording: () => {},
    targetFps,
  });

  // Live refs so the tab-bar-registered shutter/stop closures always re-read the
  // current hook fns (never a stale mount-time capture). See shutter focus-effect below.
  const startInstantRef = useRef(startInstantCapture);
  startInstantRef.current = startInstantCapture;
  const startCountdownRef = useRef(startCountdownCapture);
  startCountdownRef.current = startCountdownCapture;
  const finalizeRef = useRef(finalizeCapture);
  finalizeRef.current = finalizeCapture;
  const captureModeRef = useRef(captureMode);
  captureModeRef.current = captureMode;

  // ─── Pose frame handler ──────────────────────────────────────────────────────

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
      // eslint-disable-next-line react-hooks/exhaustive-deps -- capturePhaseRef is a ref object (stable; .current is intentionally not tracked); updateCapturePhase is defined inline in useSwingCapture and would cause infinite loop if tracked
    }, [router])
  );

  useFocusEffect(
    useCallback(() => {
      setIsCameraActive(true);
      return () => {
        setIsCameraActive(false);
      };
    }, [])
  );

  // Single writer of the tab bar's isRecording boolean — kept in lockstep with the
  // capturePhase source of truth (capturePhase === 'capturing').
  useEffect(() => {
    setRecording(capturePhase === 'capturing');
  }, [capturePhase]);

  // Register the center-button shutter/stop handlers on focus, clear on blur.
  // The closures call the live refs so they re-read current hook fns at fire time.
  useFocusEffect(
    useCallback(() => {
      registerShutter(() => {
        if (capturePhaseRef.current !== 'idle') return;
        setShowTips(false);
        if (captureModeRef.current === 'countdown') startCountdownRef.current();
        else startInstantRef.current();
      });
      registerStop(() => { finalizeRef.current(); });
      return () => {
        clearShutter();
        clearStop();
        setRecording(false);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- closures call refs (.current is live) + stable setShowTips setter; register strictly once per focus
    }, [])
  );

  useEffect(() => {
    let mounted = true;

    if (!clinicSessionActive()) {
      clearCurrentSwingMotion();
      clearCurrentSwingAnalysis();
    }

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clearTimers is defined inline in useSwingCapture and would cause infinite loop if tracked
  }, [router]);

  // Fallback banner: show after 5s if camera hasn't initialized
  useEffect(() => {
    if (hasPermission && !cameraReady) {
      const timer = setTimeout(() => setShowCameraHint(true), 5000);
      return () => clearTimeout(timer);
    }
    if (cameraReady) setShowCameraHint(false);
  }, [hasPermission, cameraReady]);

  // ─── Derived state ──────────────────────────────────────────────────────────

  // TEMP debug: read AsyncStorage capture-stats slots populated by useSwingCapture.
  async function handleDebugStats() {
    try {
      const [failed, weak] = await Promise.all([
        AsyncStorage.getItem('lastFailedCaptureStats'),
        AsyncStorage.getItem('lastWeakCaptureStats'),
      ]);
      Alert.alert(
        'Capture Stats',
        `lastFailedCaptureStats:\n${failed ?? '(none)'}\n\nlastWeakCaptureStats:\n${weak ?? '(none)'}`
      );
    } catch (err) {
      Alert.alert('Capture Stats', 'Read error: ' + String(err));
    }
  }

  const showCamera = hasPermission === true && device != null;
  // Pause the live session (without unmounting → no black-flash remount) once
  // the clip is captured: extraction runs off the saved file, so the live feed
  // is pure waste during processing. See useSwingCapture.ts:235-236,244-256.
  const isProcessing = capturePhase === 'processing';
  const isCountdown = capturePhase === 'countdown';
  const isWeak = capturePhase === 'weak';
  const isError = capturePhase === 'error';
  const isInitializing = hasPermission === null || (showCamera && !cameraReady);

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
            isActive={isCameraActive && !isProcessing}
            animatedProps={animatedCameraProps}
            format={format}
            fps={targetFps}
            pixelFormat="rgb"
            photo={false}
            video={true}
            audio={false}
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
        /* focus ? (
          <View style={styles.focusCard}>
            <Text style={styles.focusTitle}>Today&apos;s Focus</Text>
            <Text style={styles.focusLabel}>{focus.label}</Text>
            <Text style={styles.focusCue}>{focus.cue}</Text>
          </View>
        ) : */ (showTips ? (
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
        ) : null}
      </View>

      {/* Instant ↔ Countdown toggle — sets what the center shutter button fires */}
      {capturePhase === 'idle' && cameraReady && (
        <TouchableOpacity
          style={styles.modeToggle}
          onPress={() => setCaptureMode((m) => (m === 'instant' ? 'countdown' : 'instant'))}
          activeOpacity={0.7}
        >
          <Ionicons
            name={captureMode === 'countdown' ? 'timer-outline' : 'flash-outline'}
            size={16}
            color={GOLD}
          />
          <Text style={styles.modeToggleText}>
            {captureMode === 'countdown' ? '3·2·1' : 'Instant'}
          </Text>
        </TouchableOpacity>
      )}

      {/* TEMP debug button — read AsyncStorage capture-stats slots */}
      {__DEV__ && (
        <TouchableOpacity
          onPress={handleDebugStats}
          style={{ position: 'absolute', top: 60, right: 16, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 12 }}
          activeOpacity={0.7}
        >
          <Text style={{ color: '#fff', fontSize: 12 }}>Debug Stats</Text>
        </TouchableOpacity>
      )}

    </GestureHandlerRootView>
  );
}
