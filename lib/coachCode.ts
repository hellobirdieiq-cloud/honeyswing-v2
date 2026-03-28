import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'honeyswing:coachCode';

const CODE_TO_NAME: Record<string, string> = {
  'dave': 'Dave Donnellan',
};

export async function getCoachCode(): Promise<string | null> {
  return AsyncStorage.getItem(KEY);
}

export async function setCoachCode(code: string): Promise<void> {
  await AsyncStorage.setItem(KEY, code.toLowerCase().trim());
}

export async function clearCoachCode(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}

export function resolveCoachName(code: string | null): string | null {
  if (!code) return null;
  return CODE_TO_NAME[code.toLowerCase().trim()] ?? null;
}
