import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, getUser } from './supabase';
import { getSubscriptionStatus } from './purchases';
import { STORAGE_KEYS } from './storageKeys';

const FREE_SWING_LIMIT = 15;
const REFERRED_SWING_LIMIT = 50;
const WEEKS_LIMIT = 6;

export type SwingLimitStatus = {
  allowed: boolean;
  remaining: number;
  reason: 'ok' | 'swing_limit' | 'time_limit';
};

export async function incrementLocalSwingCount(): Promise<void> {
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.localSwingCount);
  const count = raw ? parseInt(raw, 10) : 0;
  await AsyncStorage.setItem(STORAGE_KEYS.localSwingCount, String(count + 1));
}

export async function checkSwingLimit(): Promise<SwingLimitStatus> {
  // Subscriber tier — unlimited swings (default-allow on error via getSubscriptionStatus)
  const isSubscribed = await getSubscriptionStatus();
  if (isSubscribed) {
    return { allowed: true, remaining: 9999, reason: 'ok' };
  }

  const user = await getUser();

  if (!user) {
    // Anonymous — count local swings against free limit
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.localSwingCount);
    const count = raw ? parseInt(raw, 10) : 0;
    const remaining = Math.max(0, FREE_SWING_LIMIT - count);
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

  // Determine limit tier based on referral status
  let limit = FREE_SWING_LIMIT;
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('referral_coach_id')
    .eq('id', user.id)
    .single();

  if (profileError) {
    console.error('[HoneySwing] profile lookup error:', profileError.message);
  } else if (profile?.referral_coach_id != null) {
    limit = REFERRED_SWING_LIMIT;
  }

  // Coach tier — unlimited swings
  const { data: coach, error: coachError } = await supabase
    .from('coaches')
    .select('id')
    .eq('auth_user_id', user.id)
    .single();

  if (coachError) {
    // Not a coach or query failed — fall through to normal limit logic
  } else if (coach) {
    return { allowed: true, remaining: 9999, reason: 'ok' };
  }

  // Authenticated — check swing count
  const { count, error } = await supabase
    .from('swings')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id);

  if (error) {
    console.error('[HoneySwing] swingLimit count error:', error.message);
    // Fail closed: use local swing count instead of allowing unlimited
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.localSwingCount);
    const localCount = raw ? parseInt(raw, 10) : 0;
    const fallbackRemaining = Math.max(0, limit - localCount);
    return {
      allowed: fallbackRemaining > 0,
      remaining: fallbackRemaining,
      reason: fallbackRemaining > 0 ? 'ok' : 'swing_limit',
    };
  }

  const swingCount = count ?? 0;
  const remaining = Math.max(0, limit - swingCount);
  return {
    allowed: remaining > 0,
    remaining,
    reason: remaining > 0 ? 'ok' : 'swing_limit',
  };
}
