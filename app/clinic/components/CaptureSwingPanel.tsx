import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { useRouter } from 'expo-router';
import Animated, { useAnimatedProps, useSharedValue } from 'react-native-reanimated';
import { Camera, useCameraDevice, useCameraFormat, useFrameProcessor } from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';
import { honeyPoseDetect } from '../../../modules/vision-camera-pose/src';
import SkeletonOverlay, { type Landmark } from '../../../components/SkeletonOverlay';
import CameraGuidance from '../../../components/CameraGuidance';
import type { CameraGuidanceColor } from '../../../lib/cameraGuidance';
import { useTiltCapture } from '../../../lib/useTiltCapture';
import { useSwingCapture } from '../../../lib/useSwingCapture';
import { usePoseFrameHandler } from '../../../lib/usePoseFrameHandler';
import { GOLD } from '../../../lib/colors';
import { styles } from '../clinicStyles';

const ReanimatedCamera = Animated.createAnimatedComponent(Camera);

interface CaptureSwingPanelProps {
  swingLabel: string;
  onSwingPersisted: (swingId: string | null) => void;
  onCapturePhaseDone?: () => void;
  immediateStart?: boolean;
}

export default function CaptureSwingPanel(props: CaptureSwingPanelProps): React.ReactElement {
  const { swingLabel, onSwingPersisted, onCapturePhaseDone, immediateStart } = props;
  const navRouter = useRouter();
  const goPlayer = useAudioPlayer(require('../../../assets/go.wav'));
  const { width: screenW } = useWindowDimensions();

  const [containerH, setContainerH] = useState(0);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);

  const skeletonUpdateRef = useRef<((lms: Landmark[]) => void) | null>(null);
  const frameAspectRef = useRef(0);
  const [frameAspectState, setFrameAspectState] = useState(0);
  const [landmarks, setLandmarks] = useState<Landmark[]>([]);
  skeletonUpdateRef.current = setLandmarks;

  const cameraRef = useRef<Camera | null>(null);
  const { startCapture: startTiltCapture, stopCapture: stopTiltCapture, getReadings: getTiltReadings } = useTiltCapture();

  const smoothedSepRef = useRef<number | null>(null);
  const [guidanceColor, setGuidanceColor] = useState<CameraGuidanceColor | null>(null);
  const [guidanceLabel, setGuidanceLabel] = useState<string | null>(null);

  const device = useCameraDevice('back');
  const format = useCameraFormat(device, [
    { fps: 120, videoResolution: { width: 1280, height: 720 } },
  ]);
  const targetFps = Math.min(format?.maxFps ?? 30, 120);
  const skipInterval = 1;

  const zoom = useSharedValue(device?.minZoom ?? 1);
  const frameSkipCounter = useSharedValue(0);
  const fpsFrameCount = useSharedValue(0);
  const fpsWindowStartTs = useSharedValue(0);
  const actualFpsRef = useRef(0);
  const updateActualFpsJSRef = useRef<any>(null);
  if (updateActualFpsJSRef.current === null) {
    updateActualFpsJSRef.current = Worklets.createRunOnJS((v: number) => {
      actualFpsRef.current = v;
    });
  }

  const onSwingPersistedCb = useCallback(
    (id: string | null) => {
      onSwingPersisted(id);
    },
    [onSwingPersisted],
  );

  const {
    capturePhase,
    countdown,
    startCountdownCapture,
    startInstantCapture,
    updateCapturePhase,
    capturePhaseRef,
    clearTimers,
    bufferPoseFrame,
  } = useSwingCapture({
    cameraRef,
    router: navRouter,
    goPlayer,
    startTiltCapture,
    stopTiltCapture,
    getTiltReadings,
    smoothedSepRef,
    guidanceColor,
    hasPermission,
    hasDevice: !!device,
    cameraReady,
    onBeginRecording: () => {
      frameSkipCounter.value = 0;
    },
    actualFpsRef,
    targetFps,
    skipResultNavigation: true,
    onSwingPersisted: onSwingPersistedCb,
  });

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

  const animatedCameraProps = useAnimatedProps(() => ({
    zoom: zoom.value,
  }));

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      frameSkipCounter.value = frameSkipCounter.value + 1;

      if (fpsWindowStartTs.value === 0) {
        fpsWindowStartTs.value = frame.timestamp;
      }
      fpsFrameCount.value += 1;
      if (fpsFrameCount.value >= 30) {
        const elapsedSec = (frame.timestamp - fpsWindowStartTs.value) / 1e3;
        const actualFps = elapsedSec > 0 ? fpsFrameCount.value / elapsedSec : 0;
        updateActualFpsJSRef.current(actualFps);
        fpsFrameCount.value = 0;
        fpsWindowStartTs.value = frame.timestamp;
      }

      if (frameSkipCounter.value % skipInterval !== 0) return;

      const lms = honeyPoseDetect(frame);
      const detected = Array.isArray(lms) && lms.length > 0;
      if (detected) {
        const aspect = frame.height > 0 && frame.width > 0 ? frame.height / frame.width : 0;
        appendPoseFrame(lms, frame.timestamp, frame.width, frame.height, aspect);
      }
    },
    [appendPoseFrame, skipInterval, frameSkipCounter, fpsFrameCount, fpsWindowStartTs]
  );

  useEffect(() => {
    let mounted = true;
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
      if (!mounted) return;
      const granted = status === 'granted';
      setHasPermission(granted);
      if (granted) {
        setIsCameraActive(false);
        setTimeout(() => {
          if (mounted) setIsCameraActive(true);
        }, 150);
      }
    }
    setupScreen();
    return () => {
      mounted = false;
      clearTimers();
    };
  }, []);

  useEffect(() => {
    if (capturePhase === 'complete') {
      onCapturePhaseDone?.();
    }
  }, [capturePhase, onCapturePhaseDone]);

  const showCamera = hasPermission === true && device != null;
  const isCountdown = capturePhase === 'countdown';
  const isCapturing = capturePhase === 'capturing';
  const isWeak = capturePhase === 'weak';
  const isError = capturePhase === 'error';
  const isComplete = capturePhase === 'complete';
  const isInitializing = hasPermission === null || (showCamera && !cameraReady);
  const canRecord = cameraReady && !isCapturing && !isWeak && !isCountdown && !isError && !isComplete;

  return (
    <View
      style={{ flex: 1 }}
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        if (h !== containerH) setContainerH(h);
      }}
    >
      <Text style={styles.swingCounter}>{swingLabel}</Text>
      <View style={styles.capturePanel}>
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
              pixelFormat="rgb"
              photo={false}
              video={true}
              audio={false}
              frameProcessor={frameProcessor}
              onInitialized={() => setCameraReady(true)}
            />
            <SkeletonOverlay
              landmarks={landmarks}
              width={screenW}
              height={containerH}
              frameAspect={frameAspectState}
            />
            {capturePhase === 'idle' && cameraReady && (
              <CameraGuidance color={guidanceColor} label={guidanceLabel} />
            )}
          </>
        ) : (
          <View style={{ alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color={GOLD} />
            <Text style={{ color: '#FFFFFF', marginTop: 12 }}>
              {hasPermission === false ? 'Camera permission denied' : 'Starting camera…'}
            </Text>
          </View>
        )}

        {isCountdown && countdown != null && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: GOLD, fontSize: 120, fontWeight: '900' }}>{countdown}</Text>
          </View>
        )}
      </View>

      <View style={{ paddingHorizontal: 20, paddingVertical: 16, gap: 12 }}>
        {(isWeak || isError) ? (
          <>
            <Text style={{ color: '#FFFFFF', textAlign: 'center' }}>Capture failed — try again</Text>
            <Pressable style={styles.primaryButton} onPress={() => updateCapturePhase('idle')}>
              <Text style={styles.primaryButtonText}>Retry</Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            style={[styles.primaryButton, !canRecord && { opacity: 0.5 }]}
            disabled={!canRecord}
            onPress={() => (immediateStart ? startInstantCapture() : startCountdownCapture())}
          >
            <Text style={styles.primaryButtonText}>
              {isInitializing
                ? 'PREPARING…'
                : isCapturing || isCountdown
                  ? 'RECORDING…'
                  : 'RECORD'}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
