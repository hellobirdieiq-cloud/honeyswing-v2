import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Image,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { Camera, useCameraDevice, useFrameProcessor } from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';
import Svg, { Circle, Line } from 'react-native-svg';
import { setGrip } from '../../lib/gripStore';
import { detectHands, type HandResult } from '../../lib/handDetection';

const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [0, 5], [0, 9], [0, 13], [0, 17],
  [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
];

const HAND_COLORS = ['#00FF88', '#FF8800'];

type Phase = 'camera' | 'countdown' | 'preview';

export default function GripCaptureScreen() {
  const router = useRouter();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const cameraRef = useRef<Camera>(null);
  const device = useCameraDevice('back');
  const countdownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [showCameraHint, setShowCameraHint] = useState(false);
  const [phase, setPhase] = useState<Phase>('camera');
  const [countdownValue, setCountdownValue] = useState(3);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handResultsRef = useRef<HandResult[]>([]);
  const frozenHandsRef = useRef<HandResult[]>([]);
  const [handDebug, setHandDebug] = useState<HandResult[]>([]);
  const smoothedRef = useRef<Record<string, { x: number; y: number }>>({});

  const updateHandDebug = useCallback((results: HandResult[]) => {
    handResultsRef.current = results;
    const ALPHA = 0.25;
    const smoothed = results.map((hand) => {
      if (!hand.landmarks || hand.landmarks.length === 0) return hand;
      const smoothedLms = hand.landmarks.map((lm) => {
        const key = `${hand.handIndex}-${lm.id}`;
        const prev = smoothedRef.current[key];
        let sx: number, sy: number;
        if (prev) {
          sx = ALPHA * lm.x + (1 - ALPHA) * prev.x;
          sy = ALPHA * lm.y + (1 - ALPHA) * prev.y;
        } else {
          sx = lm.x;
          sy = lm.y;
        }
        smoothedRef.current[key] = { x: sx, y: sy };
        return { ...lm, x: sx, y: sy };
      });
      return { ...hand, landmarks: smoothedLms };
    });
    setHandDebug(smoothed);
  }, []);

  const onHandResults = Worklets.createRunOnJS(
    (raw: unknown) => {
      if (!Array.isArray(raw) || raw.length === 0) {
        updateHandDebug([]);
        return;
      }
      if (raw.length === 1 && (raw[0] as any)?._diagnostic) {
        return;
      }
      updateHandDebug(raw as HandResult[]);
    }
  );

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      const results = detectHands(frame);
      onHandResults(results);
    },
    [onHandResults]
  );

  // Permission — mirrors record.tsx pattern
  useEffect(() => {
    let mounted = true;
    async function checkPermission() {
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
    checkPermission();
    return () => { mounted = false; };
  }, []);

  // Fallback banner: show after 5s if camera hasn't initialized
  useEffect(() => {
    if (hasPermission && !cameraReady) {
      const timer = setTimeout(() => setShowCameraHint(true), 5000);
      return () => clearTimeout(timer);
    }
    if (cameraReady) setShowCameraHint(false);
  }, [hasPermission, cameraReady]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (countdownTimer.current) clearTimeout(countdownTimer.current);
    };
  }, []);

  function handleTapToFocus(e: { nativeEvent: { locationX: number; locationY: number } }) {
    if (phase !== 'camera' || !cameraRef.current || !device?.supportsFocus) return;
    const point = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
    setFocusPoint(point);
    cameraRef.current.focus(point).catch(() => {});
    // Clear indicator after a moment
    setTimeout(() => setFocusPoint(null), 600);
  }

  function startCountdown() {
    setError(null);
    setPhase('countdown');
    setCountdownValue(3);

    let remaining = 3;
    function tick() {
      remaining -= 1;
      if (remaining > 0) {
        setCountdownValue(remaining);
        countdownTimer.current = setTimeout(tick, 1000);
      } else {
        setCountdownValue(0);
        capturePhoto();
      }
    }
    countdownTimer.current = setTimeout(tick, 1000);
  }

  async function capturePhoto() {
    if (!cameraRef.current) {
      setError('Camera ref not available');
      setPhase('camera');
      return;
    }
    try {
      const photo = await cameraRef.current.takePhoto();
      

      if (!photo.path) {
        setError('takePhoto returned no path');
        setPhase('camera');
        return;
      }

      const uri = photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`;
      
      setError(null);
      setPhotoUri(uri);
      frozenHandsRef.current = [...handResultsRef.current];
      setPhase('preview');
    } catch (e: any) {
      console.error('[GripCapture] takePhoto error:', e);
      setError(e.message ?? 'Capture failed');
      setPhase('camera');
    }
  }

  function handleRetake() {
    frozenHandsRef.current = [];
    smoothedRef.current = {};
    setPhotoUri(null);
    setError(null);
    setSubmitting(false);
    setPhase('camera');
  }

  function handleUseThis() {
    if (!photoUri || submitting) return;
    setSubmitting(true);
    setGrip(photoUri);

    // Serialize frozen hand landmarks for the result screen (not stored in gripStore).
    const frozen = frozenHandsRef.current;
    const landmarksParam =
      frozen.length > 0
        ? JSON.stringify(
            frozen.map((h) => ({
              handIndex: h.handIndex,
              label: h.label,
              score: h.score,
              landmarks: h.landmarks.map((lm) => ({
                id: lm.id,
                name: lm.name,
                x: lm.x,
                y: lm.y,
                z: lm.z,
              })),
            })),
          )
        : undefined;

    router.push({
      pathname: '/grip/result' as Href,
      params: landmarksParam ? { landmarks: landmarksParam } : {},
    } as any);
  }

  // --- Permission not yet resolved ---
  if (hasPermission === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#F5A623" />
      </View>
    );
  }

  // --- Permission denied ---
  if (!hasPermission) {
    return (
      <View style={styles.center}>
        <Text style={styles.msgText}>Camera permission is required.</Text>
        <TouchableOpacity style={styles.btn} onPress={() => router.back()}>
          <Text style={styles.btnText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // --- No device ---
  if (!device) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#F5A623" />
        <Text style={styles.msgText}>Loading camera...</Text>
      </View>
    );
  }

  // --- Preview phase ---
  if (phase === 'preview' && photoUri) {
    const frozenHands = frozenHandsRef.current;
    return (
      <View style={styles.container}>
        <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        {frozenHands.length > 0 && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <Svg width={screenW} height={screenH}>
              {frozenHands.map((hand, hi) => {
                const color = HAND_COLORS[hi] ?? HAND_COLORS[0];
                const lms = hand.landmarks;
                if (!lms || lms.length === 0) return null;
                return (
                  <React.Fragment key={`frozen-hand-${hi}`}>
                    {HAND_CONNECTIONS.map(([a, b]) => {
                      const la = lms[a];
                      const lb = lms[b];
                      if (!la || !lb) return null;
                      return (
                        <Line
                          key={`${hi}-${a}-${b}`}
                          x1={la.x * screenW}
                          y1={la.y * screenH}
                          x2={lb.x * screenW}
                          y2={lb.y * screenH}
                          stroke={color}
                          strokeWidth={2}
                          opacity={0.6}
                        />
                      );
                    })}
                    {lms.map((lm, li) => (
                      <Circle
                        key={`${hi}-${li}`}
                        cx={lm.x * screenW}
                        cy={lm.y * screenH}
                        r={5}
                        fill={color}
                        opacity={0.8}
                      />
                    ))}
                  </React.Fragment>
                );
              })}
            </Svg>
          </View>
        )}
        <View style={styles.overlay}>
          <View style={styles.previewButtons}>
            <TouchableOpacity style={[styles.btn, styles.btnSecondary]} onPress={handleRetake}>
              <Text style={styles.btnText}>Retake</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, submitting && styles.btnDisabled]}
              onPress={handleUseThis}
              disabled={submitting}
            >
              <Text style={styles.btnText}>Use This</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  // --- Camera / Countdown phase ---
  return (
    <View style={styles.container}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isCameraActive && phase !== 'preview'}
        photo={true}
        video={false}
        audio={false}
        onInitialized={() => setCameraReady(true)}
        pixelFormat="rgb"
        frameProcessor={frameProcessor}
      />

      {showCameraHint && (
        <View style={styles.cameraHintBanner} pointerEvents="none">
          <Text style={styles.cameraHintText}>Camera not loading? Close and reopen the app.</Text>
        </View>
      )}

      <TouchableWithoutFeedback onPress={handleTapToFocus}>
        <View style={styles.touchLayer}>
          {/* Focus indicator */}
          {focusPoint && (
            <View
              style={[
                styles.focusRing,
                { left: focusPoint.x - 30, top: focusPoint.y - 30 },
              ]}
            />
          )}
        </View>
      </TouchableWithoutFeedback>

      <View style={styles.controlsLayer} pointerEvents="box-none">
        {/* Close button */}
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
          <Text style={styles.closeBtnText}>X</Text>
        </TouchableOpacity>

        {/* Error banner */}
        {error && <Text style={styles.errorText}>{error}</Text>}

        {/* Countdown overlay */}
        {phase === 'countdown' && (
          <View style={styles.countdownContainer} pointerEvents="none">
            <Text style={styles.countdownText}>
              {countdownValue > 0 ? countdownValue : ''}
            </Text>
          </View>
        )}

        {/* Capture button — only in camera phase */}
        {phase === 'camera' && (
          <>
            <View style={styles.hintPill}>
              <Text style={styles.hintText}>Show the top of your hands — knuckles facing camera</Text>
            </View>
            <TouchableOpacity
              style={[styles.captureBtn, !cameraReady && styles.captureBtnDisabled]}
              onPress={startCountdown}
              disabled={!cameraReady}
            >
              <Text style={styles.captureBtnText}>Start Capture</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Hand skeleton overlay */}
      {handDebug.length > 0 && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <Svg width={screenW} height={screenH}>
            {handDebug.map((hand, hi) => {
              const color = HAND_COLORS[hi] ?? HAND_COLORS[0];
              const lms = hand.landmarks;
              if (!lms || lms.length === 0) return null;
              return (
                <React.Fragment key={`hand-${hi}`}>
                  {HAND_CONNECTIONS.map(([a, b]) => {
                    const la = lms[a];
                    const lb = lms[b];
                    if (!la || !lb) return null;
                    return (
                      <Line
                        key={`${hi}-${a}-${b}`}
                        x1={la.x * screenW}
                        y1={la.y * screenH}
                        x2={lb.x * screenW}
                        y2={lb.y * screenH}
                        stroke={color}
                        strokeWidth={2}
                        opacity={0.6}
                      />
                    );
                  })}
                  {lms.map((lm, li) => (
                    <Circle
                      key={`${hi}-${li}`}
                      cx={lm.x * screenW}
                      cy={lm.y * screenH}
                      r={5}
                      fill={color}
                      opacity={0.8}
                    />
                  ))}
                </React.Fragment>
              );
            })}
          </Svg>
        </View>
      )}

      {/* Hand detection debug panel — dev only */}
      {__DEV__ && (
        <View style={styles.handDebugPanel} pointerEvents="none">
          <Text style={styles.handDebugText}>
            Hands: {handDebug.length}
            {handDebug.length > 0 && handDebug[0].debugInferenceMs != null
              ? `  (${handDebug[0].debugInferenceMs}ms)`
              : ''}
          </Text>
          {handDebug.map((hand) => {
            const wrist = hand.landmarks?.[0];
            return (
              <Text key={hand.handIndex} style={styles.handDebugText}>
                [{hand.handIndex}] {hand.label} ({(hand.score * 100).toFixed(0)}%)
                {wrist ? `  wrist: ${wrist.x.toFixed(3)}, ${wrist.y.toFixed(3)}` : ''}
              </Text>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#000',
  },
  touchLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  controlsLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 80,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 80,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  closeBtn: {
    position: 'absolute',
    top: 60,
    left: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  captureBtn: {
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: '#F5A623',
  },
  captureBtnDisabled: { opacity: 0.4 },
  captureBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  countdownContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  countdownText: {
    color: '#fff',
    fontSize: 120,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
  focusRing: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 2,
    borderColor: '#F5A623',
  },
  previewButtons: {
    flexDirection: 'row',
    gap: 16,
  },
  msgText: { color: '#fff', fontSize: 16, marginBottom: 16 },
  errorText: { color: '#FF5252', fontSize: 14, marginBottom: 16 },
  btn: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#F5A623',
  },
  btnSecondary: { backgroundColor: '#555' },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  hintPill: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginBottom: 16,
  },
  hintText: { color: '#fff', fontSize: 13, fontWeight: '500' },
  handDebugPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    paddingBottom: 24,
  },
  handDebugText: {
    color: '#fff',
    fontSize: 12,
    fontFamily: 'Courier',
    lineHeight: 18,
  },
  cameraHintBanner: {
    position: 'absolute',
    top: 80,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  cameraHintText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
  },
});
