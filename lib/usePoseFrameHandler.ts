import { useCallback, useRef } from 'react';
import { Worklets } from 'react-native-worklets-core';
import type { PoseFrame } from '../packages/pose/PoseTypes';
import { MLKitProvider } from '../packages/pose/providers/MLKitProvider';
import type { Landmark } from '../components/SkeletonOverlay';
import type { CapturePhase } from './useSwingCapture';
import {
  extractShoulderSeparation,
  emaSmooth,
  classifyCameraAngle,
  type CameraGuidanceColor,
} from './cameraGuidance';

// ─── Constants ──────────────────────────────────────────────────────────────

const STALE_LANDMARK_MS = 400;

// ─── Capture Frame Stats ────────────────────────────────────────────────────

export interface CaptureFrameStats {
  total_callbacks: number;
  nonzero_landmark_frames: number;
}

let totalCallbacks = 0;
let nonzeroLandmarkFrames = 0;

export function resetCaptureFrameStats(): void {
  totalCallbacks = 0;
  nonzeroLandmarkFrames = 0;
}

export function getCaptureFrameStats(): CaptureFrameStats {
  return {
    total_callbacks: totalCallbacks,
    nonzero_landmark_frames: nonzeroLandmarkFrames,
  };
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface UsePoseFrameHandlerOptions {
  skeletonUpdateRef: React.MutableRefObject<((lms: Landmark[]) => void) | null>;
  capturePhaseRef: React.MutableRefObject<CapturePhase>;
  bufferPoseFrame: (frame: PoseFrame) => void;
  smoothedSepRef: React.MutableRefObject<number | null>;
  frameAspectRef: React.MutableRefObject<number>;
  setFrameAspectState: (v: number) => void;
  setGuidanceColor: (c: CameraGuidanceColor | null) => void;
  setGuidanceLabel: (l: string | null) => void;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function usePoseFrameHandler({
  skeletonUpdateRef,
  capturePhaseRef,
  bufferPoseFrame,
  smoothedSepRef,
  frameAspectRef,
  setFrameAspectState,
  setGuidanceColor,
  setGuidanceLabel,
}: UsePoseFrameHandlerOptions) {
  const providerRef = useRef(new MLKitProvider());
  const frameCountRef = useRef(0);
  const lastGoodLandmarksRef = useRef<Landmark[] | null>(null);
  const lastGoodTimestampRef = useRef(0);

  const updateLandmarks = useCallback((lms: Landmark[]) => {
    skeletonUpdateRef.current?.(lms);
  }, []);

  // useRef (not top-level call) — React may drop memoized values across renders,
  // which would silently create a new Worklets bridge while the worklet closure
  // still holds the old (dead) one.  useRef is a true identity guarantee.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appendPoseFrameRef = useRef<any>(null);
  if (appendPoseFrameRef.current === null) {
    appendPoseFrameRef.current = Worklets.createRunOnJS(
      async (
        landmarks: unknown,
        timestampMs: number,
        frameWidth: number,
        frameHeight: number,
        aspect: number
      ) => {
        frameCountRef.current += 1;
        totalCallbacks += 1;

        // Surface native-side diagnostics
        const firstLandmark = Array.isArray(landmarks) && landmarks.length === 1 ? landmarks[0] as Record<string, unknown> : null;
        if (firstLandmark && '_diagnostic' in firstLandmark && firstLandmark._diagnostic) {
          if (frameCountRef.current % 60 === 1) {
            console.warn('[HoneySwing] NATIVE DIAGNOSTIC: ' + String(firstLandmark._diagnostic));
          }
          return;
        }

        if (frameCountRef.current % 30 === 1) {
          console.log('[PoseLive] frame=' + frameCountRef.current + ' landmarks=' + (Array.isArray(landmarks) ? landmarks.length : 'not-array') + ' phase=' + capturePhaseRef.current);
        }

        // Store frameAspect in ref and state from first valid frame (once only)
        if (aspect > 0 && frameAspectRef.current === 0) {
          frameAspectRef.current = aspect;
          setFrameAspectState(aspect);
        }

        // Skeleton update + dropout fallback
        if (Array.isArray(landmarks) && landmarks.length > 0) {
          nonzeroLandmarkFrames += 1;
          lastGoodLandmarksRef.current = landmarks as Landmark[];
          lastGoodTimestampRef.current = Date.now();
          updateLandmarks(landmarks as Landmark[]);

          // Camera guidance: update EMA shoulder separation during pre-recording
          if (capturePhaseRef.current === 'idle' || capturePhaseRef.current === 'countdown') {
            const sep = extractShoulderSeparation(landmarks as Landmark[]);
            if (sep !== null) {
              const smoothed = emaSmooth(smoothedSepRef.current, sep);
              smoothedSepRef.current = smoothed;
              const result = classifyCameraAngle(smoothed);
              setGuidanceColor(result.color);
              setGuidanceLabel(result.label);
            }
          }
        } else if (
          lastGoodLandmarksRef.current &&
          (Date.now() - lastGoodTimestampRef.current) < STALE_LANDMARK_MS
        ) {
          updateLandmarks(lastGoodLandmarksRef.current);
        }

        if (capturePhaseRef.current !== 'capturing') {
          if (frameCountRef.current % 30 === 1) {
            console.log('[PoseSkipPhase] frame=' + frameCountRef.current + ' phase=' + capturePhaseRef.current);
          }
          return;
        }

        const poseFrame = await providerRef.current.detectFromFrame?.({
          frame: landmarks,
          timestampMs,
          frameWidth,
          frameHeight,
        });

        if (poseFrame) bufferPoseFrame(poseFrame);
      }
    );
  }

  return { appendPoseFrame: appendPoseFrameRef.current! };
}
