import { NativeModules } from 'react-native';
export * from './rtmw';

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