import { NativeModules } from 'react-native';

const { HoneyRtmwOneShotPlugin, HoneyAppleVisionBodyConfirmPlugin } = NativeModules;

export type RtmwKeypoint = {
  x: number;
  y: number;
  confidence: number;
};

export type RtmwFrame = {
  timestampMs: number;
  keypoints: RtmwKeypoint[];
  extractionMs: number;
};

export type BoundingBox = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type BodyConfirmResult = {
  humanPresent: boolean;
  humanBoundingBox: BoundingBox;
  bodyPoseConfidence: number;
};

export async function extractRtmw(
  videoUri: string,
  timestampsMs: number[],
  boundingBox: BoundingBox | null = null,
): Promise<RtmwFrame[]> {
  return HoneyRtmwOneShotPlugin.extractRtmwFromVideo(videoUri, timestampsMs, boundingBox);
}

export async function confirmBodyAtVideo(
  videoUri: string,
  timestampMs: number,
): Promise<BodyConfirmResult> {
  return HoneyAppleVisionBodyConfirmPlugin.confirmBodyAtVideo(videoUri, timestampMs);
}
