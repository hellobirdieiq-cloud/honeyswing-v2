import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, getUser } from './supabase';

const LOCAL_SWING_COUNT_KEY = 'honeyswing:localSwingCount';
const SWING_LIMIT = 600;
const WEEKS_LIMIT = 6;

export type SwingLimitStatus = {
  allowed: boolean;
  remaining: number;
  reason: 'ok' | 'swing_limit' | 'time_limit';
};

export async function incrementLocalSwingCount(): Promise<void> {
  const raw = await AsyncStorage.getItem(LOCAL_SWING_COUNT_KEY);
  const count = raw ? parseInt(raw, 10) : 0;
  await AsyncStorage.setItem(LOCAL_SWING_COUNT_KEY, String(count + 1));
}

export async function checkSwingLimit(): Promise<SwingLimitStatus> {
  const user = await getUser();

  if (!user) {
    // Anonymous — count local swings
    const raw = await AsyncStorage.getItem(LOCAL_SWING_COUNT_KEY);
    const count = raw ? parseInt(raw, 10) : 0;
    const remaining = Math.max(0, SWING_LIMIT - count);
    return {
      allowed: remaining > 0,
      remaining,
      reason: remaining > 0 ? 'ok' : 'swing_limit',
    };
  }

  // Authenticated — check time limit
  const createdAt = new Date(user.created_at);
  const expiresAt = new Date(createdAt.getTime() + WEEKS_LIMIT * 7 * 24 * 60 * 60 * 1000);
  if (Date.now() > expiresAt.getTime()) {
    return { allowed: false, remaining: 0, reason: 'time_limit' };
  }

  // Authenticated — check swing count
  const { count, error } = await supabase
    .from('swings')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id);

  if (error) {
    console.error('[HoneySwing] swingLimit count error:', error.message);
    return { allowed: true, remaining: SWING_LIMIT, reason: 'ok' };
  }

  const swingCount = count ?? 0;
  const remaining = Math.max(0, SWING_LIMIT - swingCount);
  return {
    allowed: remaining > 0,
    remaining,
    reason: remaining > 0 ? 'ok' : 'swing_limit',
  };
}
