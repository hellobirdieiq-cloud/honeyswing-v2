import { VisionCameraProxy, type Frame } from 'react-native-vision-camera';

export type { V1PoseLandmark as PoseLandmark } from '../../../packages/pose/PoseTypes';

const plugin = VisionCameraProxy.initFrameProcessorPlugin('honeyPoseDetect', {});

export function honeyPoseDetect(frame: Frame): unknown[] {
  'worklet';

  if (plugin == null) {
    return ['PLUGIN_NULL'];
  }

  return plugin.call(frame) as unknown[];
}