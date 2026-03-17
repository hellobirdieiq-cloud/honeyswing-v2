import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Button, StyleSheet, ScrollView } from 'react-native';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { useRouter } from 'expo-router';
import { Camera, useCameraDevice, useFrameProcessor } from 'react-native-vision-camera';
import { Worklets } from 'react-native-worklets-core';
import { honeyPoseDetect } from '../../modules/vision-camera-pose/src';
import { Colors } from '../../constants/colors';
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

const MAX_BUFFERED_POSE_FRAMES = 180;
const MIN_FRAMES_FOR_ANALYSIS = 6;
const COUNTDOWN_MS = 3000;
const CAPTURE_WINDOW_MS = 2200;

type CapturePhase = 'idle' | 'countdown' | 'capturing' | 'complete' | 'error';
type CaptureStartMode = 'countdown' | 'instant';

export default function RecordTab() {
  const router = useRouter();
  const beepPlayer = useAudioPlayer(require('../../assets/beep.wav'));
  const goPlayer = useAudioPlayer(require('../../assets/go.wav'));

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [bufferedFrameCount, setBufferedFrameCount] = useState(0);
  const [countdownSecondsLeft, setCountdownSecondsLeft] = useState(0);
  const [capturePhase, setCapturePhase] = useState<CapturePhase>('idle');
  const [statusMessage, setStatusMessage] = useState(
    'Press Start Swing Capture to run the beep → go → capture flow.'
  );
  const [capturedAnalysis, setCapturedAnalysis] = useState<AnalysisResult | null>(null);

  const motionFramesRef = useRef<PoseFrame[]>([]);
  const providerRef = useRef(new MLKitProvider());
  const capturePhaseRef = useRef<CapturePhase>('idle');
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function updateCapturePhase(nextPhase: CapturePhase) {
    capturePhaseRef.current = nextPhase;
    setCapturePhase(nextPhase);
  }

  function clearTimers() {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }

    if (countdownTimeoutRef.current) {
      clearTimeout(countdownTimeoutRef.current);
      countdownTimeoutRef.current = null;
    }

    if (captureTimeoutRef.current) {
      clearTimeout(captureTimeoutRef.current);
      captureTimeoutRef.current = null;
    }
  }

  const appendPoseFrame = Worklets.createRunOnJS(
    async (
      landmarks: unknown,
      timestampMs: number,
      frameWidth: number,
      frameHeight: number
    ) => {
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
      setBufferedFrameCount(nextFrames.length);
    }
  );

  function finalizeCapture() {
    clearTimers();

    const frames = [...motionFramesRef.current];

    if (frames.length < MIN_FRAMES_FOR_ANALYSIS) {
      clearCurrentSwingMotion();
      clearCurrentSwingAnalysis();
      setCapturedAnalysis(null);
      updateCapturePhase('error');
      setStatusMessage(
        `Capture finished, but only ${frames.length} pose frames were detected. Need at least ${MIN_FRAMES_FOR_ANALYSIS}.`
      );
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

    console.log('[SWING_VALIDATION]', {
      frameCount: frames.length,
      durationMs: sequence.metadata?.durationMs,
      score: analysis.score,
      tempoRatio: analysis.tempo?.tempoRatio,
      hasAngles: !!analysis.angles,
      phases: analysis.phases?.length ?? 0,
    });

    setCurrentSwingMotion({
      frames,
      recordedAt: Date.now(),
      source: 'live-camera',
    });
    setCurrentSwingAnalysis(analysis);
    setCapturedAnalysis(analysis);
    updateCapturePhase('complete');
    setStatusMessage('Swing capture complete. Opening result screen.');

    router.push('/analysis/result');
  }

  function beginCaptureWindow() {
    motionFramesRef.current = [];
    setBufferedFrameCount(0);
    setCountdownSecondsLeft(0);
    updateCapturePhase('capturing');
    setStatusMessage('Go!');
    goPlayer.play();

    captureTimeoutRef.current = setTimeout(() => {
      finalizeCapture();
    }, CAPTURE_WINDOW_MS);
  }

  function startSwingCapture(mode: CaptureStartMode = 'countdown') {
    if (!hasPermission || !device) {
      setStatusMessage('Camera permission and a real camera device are required before capture.');
      return;
    }

    clearTimers();
    clearCurrentSwingMotion();
    clearCurrentSwingAnalysis();
    setCapturedAnalysis(null);
    motionFramesRef.current = [];
    setBufferedFrameCount(0);

    if (mode === 'instant') {
      beginCaptureWindow();
      return;
    }

    setCountdownSecondsLeft(3);
    updateCapturePhase('countdown');
    setStatusMessage('3');

    beepPlayer.play();

    countdownIntervalRef.current = setInterval(() => {
      setCountdownSecondsLeft((current) => {
        const next = current - 1;

        if (next > 0) {
          setStatusMessage(String(next));
          beepPlayer.play();
          return next;
        }

        if (countdownIntervalRef.current) {
          clearInterval(countdownIntervalRef.current);
          countdownIntervalRef.current = null;
        }

        return 0;
      });
    }, 1000);

    countdownTimeoutRef.current = setTimeout(() => {
      beginCaptureWindow();
    }, COUNTDOWN_MS);
  }

  useEffect(() => {
    let mounted = true;

    motionFramesRef.current = [];
    setBufferedFrameCount(0);
    clearCurrentSwingMotion();
    clearCurrentSwingAnalysis();

    async function setupScreen() {
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: 'doNotMix',
      });

      const status = await Camera.getCameraPermissionStatus();
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

  async function requestPermission() {
    const status = await Camera.requestCameraPermission();
    setHasPermission(status === 'granted');
  }

  const device = useCameraDevice('back');

  const capturePhaseLabel = useMemo(() => {
    switch (capturePhase) {
      case 'idle':
        return 'Idle';
      case 'countdown':
        return countdownSecondsLeft > 0 ? String(countdownSecondsLeft) : 'Get Ready';
      case 'capturing':
        return 'Capturing';
      case 'complete':
        return 'Complete';
      case 'error':
        return 'Error';
      default:
        return 'Unknown';
    }
  }, [capturePhase, countdownSecondsLeft]);

  const statusDetail = useMemo(() => {
    if (capturePhase === 'complete' && capturedAnalysis) {
      return `Captured ${bufferedFrameCount} frames. Score ${capturedAnalysis.score}.`;
    }

    if (capturePhase === 'capturing') {
      return 'Hold steady through the swing window.';
    }

    if (capturePhase === 'countdown') {
      return 'Get into position before Go.';
    }

    if (capturePhase === 'idle') {
      return 'Ready when you are.';
    }

    return statusMessage;
  }, [bufferedFrameCount, capturePhase, capturedAnalysis, statusMessage]);

  const isCaptureBusy = capturePhase === 'countdown' || capturePhase === 'capturing';

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

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      showsVerticalScrollIndicator={false}
      scrollEnabled={!isCaptureBusy}
    >
      <Text style={styles.title}>Record</Text>

      <Text style={styles.subtitle}>Line up the golfer, then start the capture flow.</Text>

      {hasPermission && device ? (
        <View style={styles.cameraFrame}>
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={true}
            photo={false}
            video={true}
            audio={false}
            frameProcessor={frameProcessor}
          />
          {capturePhase === 'countdown' && countdownSecondsLeft > 0 ? (
            <View style={styles.countdownOverlay}>
              <Text style={styles.countdownOverlayText}>{countdownSecondsLeft}</Text>
            </View>
          ) : null}
          {capturePhase === 'capturing' ? (
            <View style={styles.goOverlay}>
              <Text style={styles.goOverlayText}>GO</Text>
            </View>
          ) : null}
        </View>
      ) : (
        <View style={styles.placeholderFrame}>
          <Text style={styles.placeholderText}>
            {hasPermission
              ? 'No camera device available here. Use a real iPhone for live camera preview and pose detection.'
              : 'Camera preview unavailable'}
          </Text>
        </View>
      )}

      <View style={styles.analysisCard}>
        <Text style={styles.analysisTitle}>Capture Status</Text>
        <Text style={styles.phasePill}>{capturePhaseLabel}</Text>
        <Text style={styles.analysisText}>{statusMessage}</Text>
        <Text style={styles.statusDetailText}>{statusDetail}</Text>
      </View>

      <View style={styles.buttonGroup}>
        {!hasPermission && (
          <Button title="Request Camera Permission" onPress={requestPermission} />
        )}
        <Button
          title={isCaptureBusy ? 'Swing Capture In Progress...' : 'Start Swing Capture (3s)'}
          onPress={() => startSwingCapture('countdown')}
          disabled={isCaptureBusy || !hasPermission || !device}
        />
        <Button
          title={isCaptureBusy ? 'Swing Capture In Progress...' : 'Start Instant Capture'}
          onPress={() => startSwingCapture('instant')}
          disabled={isCaptureBusy || !hasPermission || !device}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  title: {
    color: Colors.text,
    fontSize: 24,
    marginBottom: 16,
  },
  subtitle: {
    color: Colors.text,
    fontSize: 16,
    marginBottom: 16,
  },
  cameraFrame: {
    width: '100%',
    aspectRatio: 9 / 16,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#000',
    marginBottom: 20,
  },
  countdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
  },
  countdownOverlayText: {
    color: '#FFFFFF',
    fontSize: 96,
    fontWeight: '700',
  },
  goOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  goOverlayText: {
    color: '#FFFFFF',
    fontSize: 120,
    fontWeight: '700',
    letterSpacing: 1,
  },
  placeholderFrame: {
    width: '100%',
    aspectRatio: 9 / 16,
    borderRadius: 16,
    backgroundColor: Colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    padding: 16,
  },
  placeholderText: {
    color: Colors.text,
    fontSize: 16,
    textAlign: 'center',
  },
  analysisCard: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
  },
  analysisTitle: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  phasePill: {
    color: Colors.background,
    backgroundColor: Colors.text,
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 12,
  },
  analysisText: {
    color: Colors.text,
    fontSize: 16,
    marginBottom: 8,
  },
  statusDetailText: {
    color: Colors.text,
    fontSize: 14,
    opacity: 0.8,
  },
  buttonGroup: {
    gap: 12,
  },
});
