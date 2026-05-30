import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import Svg, { Circle, Line } from 'react-native-svg';
import { GOLD } from '../../lib/colors';
import { segmentHand, type SegmentationResult } from '../../lib/handSegmentation';
import type { AppleVisionJointName } from '../../lib/adapters/visionHandAdapter';

type Phase = 'camera' | 'analyzing' | 'result';
type Method = 'appleSubject' | 'applePerson' | 'mediapipe';
type Opacity = 0.3 | 0.6 | 0.9;

const METHOD_LABEL: Record<Method, string> = {
  appleSubject: 'Apple Subject',
  applePerson: 'Apple Person',
  mediapipe: 'MediaPipe',
};

const HAND_BONES: [AppleVisionJointName, AppleVisionJointName][] = [
  ['wrist', 'thumbCMC'], ['thumbCMC', 'thumbMP'], ['thumbMP', 'thumbIP'], ['thumbIP', 'thumbTip'],
  ['wrist', 'indexMCP'], ['indexMCP', 'indexPIP'], ['indexPIP', 'indexDIP'], ['indexDIP', 'indexTip'],
  ['wrist', 'middleMCP'], ['middleMCP', 'middlePIP'], ['middlePIP', 'middleDIP'], ['middleDIP', 'middleTip'],
  ['wrist', 'ringMCP'], ['ringMCP', 'ringPIP'], ['ringPIP', 'ringDIP'], ['ringDIP', 'ringTip'],
  ['wrist', 'littleMCP'], ['littleMCP', 'littlePIP'], ['littlePIP', 'littleDIP'], ['littleDIP', 'littleTip'],
  ['indexMCP', 'middleMCP'], ['middleMCP', 'ringMCP'], ['ringMCP', 'littleMCP'],
];

const CHIRALITY_COLOR: Record<'left' | 'right' | 'unknown', string> = {
  left: '#FFFFFF',
  right: '#FF1744',
  unknown: '#FFEB3B',
};

export default function OutlineTestScreen() {
  const router = useRouter();
  const cameraRef = useRef<Camera>(null);
  const device = useCameraDevice('back');

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [phase, setPhase] = useState<Phase>('camera');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoAspect, setPhotoAspect] = useState<number | null>(null);
  const [segResult, setSegResult] = useState<SegmentationResult | null>(null);
  const [topLevelError, setTopLevelError] = useState<string | null>(null);
  const [activeMethod, setActiveMethod] = useState<Method>('appleSubject');
  const [opacity, setOpacity] = useState<Opacity>(0.6);
  const [showHand, setShowHand] = useState(true);

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

  async function capturePhoto() {
    if (!cameraRef.current) {
      setTopLevelError('Camera ref not available');
      return;
    }
    try {
      const photo = await cameraRef.current.takePhoto();
      if (!photo.path) {
        setTopLevelError('takePhoto returned no path');
        return;
      }
      const uri = photo.path.startsWith('file://') ? photo.path : `file://${photo.path}`;
      setPhotoUri(uri);
      setPhase('analyzing');
      try {
        const res = await segmentHand(uri);
        setSegResult(res);
        // Measure the normalized PNG (shares coord space with the masks), not
        // the EXIF-rotated original — keeps RN aspectRatio in sync with mask dims.
        const sizeUri = res.normalizedPhotoUri ?? uri;
        Image.getSize(
          sizeUri,
          (w, h) => setPhotoAspect(w / h),
          () => setPhotoAspect(null),
        );
        // Auto-pick a method that succeeded (preferring Apple Subject).
        if (res.appleSubjectMaskUri) setActiveMethod('appleSubject');
        else if (res.applePersonMaskUri) setActiveMethod('applePerson');
        else if (res.mediapipeMaskUri) setActiveMethod('mediapipe');
        setPhase('result');
      } catch (e: any) {
        const msg = e?.code ? `${e.code}: ${e.message ?? ''}` : (e?.message ?? 'segmentHand failed');
        setTopLevelError(msg);
        setPhase('result');
      }
    } catch (e: any) {
      console.error('[OutlineTest] takePhoto error:', e);
      setTopLevelError(e?.message ?? 'Capture failed');
    }
  }

  function handleRetake() {
    setPhotoUri(null);
    setSegResult(null);
    setTopLevelError(null);
    setPhotoAspect(null);
    setActiveMethod('appleSubject');
    setOpacity(0.6);
    setShowHand(true);
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
          <Text style={styles.analyzingText}>Running segmenters…</Text>
        </View>
      </View>
    );
  }

  if (phase === 'result') {
    const activeUri =
      activeMethod === 'appleSubject' ? segResult?.appleSubjectMaskUri ?? null :
      activeMethod === 'applePerson' ? segResult?.applePersonMaskUri ?? null :
      segResult?.mediapipeMaskUri ?? null;
    const activeError =
      activeMethod === 'appleSubject' ? segResult?.appleSubjectError :
      activeMethod === 'applePerson' ? segResult?.applePersonError :
      segResult?.mediapipeError;
    // Prefer the native-normalized PNG so the photo and mask share a
    // coordinate space; fall back to the raw EXIF capture if normalize failed.
    const displayPhotoUri = segResult?.normalizedPhotoUri ?? photoUri;

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
        >
          {displayPhotoUri && (
            <Image source={{ uri: displayPhotoUri }} style={styles.resultPhoto} resizeMode="contain" />
          )}
          {activeUri && (
            <Image
              source={{ uri: activeUri }}
              style={[styles.resultPhoto, StyleSheet.absoluteFillObject, { opacity }]}
              resizeMode="contain"
            />
          )}
          {showHand && segResult?.appleHandPose && segResult.appleHandPose.length > 0 && (
            <Svg
              style={StyleSheet.absoluteFillObject}
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
            >
              {segResult.appleHandPose.map((hand, i) => {
                const color = CHIRALITY_COLOR[hand.chirality];
                return (
                  <React.Fragment key={i}>
                    {HAND_BONES.map(([a, b], j) => {
                      const pa = hand.joints[a];
                      const pb = hand.joints[b];
                      if (!pa || !pb) return null;
                      return (
                        <Line
                          key={`b${j}`}
                          x1={pa.x}
                          y1={1 - pa.y}
                          x2={pb.x}
                          y2={1 - pb.y}
                          stroke={color}
                          strokeWidth={0.005}
                        />
                      );
                    })}
                    {Object.entries(hand.joints).map(([name, p]) =>
                      p ? (
                        <Circle key={name} cx={p.x} cy={1 - p.y} r={0.012} fill={color} />
                      ) : null,
                    )}
                  </React.Fragment>
                );
              })}
            </Svg>
          )}
        </View>

        <View style={styles.controlsRow}>
          {(['appleSubject', 'applePerson', 'mediapipe'] as Method[]).map((m) => (
            <TouchableOpacity
              key={m}
              style={[styles.methodBtn, activeMethod === m && styles.methodBtnActive]}
              onPress={() => setActiveMethod(m)}
            >
              <Text style={[styles.methodBtnText, activeMethod === m && styles.methodBtnTextActive]}>
                {METHOD_LABEL[m]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.controlsRow}>
          {([0.3, 0.6, 0.9] as Opacity[]).map((o) => (
            <TouchableOpacity
              key={o}
              style={[styles.opacityBtn, opacity === o && styles.opacityBtnActive]}
              onPress={() => setOpacity(o)}
            >
              <Text style={[styles.opacityBtnText, opacity === o && styles.opacityBtnTextActive]}>
                {Math.round(o * 100)}%
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.controlsRow}>
          <TouchableOpacity
            style={[styles.opacityBtn, showHand && styles.opacityBtnActive]}
            onPress={() => setShowHand((v) => !v)}
          >
            <Text style={[styles.opacityBtnText, showHand && styles.opacityBtnTextActive]}>
              Hand {showHand ? 'On' : 'Off'}
            </Text>
          </TouchableOpacity>
        </View>

        {!activeUri && activeError && (
          <Text style={styles.errorText}>{METHOD_LABEL[activeMethod]}: {activeError}</Text>
        )}
        {topLevelError && (
          <Text style={styles.errorText}>{topLevelError}</Text>
        )}

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
      <View style={styles.controlsLayer} pointerEvents="box-none">
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
          <Text style={styles.closeBtnText}>X</Text>
        </TouchableOpacity>

        {topLevelError && <Text style={styles.errorText}>{topLevelError}</Text>}

        <View style={styles.hintPill}>
          <Text style={styles.hintText}>Outline test — capture a hand</Text>
        </View>
        <TouchableOpacity
          style={[styles.captureBtn, !cameraReady && styles.captureBtnDisabled]}
          onPress={capturePhoto}
          disabled={!cameraReady}
        >
          <Text style={styles.captureBtnText}>Capture</Text>
        </TouchableOpacity>
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
  captureBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  msgText: { color: '#fff', fontSize: 16, marginBottom: 16 },
  errorText: { color: '#FF5252', fontSize: 13, marginHorizontal: 20, marginVertical: 4 },
  btn: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: GOLD,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  hintPill: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginBottom: 16,
  },
  hintText: { color: '#fff', fontSize: 13, fontWeight: '500' },
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
  controlsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 8,
  },
  methodBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 0, 0.2)',
    alignItems: 'center',
  },
  methodBtnActive: {
    backgroundColor: GOLD,
    borderColor: GOLD,
  },
  methodBtnText: { color: GOLD, fontSize: 13, fontWeight: '600' },
  methodBtnTextActive: { color: '#000' },
  opacityBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 0, 0.2)',
    alignItems: 'center',
  },
  opacityBtnActive: {
    backgroundColor: GOLD,
    borderColor: GOLD,
  },
  opacityBtnText: { color: GOLD, fontSize: 13, fontWeight: '600' },
  opacityBtnTextActive: { color: '#000' },
  resultButtons: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingVertical: 20,
  },
});
