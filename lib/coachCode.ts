import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './storageKeys';

const CODE_TO_NAME: Record<string, string> = {
  'dave': 'Dave Donnellan',
  'rafael': 'Rafael Test',
};

export async function getCoachCode(): Promise<string | null> {
  return AsyncStorage.getItem(STORAGE_KEYS.coachCode);
}

export async function setCoachCode(code: string): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.coachCode, code.toLowerCase().trim());
}

export async function clearCoachCode(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEYS.coachCode);
}

export function resolveCoachName(code: string | null): string | null {
  if (!code) return null;
  const key = code.toLowerCase().trim();
  return CODE_TO_NAME[key] ?? key;
}
