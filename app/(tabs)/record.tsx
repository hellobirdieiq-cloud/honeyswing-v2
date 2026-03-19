import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { useRouter } from 'expo-router';
import { Camera, useCameraDevice, useFrameProcessor } from 'react-native-vision-camera';
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

const MAX_BUFFERED_POSE_FRAMES = 180;
const MIN_FRAMES_FOR_ANALYSIS = 6;
const CAPTURE_WINDOW_MS = 4000;

type CapturePhase = 'idle' | 'capturing' | 'complete' | 'error';

export default function RecordTab() {
  const router = useRouter();
  const goPlayer = useAudioPlayer(require('../../assets/go.wav'));

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturePhase, setCapturePhase] = useState<CapturePhase>('idle');

  const motionFramesRef = useRef<PoseFrame[]>([]);
  const providerRef = useRef(new MLKitProvider());
  const capturePhaseRef = useRef<CapturePhase>('idle');
  const captureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function updateCapturePhase(nextPhase: CapturePhase) {
    capturePhaseRef.current = nextPhase;
    setCapturePhase(nextPhase);
  }

  function clearTimers() {
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
    }
  );

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

  function startSwingCapture() {
    if (!hasPermission || !device || !cameraReady) return;

    clearTimers();
    clearCurrentSwingMotion();
    clearCurrentSwingAnalysis();
    motionFramesRef.current = [];

    updateCapturePhase('capturing');
    goPlayer.play();

    captureTimeoutRef.current = setTimeout(() => {
      finalizeCapture();
    }, CAPTURE_WINDOW_MS);
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

  const device = useCameraDevice('back');

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
  const isCapturing = capturePhase === 'capturing';
  const isInitializing = hasPermission === null || (showCamera && !cameraReady);
  const canRecord = cameraReady && !isCapturing;

  return (
    <View style={styles.container}>
      {showCamera ? (
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={true}
          photo={false}
          video={true}
          audio={false}
          frameProcessor={frameProcessor}
          onInitialized={() => setCameraReady(true)}
        />
      ) : (
        <View style={styles.placeholder}>
          <ActivityIndicator size="large" color="#F5A623" />
          <Text style={styles.placeholderText}>
            {hasPermission === false ? 'Camera permission denied' : 'Starting camera...'}
          </Text>
        </View>
      )}

      {/* Overlay */}
      <View style={styles.overlay}>
        {isInitializing ? (
          <View style={styles.recordingIndicator}>
            <ActivityIndicator size="small" color="#F5A623" />
            <Text style={styles.recordingText}>Preparing camera...</Text>
          </View>
        ) : isCapturing ? (
          <View style={styles.recordingIndicator}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingText}>Recording...</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.recordButton, !canRecord && styles.recordButtonDisabled]}
            onPress={startSwingCapture}
            disabled={!canRecord}
            activeOpacity={0.7}
          >
            <Text style={styles.recordButtonText}>Record</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
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
  overlay: {
    position: 'absolute',
    bottom: 100,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  recordButton: {
    backgroundColor: '#F5A623',
    paddingVertical: 16,
    paddingHorizontal: 48,
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
  recordingDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#FF3B30',
    marginRight: 8,
  },
  recordingText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
});