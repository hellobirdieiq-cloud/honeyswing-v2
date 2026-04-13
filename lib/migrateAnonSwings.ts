// lib/migrateAnonSwings.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { STORAGE_KEYS } from './storageKeys';

export async function migrateAnonSwings(userId: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.localSwingCount);
    const count = parseInt(raw ?? '0', 10);
    if (count <= 0) return;

    const { error } = await supabase
      .from('profiles')
      .update({ anonymous_swing_count: count })
      .eq('id', userId);

    if (error) {
      console.error('[migrateAnonSwings] write failed, will retry next sign-in:', error.message);
      return;
    }

    await AsyncStorage.removeItem(STORAGE_KEYS.localSwingCount);
    console.log(`[migrateAnonSwings] migrated ${count} anonymous swings`);
  } catch (err) {
    console.error('[migrateAnonSwings] unexpected error:', err);
  }
}