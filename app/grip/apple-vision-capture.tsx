import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Image,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import { GOLD } from '../../lib/colors';
import { detectAppleHand, type AppleHand } from '../../lib/appleHandDetection';
import AppleHandOverlay from '../../components/AppleHandOverlay';

type Phase = 'camera' | 'countdown' | 'analyzing' | 'result';

export default function AppleVisionCaptureScreen() {
  const router = useRouter();
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
  const [hands, setHands] = useState<AppleHand[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const [photoAspect, setPhotoAspect] = useState<number | null>(null);
  const [photoBoxSize, setPhotoBoxSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

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

  useEffect(() => {
    if (hasPermission && !cameraReady) {
      const timer = setTimeout(() => setShowCameraHint(true), 5000);
      return () => clearTimeout(timer);
    }
    if (cameraReady) setShowCameraHint(false);
  }, [hasPermission, cameraReady]);

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
    setTimeout(() => setFocusPoint(null), 600);
  }

  function startCountdown() {
    setError(null);
    setHands(null);
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
      setPhotoUri(uri);
      Image.getSize(
        uri,
        (w, h) => setPhotoAspect(w / h),
        () => setPhotoAspect(null),
      );
      setPhase('analyzing');
      try {
        const result = await detectAppleHand(uri);
        setHands(result);
        setPhase('result');
      } catch (e: any) {
        const msg = e?.code ? `${e.code}: ${e.message ?? ''}` : (e?.message ?? 'detectAppleHand failed');
        setError(msg);
        setPhase('result');
      }
    } catch (e: any) {
      console.error('[AppleVisionCapture] takePhoto error:', e);
      setError(e?.message ?? 'Capture failed');
      setPhase('camera');
    }
  }

  function handleRetake() {
    setPhotoUri(null);
    setHands(null);
    setError(null);
    setPhotoAspect(null);
    setPhase('camera');
  }

  if (hasPermission === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={GOLD} />
      </View>
    );
  }

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

  if (!device) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={GOLD} />
        <Text style={styles.msgText}>Loading camera...</Text>
      </View>
    );
  }

  if (phase === 'analyzing') {
    return (
      <View style={styles.container}>
        {photoUri && (
          <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        )}
        <View style={styles.analyzingOverlay}>
          <ActivityIndicator size="large" color={GOLD} />
          <Text style={styles.analyzingText}>Detecting hands…</Text>
        </View>
      </View>
    );
  }

  if (phase === 'result') {
    const handCount = hands?.length ?? 0;
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
          <Text style={styles.closeBtnText}>X</Text>
        </TouchableOpacity>
        <View
          style={[
            styles.resultPhotoBox,
            photoAspect ? { aspectRatio: photoAspect } : null,
          ]}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            setPhotoBoxSize({ w: width, h: height });
          }}
        >
          {photoUri && (
            <Image source={{ uri: photoUri }} style={styles.resultPhoto} resizeMode="contain" />
          )}
          <AppleHandOverlay hands={hands} width={photoBoxSize.w} height={photoBoxSize.h} />
        </View>
        <View style={styles.resultHeader}>
          <Text style={styles.resultHeaderText}>
            Hands detected: {handCount}
          </Text>
          {error && <Text style={styles.errorText}>{error}</Text>}
        </View>
        <ScrollView style={styles.jsonScroll} contentContainerStyle={styles.jsonScrollContent}>
          <Text style={styles.jsonText} selectable>
            {hands ? JSON.stringify(hands, null, 2) : '(no result)'}
          </Text>
        </ScrollView>
        <View style={styles.resultButtons}>
          <TouchableOpacity style={styles.btn} onPress={handleRetake}>
            <Text style={styles.btnText}>Retake</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isCameraActive}
        photo={true}
        video={false}
        audio={false}
        onInitialized={() => setCameraReady(true)}
        pixelFormat="rgb"
      />

      {showCameraHint && (
        <View style={styles.cameraHintBanner} pointerEvents="none">
          <Text style={styles.cameraHintText}>Camera not loading? Close and reopen the app.</Text>
        </View>
      )}

      <TouchableWithoutFeedback onPress={handleTapToFocus}>
        <View style={styles.touchLayer}>
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
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
          <Text style={styles.closeBtnText}>X</Text>
        </TouchableOpacity>

        {error && <Text style={styles.errorText}>{error}</Text>}

        {phase === 'countdown' && (
          <View style={styles.countdownContainer} pointerEvents="none">
            <Text style={styles.countdownText}>
              {countdownValue > 0 ? countdownValue : ''}
            </Text>
          </View>
        )}

        {phase === 'camera' && (
          <>
            <View style={styles.hintPill}>
              <Text style={styles.hintText}>Apple Vision diagnostic — capture a hand</Text>
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
    zIndex: 10,
  },
  closeBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  captureBtn: {
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: GOLD,
  },
  captureBtnDisabled: { opacity: 0.4 },
  captureBtnText: { color: '#1A0E00', fontSize: 18, fontWeight: '700' },
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
    borderColor: GOLD,
  },
  msgText: { color: '#fff', fontSize: 16, marginBottom: 16 },
  errorText: { color: '#FF5252', fontSize: 14, marginBottom: 8 },
  btn: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: GOLD,
  },
  btnText: { color: '#1A0E00', fontSize: 16, fontWeight: '600' },
  hintPill: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginBottom: 16,
  },
  hintText: { color: '#fff', fontSize: 13, fontWeight: '500' },
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
  analyzingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  analyzingText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  resultPhotoBox: {
    marginTop: 110,
    marginHorizontal: 20,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#222',
  },
  resultPhoto: { width: '100%', height: '100%' },
  resultHeader: {
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  resultHeaderText: { color: GOLD, fontSize: 18, fontWeight: '700', marginBottom: 4 },
  jsonScroll: {
    flex: 1,
    marginHorizontal: 20,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
  },
  jsonScrollContent: { padding: 12 },
  jsonText: {
    color: '#ddd',
    fontSize: 11,
    fontFamily: 'Courier',
    lineHeight: 15,
  },
  resultButtons: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingVertical: 20,
  },
});
