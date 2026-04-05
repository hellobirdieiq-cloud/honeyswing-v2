import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, getUserId } from './supabase';
import { setCoachCode } from './coachCode';
import { STORAGE_KEYS } from './storageKeys';

const PENDING_KEY = STORAGE_KEYS.pendingReferralCode;

export async function storePendingReferral(code: string): Promise<void> {
  await AsyncStorage.setItem(PENDING_KEY, code.toLowerCase().trim());
}

export async function commitPendingReferral(): Promise<void> {
  const pendingCode = await AsyncStorage.getItem(PENDING_KEY);
  if (!pendingCode) return;

  const userId = await getUserId();
  if (!userId) return;

  const { data: profile, error: fetchError } = await supabase
    .from('profiles')
    .select('referral_coach_id')
    .eq('id', userId)
    .single();

  if (fetchError) {
    console.error('[HoneySwing] referral fetch error:', fetchError.message);
    return;
  }

  if (profile?.referral_coach_id) {
    await AsyncStorage.removeItem(PENDING_KEY);
    return;
  }

  const { data: coach, error: coachError } = await supabase
    .from('coaches')
    .select('id')
    .eq('code', pendingCode)
    .single();

  if (coachError || !coach) {
    console.error('[HoneySwing] coach lookup failed:', coachError?.message ?? 'not found');
    return;
  }

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ referral_coach_id: coach.id })
    .eq('id', userId);

  if (updateError) {
    console.error('[HoneySwing] referral update error:', updateError.message);
    return;
  }

  await AsyncStorage.removeItem(PENDING_KEY);
  await setCoachCode(pendingCode);
}

export async function handleReferralUrl(url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/');
    if (segments.length < 3 || segments[1] !== 'r' || !segments[2]) return;
    const code = segments[2];
    await storePendingReferral(code);
    await commitPendingReferral();
  } catch {
    // malformed URL — ignore
  }
}
