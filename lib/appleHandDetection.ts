import { NativeModules } from 'react-native';

export type AppleJoint = {
  x: number;
  y: number;
  confidence: number;
};

export type AppleJointName =
  | 'wrist'
  | 'thumbCMC' | 'thumbMP' | 'thumbIP' | 'thumbTip'
  | 'indexMCP' | 'indexPIP' | 'indexDIP' | 'indexTip'
  | 'middleMCP' | 'middlePIP' | 'middleDIP' | 'middleTip'
  | 'ringMCP' | 'ringPIP' | 'ringDIP' | 'ringTip'
  | 'littleMCP' | 'littlePIP' | 'littleDIP' | 'littleTip';

export type AppleHand = {
  chirality: 'left' | 'right' | 'unknown';
  score: number;
  joints: Partial<Record<AppleJointName, AppleJoint>>;
};

type AppleHandPluginModule = {
  detectAppleHandInPhoto(photoUri: string): Promise<AppleHand[]>;
};

const { HoneyVisionAppleHandPlugin } = NativeModules as {
  HoneyVisionAppleHandPlugin?: AppleHandPluginModule;
};

export function detectAppleHand(photoUri: string): Promise<AppleHand[]> {
  if (!HoneyVisionAppleHandPlugin) {
    return Promise.reject(
      new Error('HoneyVisionAppleHandPlugin native module is not linked'),
    );
  }
  return HoneyVisionAppleHandPlugin.detectAppleHandInPhoto(photoUri);
}
