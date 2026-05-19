import { NativeModules, Alert, Platform } from 'react-native';

type LiDARDemoModule = {
  isAvailable: () => Promise<boolean>;
  present: () => Promise<void>;
};

const native: LiDARDemoModule | undefined = NativeModules.HoneyLiDARDemoModule;

export async function isLiDARAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios' || !native) return false;
  try {
    return await native.isAvailable();
  } catch {
    return false;
  }
}

export async function presentLiDARDemo(): Promise<void> {
  if (Platform.OS !== 'ios' || !native) {
    Alert.alert('Unavailable', 'LiDAR demo is iOS-only.');
    return;
  }
  const available = await isLiDARAvailable();
  if (!available) {
    Alert.alert(
      'No LiDAR sensor',
      'This device does not have LiDAR depth sensing. Requires iPhone 12 Pro or later, or iPad Pro 2020 or later.'
    );
    return;
  }
  try {
    await native.present();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    Alert.alert('Could not open LiDAR Demo', message);
  }
}
