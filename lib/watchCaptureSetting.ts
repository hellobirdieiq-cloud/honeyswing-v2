import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './storageKeys';

/**
 * "Apple Watch capture (beta)" toggle. Mirrors lib/handedness.ts: AsyncStorage +
 * centralized key. Absent key ⇒ `=== 'true'` is false ⇒ DEFAULT OFF. When off, the
 * watch capture hook never touches the native WCSession module (zero watch paths).
 */
export async function getWatchCaptureEnabled(): Promise<boolean> {
  const value = await AsyncStorage.getItem(STORAGE_KEYS.appleWatchCapture);
  return value === 'true';
}

export async function setWatchCaptureEnabled(value: boolean): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.appleWatchCapture, String(value));
}
