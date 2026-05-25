import { VisionCameraProxy, type Frame } from 'react-native-vision-camera';
import { NativeModules } from 'react-native';
export * from './rtmw';

const plugin = VisionCameraProxy.initFrameProcessorPlugin('honeyPoseDetect', {});

export function honeyPoseDetect(frame: Frame): unknown[] {
  'worklet';

  if (plugin == null) {
    return ['PLUGIN_NULL'];
  }

  const result = plugin.call(frame) as unknown[];
  return Array.isArray(result) ? result : [];
}

const { HoneyGripBridge } = NativeModules;

export async function classifyGripFrames(params: {
  timestamps: number[];
  wristX: number[];
  wristY: number[];
}): Promise<Record<string, unknown>[] | null> {
  return HoneyGripBridge.classifyGripFrames(params);
}

export async function releaseGripBuffer(): Promise<void> {
  return HoneyGripBridge.releaseGripBuffer();
}