import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './storageKeys';

const KEY = STORAGE_KEYS.isLeftHanded;

export async function getIsLeftHanded(): Promise<boolean> {
  const value = await AsyncStorage.getItem(KEY);
  return value === 'true';
}

export async function setIsLeftHanded(value: boolean): Promise<void> {
  await AsyncStorage.setItem(KEY, String(value));
}
