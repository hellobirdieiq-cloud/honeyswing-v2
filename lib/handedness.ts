import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'honeyswing:isLeftHanded';

export async function getIsLeftHanded(): Promise<boolean> {
  const value = await AsyncStorage.getItem(KEY);
  return value === 'true';
}
