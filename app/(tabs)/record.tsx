import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { View, Text, Image, StyleSheet, TouchableOpacity, ActivityIndicator, useWindowDimensions, Modal, Pressable, Alert } from 'react-native';
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
import FaceOnSetupOverlay from '../../components/FaceOnSetupOverlay';
import CameraGuidance from '../../components/CameraGuidance';
import type { CameraGuidanceColor } from '../../lib/cameraGuidance';
import { checkSwingLimit } from '../../lib/swingLimit';
import { useTiltCapture } from '../../lib/useTiltCapture';
import { useSwingCapture } from '../../lib/useSwingCapture';
import { clinicSessionActive } from '@/lib/clinic/clinicSessionStore';
import { GOLD } from '../../lib/colors';
import {
  getProfiles,
  getPrimaryProfile,
  setPrimaryProfile,
  getDisplayName,
  ensureLocalPrimaryProfile,
  type PlayerProfile,
} from '../../lib/playerProfiles';
import { supabase, getUserId } from '../../lib/supabase';
import {
  registerShutter,
  clearShutter,
  registerStop,
  clearStop,
  setRecording,
  setProcessing,
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

// Recover the onboarding display name from Supabase to seed a local profile for
// users who onboarded before local profiles were seeded (self-heal on Record mount).
// Returns null offline / when missing → the seeder falls back to a default name.
async function fetchOnboardingName(): Promise<string | null> {
  try {
    const uid = await getUserId();
    if (!uid) return null;
    const { data } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('id', uid)
      .single();
    return data?.display_name ?? null;
  } catch {
    return null;
  }
}

export default function RecordTab() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const goPlayer = useAudioPlayer(require('../../assets/go.wav'));

  const { width: screenW } = useWindowDimensions();
  const [containerH, setContainerH] = useState(0);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [showCameraHint, setShowCameraHint] = useState(false);
  const [focus, setFocus] = useState<FocusData | null>(null);
  const skeletonUpdateRef = useRef<((lms: Landmark[]) => void) | null>(null);
  const frameAspectRef = useRef(0);
  const [frameAspectState, setFrameAspectState] = useState(0);

  const cameraRef = useRef<Camera>(null);
  // Live mirror of cameraReady for the once-per-focus shutter closure to read
  // (the closure must not capture the cameraReady state — stale value). Set in
  // onInitialized alongside setCameraReady(true); never reset (cameraReady is
  // never torn down in this file).
  const cameraReadyRef = useRef(false);
  // [KPI] P7 instrumentation — stamped at the top of the setup effect; consumed
  // once in onInitialized to log camera-screen-opened → first-preview-frame.
  const screenOpenedAt = useRef<number | null>(null);
  const { startCapture, stopCapture, getReadings } = useTiltCapture();

  // Min-display guard for the tab-bar processing spinner — keeps it visible
  // ≥ MIN_PROCESSING_MS so the near-instant failure path (processing→complete)
  // never flashes it. Purely presentational; does not touch the capture pipeline.
  const processingShownAtRef = useRef<number | null>(null);
  const processingClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Camera guidance (Task 13) — EMA-smoothed shoulder separation
  const smoothedSepRef = useRef<number | null>(null);
  const [guidanceColor, setGuidanceColor] = useState<CameraGuidanceColor | null>(null);
  const [guidanceLabel, setGuidanceLabel] = useState<string | null>(null);

  const [captureMode, setCaptureMode] = useState<'instant' | 'countdown'>('instant');

  // #11 face-on setup guide — per-session show/hide (resets ON each mount; not persisted).
  const [showGuide, setShowGuide] = useState(true);

  // Active-kid chip — second UI entry point to the SAME primary-profile switch
  // (setPrimaryProfile / getPrimaryProfile) that Settings + swing attribution use.
  const [profiles, setProfiles] = useState<PlayerProfile[]>([]);
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const refreshProfiles = useCallback(async () => {
    // Self-heal: ensure a local primary profile exists so recording isn't blocked
    // (covers users who onboarded before local profiles were seeded). No-op if one
    // already exists.
    await ensureLocalPrimaryProfile(fetchOnboardingName);
    const all = await getProfiles();
    const primary = await getPrimaryProfile();
    setProfiles(all);
    setPrimaryId(primary?.id ?? null);
  }, []);

  const handleSelectKid = useCallback(
    async (id: string) => {
      await setPrimaryProfile(id); // same canonical switch as Settings + #148 read path
      await refreshProfiles();
      setPickerOpen(false);
    },
    [refreshProfiles]
  );

  // Synchronous snapshot of the kid shown in the chip, read at button-press by
  // useSwingCapture.beginRecording (kept fresh each render). This is the exact
  // profile + handedness the swing is attributed to — never re-read at persist.
  const activeProfileRef = useRef<{ id: string; isLeftHanded: boolean } | null>(null);
  const activeProfile = profiles.find((p) => p.id === primaryId);
  activeProfileRef.current = activeProfile
    ? { id: activeProfile.id, isLeftHanded: activeProfile.isLeftHanded }
    : null;

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
    preArmed,
    enterReady,
    exitReady,
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
    getActiveProfile: () => activeProfileRef.current,
    onMissingProfile: () =>
      Alert.alert(
        'Select a player',
        'Choose a player profile before recording so the swing is saved to the right kid.',
      ),
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
      }).catch((err) => console.error('[HoneySwing]', err));

      // Re-read profiles/primary on focus so a switch made in Settings reflects here
      // (playerProfiles is stateless — no subscription mechanism).
      refreshProfiles().catch((err) => console.error('[HoneySwing]', err));
      // eslint-disable-next-line react-hooks/exhaustive-deps -- capturePhaseRef is a ref object (stable; .current is intentionally not tracked); updateCapturePhase is defined inline in useSwingCapture and would cause infinite loop if tracked
    }, [router, refreshProfiles])
  );

  useFocusEffect(
    useCallback(() => {
      setIsCameraActive(true);
      return () => {
        setIsCameraActive(false);
      };
    }, [])
  );

  // Single writer of the tab bar's isRecording/isProcessing booleans — kept in
  // lockstep with the capturePhase source of truth.
  const MIN_PROCESSING_MS = 400;
  useEffect(() => {
    setRecording(capturePhase === 'capturing');

    if (capturePhase === 'processing') {
      if (processingClearTimerRef.current) {
        clearTimeout(processingClearTimerRef.current);
        processingClearTimerRef.current = null;
      }
      processingShownAtRef.current = Date.now();
      setProcessing(true);
      return;
    }

    // Leaving processing — hold the spinner for the remainder of MIN_PROCESSING_MS
    // so a near-instant processing→complete (failure path) doesn't flash it.
    const shownAt = processingShownAtRef.current;
    if (shownAt == null) {
      setProcessing(false);
      return;
    }
    const remaining = MIN_PROCESSING_MS - (Date.now() - shownAt);
    if (remaining <= 0) {
      setProcessing(false);
      processingShownAtRef.current = null;
      return;
    }
    if (processingClearTimerRef.current) clearTimeout(processingClearTimerRef.current);
    processingClearTimerRef.current = setTimeout(() => {
      setProcessing(false);
      processingClearTimerRef.current = null;
      processingShownAtRef.current = null;
    }, remaining);
  }, [capturePhase]);

  // Register the center-button shutter/stop handlers on focus, clear on blur.
  // The closures call the live refs so they re-read current hook fns at fire time.
  useFocusEffect(
    useCallback(() => {
      registerShutter(() => {
        if (capturePhaseRef.current !== 'idle') return;
        if (!cameraReadyRef.current) {
          console.log('[P3] early-tap-blocked', Date.now());
          return;
        }
        if (captureModeRef.current === 'countdown') startCountdownRef.current();
        else startInstantRef.current();
      });
      registerStop(() => { finalizeRef.current(); });
      return () => {
        clearShutter();
        clearStop();
        setRecording(false);
        setProcessing(false);
        if (processingClearTimerRef.current) {
          clearTimeout(processingClearTimerRef.current);
          processingClearTimerRef.current = null;
        }
        processingShownAtRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- closures call refs (.current is live); register strictly once per focus
    }, [])
  );

  useEffect(() => {
    let mounted = true;
    screenOpenedAt.current = Date.now();

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

  const showCamera = hasPermission === true && device != null;
  // Pause the live session (without unmounting → no black-flash remount) once
  // the clip is captured: extraction runs off the saved file, so the live feed
  // is pure waste during processing. See handleCaptureFailure and finalizeCapture
  // in useSwingCapture.ts (processing-phase transitions).
  const isProcessing = capturePhase === 'processing';
  const isCountdown = capturePhase === 'countdown';
  const isWeak = capturePhase === 'weak';
  const isError = capturePhase === 'error';
  const isInitializing = hasPermission === null || (showCamera && !cameraReady);
  // Branded post-capture overlay: cover the camera for the whole processing→complete
  // wait so the live-feed flash (camera toggling isActive) never shows. Excludes
  // 'weak'/'error' so the retry path keeps the live preview.
  const showBrandOverlay = capturePhase === 'processing' || capturePhase === 'complete';
  const brandIconSize = Math.min(screenW * 0.4, 200);

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
            onInitialized={() => {
              setCameraReady(true);
              cameraReadyRef.current = true;
              if (screenOpenedAt.current != null) {
                console.log('[KPI] first-preview-frame ms', Date.now() - screenOpenedAt.current);
                screenOpenedAt.current = null;
              }
            }}
          />
          {capturePhase === 'idle' && cameraReady && showGuide && (
            <FaceOnSetupOverlay
              height={containerH}
              mirrored={!!activeProfile?.isLeftHanded}
            />
          )}
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

      {/* Capture-mode segmented control — sets what the center shutter button fires */}
      {capturePhase === 'idle' && cameraReady && (
        <View style={styles.modeSegmentControl}>
          <TouchableOpacity
            style={[styles.modeSegment, captureMode === 'instant' && styles.modeSegmentActive]}
            onPress={() => setCaptureMode('instant')}
            activeOpacity={0.7}
          >
            <Ionicons
              name="flash-outline"
              size={14}
              color={captureMode === 'instant' ? '#1a1a1a' : 'rgba(255,255,255,0.5)'}
            />
            <Text style={[styles.modeSegmentText, captureMode === 'instant' && styles.modeSegmentTextActive]}>
              Instant
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeSegment, captureMode === 'countdown' && styles.modeSegmentActive]}
            onPress={() => setCaptureMode('countdown')}
            activeOpacity={0.7}
          >
            <Text style={[styles.modeSegmentText, captureMode === 'countdown' && styles.modeSegmentTextActive]}>
              3·2·1
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Watch-primary pre-arm: tap Ready, then tap Start on the watch. A fresh watch
          `started` auto-starts video; otherwise the chip just reminds you to start there. */}
      {capturePhase === 'idle' && cameraReady && (
        <TouchableOpacity
          style={styles.preArmChip}
          onPress={() => (preArmed ? exitReady() : enterReady())}
          activeOpacity={0.7}
        >
          <View style={[styles.modeSegment, preArmed && styles.modeSegmentActive]}>
            <Ionicons
              name="watch-outline"
              size={14}
              color={preArmed ? '#1a1a1a' : 'rgba(255,255,255,0.5)'}
            />
            <Text style={[styles.modeSegmentText, preArmed && styles.modeSegmentTextActive]}>
              {preArmed ? 'Ready — start from your watch' : 'Ready (watch)'}
            </Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Active-kid chip (top-right) — shows who the next swing is attributed to;
          tap to switch the primary profile. Mirrors the top-left mode toggle's style. */}
      {capturePhase === 'idle' && cameraReady && profiles.length > 0 && (
        <TouchableOpacity
          style={styles.kidChip}
          onPress={() => setPickerOpen(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="person" size={13} color={GOLD} />
          <Text style={styles.kidChipText} numberOfLines={1}>
            {getDisplayName(profiles.find((p) => p.id === primaryId) ?? profiles[0])}
          </Text>
          <Ionicons name="chevron-down" size={12} color="rgba(255,255,255,0.6)" />
        </TouchableOpacity>
      )}

      {/* #11 guide show/hide — eye chip on the right rail, directly below the kid chip. */}
      {capturePhase === 'idle' && cameraReady && (
        <TouchableOpacity
          style={localStyles.guideToggle}
          onPress={() => setShowGuide((v) => !v)}
          activeOpacity={0.7}
        >
          <Ionicons
            name={showGuide ? 'eye' : 'eye-off'}
            size={16}
            color={showGuide ? GOLD : 'rgba(255,255,255,0.5)'}
          />
        </TouchableOpacity>
      )}

      {/* Kid picker dropdown — selecting routes through setPrimaryProfile (same switch as Settings). */}
      <Modal
        visible={pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable style={styles.kidPickerBackdrop} onPress={() => setPickerOpen(false)}>
          <View style={styles.kidPickerCard}>
            {profiles.map((p) => (
              <TouchableOpacity
                key={p.id}
                style={styles.kidPickerRow}
                onPress={() => handleSelectKid(p.id)}
                activeOpacity={0.7}
              >
                <Text style={[styles.kidPickerDot, { color: p.id === primaryId ? GOLD : 'transparent' }]}>
                  ●
                </Text>
                <Text style={styles.kidPickerName} numberOfLines={1}>{p.name}</Text>
                <Text style={styles.kidPickerHand}>{p.isLeftHanded ? 'L' : 'R'}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* Branded post-capture overlay — opaque full-screen view covering the live feed +
          controls for the processing|complete wait, leaving one "Analyzing your swing…" line.
          INVARIANT: must stay IN-TREE and the FINAL sibling of GestureHandlerRootView (sibling
          order is the z-order, so it must render after the Camera + every control above). Do NOT
          convert back to a <Modal>: a stranded native Modal window froze the Record controls
          after empty/failed captures. As an in-tree View it no longer covers the floating tab
          bar (separate tree), so the tab bar's own processing UI may briefly show. */}
      {showBrandOverlay && isFocused && (
        <View style={localStyles.brandOverlay}>
          <Image
            source={require('../../assets/images/icon.png')}
            style={{ width: brandIconSize, height: brandIconSize, borderRadius: brandIconSize * 0.22 }}
            resizeMode="contain"
          />
          <View style={localStyles.brandLabelRow}>
            <ActivityIndicator size="small" color="#fff" />
            <Text style={localStyles.brandLabel}>Analyzing your swing…</Text>
          </View>
        </View>
      )}

    </GestureHandlerRootView>
  );
}

const localStyles = StyleSheet.create({
  guideToggle: {
    position: 'absolute',
    top: 102, // below kidChip (top:60 right:16, ~34px tall); mirrors preArmChip's offset on the right rail
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 20,
    padding: 9,
  },
  brandOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#111111',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 20,
  },
  brandLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
