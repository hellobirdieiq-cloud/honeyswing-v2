import { VisionCameraProxy, type Frame } from 'react-native-vision-camera';

const plugin = VisionCameraProxy.initFrameProcessorPlugin('honeyHandDetect', {});

export type HandLandmark = {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  visibility: number;
};

export type HandResult = {
  handIndex: number;
  label: string;
  score: number;
  landmarks: HandLandmark[];
  debugInferenceMs?: number;
  debugTotalMs?: number;
};

export function detectHands(frame: Frame): unknown[] {
  'worklet';

  if (plugin == null) {
    return ['PLUGIN_NULL'];
  }

  const result = plugin.call(frame) as unknown[];
  return Array.isArray(result) ? result : [];
}
