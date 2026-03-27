import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Image,
  ActivityIndicator,
} from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import { setGrip } from '../../lib/gripStore';

type Phase = 'camera' | 'countdown' | 'preview';

export default function GripCaptureScreen() {
  const router = useRouter();
  const cameraRef = useRef<Camera>(null);
  const device = useCameraDevice('back');
  const countdownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [phase, setPhase] = useState<Phase>('camera');
  const [countdownValue, setCountdownValue] = useState(3);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Permission — mirrors record.tsx pattern
  useEffect(() => {
    let mounted = true;
    async function checkPermission() {
      let status = await Camera.getCameraPermissionStatus();
      if (status === 'not-determined') {
        status = await Camera.requestCameraPermission();
      }
      if (mounted) setHasPermission(status === 'granted');
    }
    checkPermission();
    return () => { mounted = false; };
  }, []);

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
      console.log('[GripCapture] takePhoto result:', JSON.stringify(photo));

      if (!photo.path) {
        setError('takePhoto returned no path');
        setPhase('camera');
        return;
      }

      const uri = photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`;
      console.log('[GripCapture] preview URI:', uri);
      setError(null);
      setPhotoUri(uri);
      setPhase('preview');
    } catch (e: any) {
      console.error('[GripCapture] takePhoto error:', e);
      setError(e.message ?? 'Capture failed');
      setPhase('camera');
    }
  }

  function handleRetake() {
    setPhotoUri(null);
    setError(null);
    setSubmitting(false);
    setPhase('camera');
  }

  function handleUseThis() {
    if (!photoUri || submitting) return;
    setSubmitting(true);
    setGrip(photoUri);
    router.push('/grip/result' as Href);
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
    return (
      <View style={styles.container}>
        <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
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
        isActive={phase !== 'preview'}
        photo={true}
        video={false}
        audio={false}
        onInitialized={() => setCameraReady(true)}
      />

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
});
