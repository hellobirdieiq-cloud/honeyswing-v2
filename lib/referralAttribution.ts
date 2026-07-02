import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, getUserId } from './supabase';
import { setCoachCode, clearCoachCode } from './coachCode';
import { STORAGE_KEYS } from './storageKeys';

export async function storePendingReferral(code: string): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEYS.pendingReferralCode, code.toLowerCase().trim());
}

/**
 * Whether the given Clerk auth user is a registered coach (drives the Coach
 * Mode entry in settings). Extracted VERBATIM from settings.tsx (Batch 5.3).
 * null/undefined authUserId (signed out) → false; query errors also resolve
 * false (data null), matching the original inline behavior.
 */
export async function checkIsCoach(authUserId: string | null | undefined): Promise<boolean> {
  if (!authUserId) return false;
  const { data } = await supabase
    .from('coaches')
    .select('id')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  return !!data;
}

let commitPromise: Promise<void> | null = null;

export function commitPendingReferral(): Promise<void> {
  if (commitPromise) return commitPromise;
  commitPromise = doCommitPendingReferral().finally(() => {
    commitPromise = null;
  });
  return commitPromise;
}

async function doCommitPendingReferral(): Promise<void> {
  const pendingCode = await AsyncStorage.getItem(STORAGE_KEYS.pendingReferralCode);
  if (!pendingCode) return;

  const userId = await getUserId();
  if (!userId) return;

  const { data: profile, error: fetchError } = await supabase
    .from('profiles')
    .select('referral_coach_id')
    .eq('id', userId)
    .maybeSingle();

  if (fetchError) {
    console.error('[HoneySwing] referral fetch error:', fetchError.message);
    return;
  }

  if (profile?.referral_coach_id) {
    await AsyncStorage.removeItem(STORAGE_KEYS.pendingReferralCode);
    return;
  }

  const { data: coach, error: coachError } = await supabase
    .from('coaches')
    .select('id, name')
    .eq('code', pendingCode)
    .single();

  if (coachError || !coach) {
    console.error('[HoneySwing] coach lookup failed:', coachError?.message ?? 'not found');
    await AsyncStorage.removeItem(STORAGE_KEYS.pendingReferralCode);
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

  await AsyncStorage.removeItem(STORAGE_KEYS.pendingReferralCode);
  await setCoachCode(coach.name ?? pendingCode);
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

export async function linkCoach(
  code: string,
): Promise<{ success: boolean; coachName?: string; error?: string }> {
  const normalized = code.toLowerCase().trim();
  if (!normalized) return { success: false, error: 'Enter a coach code' };

  const userId = await getUserId();
  if (!userId) return { success: false, error: 'Not signed in' };

  const { data: coach, error: coachError } = await supabase
    .from('coaches')
    .select('id, code, name')
    .eq('code', normalized)
    .single();

  if (coachError || !coach) return { success: false, error: 'Coach not found' };

  const { data: profile } = await supabase
    .from('profiles')
    .select('referral_coach_id')
    .eq('id', userId)
    .maybeSingle();

  if (profile?.referral_coach_id === coach.id) {
    return { success: false, error: 'Already linked to this coach' };
  }

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ referral_coach_id: coach.id })
    .eq('id', userId);

  if (updateError) return { success: false, error: 'Failed to link coach' };

  await setCoachCode(coach.name ?? normalized);

  return { success: true, coachName: coach.name ?? coach.code };
}

export async function unlinkCoach(): Promise<{ success: boolean; error?: string }> {
  const userId = await getUserId();
  if (!userId) return { success: false, error: 'Not signed in' };

  const { error: updateError } = await supabase
    .from('profiles')
    .update({ referral_coach_id: null })
    .eq('id', userId);

  if (updateError) return { success: false, error: 'Failed to remove coach' };

  await clearCoachCode();

  return { success: true };
}
