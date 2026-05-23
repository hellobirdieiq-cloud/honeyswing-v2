import { NativeModules } from 'react-native';
import type { AppleVisionHandResult } from './adapters/visionHandAdapter';

export type SegmentationResult = {
  // PNG of the captured photo re-rendered in display orientation
  // (imageOrientation == .up). Shares a coordinate space with every *MaskUri,
  // so the RN overlay no longer needs to reason about EXIF rotation.
  normalizedPhotoUri: string | null;
  appleSubjectMaskUri: string | null;
  applePersonMaskUri: string | null;
  mediapipeMaskUri: string | null;
  appleSubjectError?: string;
  applePersonError?: string;
  mediapipeError?: string;
  // 21-joint hand pose from VNDetectHumanHandPoseRequest, populated whenever
  // the Apple Subject path runs (even pre-iOS-17, when the mask is null).
  // [] when no hand detected.
  appleHandPose: AppleVisionHandResult;
  appleHandPoseError?: string;
};

type HoneyHandSegmenterPluginModule = {
  segmentHandInPhoto(photoUri: string): Promise<SegmentationResult>;
  probeMediaPipeInit(): Promise<{ ok: boolean }>;
};

const { HoneyHandSegmenterPlugin } = NativeModules as {
  HoneyHandSegmenterPlugin?: HoneyHandSegmenterPluginModule;
};

export function segmentHand(photoUri: string): Promise<SegmentationResult> {
  if (!HoneyHandSegmenterPlugin) {
    return Promise.reject(
      new Error('HoneyHandSegmenterPlugin native module is not linked'),
    );
  }
  return HoneyHandSegmenterPlugin.segmentHandInPhoto(photoUri);
}
