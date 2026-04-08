import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './storageKeys';

export async function getIsLeftHanded(): Promise<boolean> {
  const value = await AsyncStorage.getItem(STORAGE_KEYS.isLeftHanded);
  return value === 'true';
}

export async function setIsLeftHanded(value: boolean): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.isLeftHanded, String(value));
}
