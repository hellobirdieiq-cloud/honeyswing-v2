import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './storageKeys';

export async function getCoachCode(): Promise<string | null> {
  return AsyncStorage.getItem(STORAGE_KEYS.coachCode);
}

export async function setCoachCode(code: string): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.coachCode, code.toLowerCase().trim());
}

export async function clearCoachCode(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEYS.coachCode);
}

