import { VisionCameraProxy, type Frame } from 'react-native-vision-camera';

const plugin = VisionCameraProxy.initFrameProcessorPlugin('honeyPoseDetect', {});

export function honeyPoseDetect(frame: Frame): unknown[] {
  'worklet';

  if (plugin == null) {
    return ['PLUGIN_NULL'];
  }

  const result = plugin.call(frame) as unknown[];
  return Array.isArray(result) ? result : [];
}