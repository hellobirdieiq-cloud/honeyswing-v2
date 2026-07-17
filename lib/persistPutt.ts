/**
 * persistPutt.ts — thin putt-row persistence (Phase C, D1 option b).
 *
 * Deliberately NOT persistSwing: that path fires full-swing capture-side
 * machinery (sessionAccumulator, swing.recorded emit, tip-frequency /
 * positiveReinforcement debug). This writes one swings row built by the pure
 * buildPuttRow (analysis_version 'putt-v1' discriminator) and nothing else.
 *
 * SIGNED-OUT PUTTS ARE NOT PERSISTED in v1 (no queue-until-login hold for
 * putts yet — future work; the result screen still renders from the
 * in-memory store). Signed-in putts increment the local swing counter for
 * parity with the DB row count: putts counting toward the free swing limit
 * is ACCEPTED v1 behavior (owner directive) — the limit's count query is
 * deliberately untouched.
 */

import { supabase, getUserId } from './supabase';
import { ensureProfile } from './ensureProfile';
import { incrementLocalSwingCount } from './swingLimit';
import { buildPuttRow, type BuildPuttRowInput } from '@/packages/domain/putting/buildPuttRow';

export async function persistPutt(input: BuildPuttRowInput): Promise<string | null> {
  const authUserId = await getUserId();
  if (!authUserId) {
    console.log('[persistPutt] no user — putt not persisted (no hold path in v1)');
    return null;
  }

  const row = { ...buildPuttRow(input), user_id: authUserId };

  let data: { id: string } | null = null;
  let error: unknown = null;
  try {
    const res = await supabase.from('swings').insert(row).select('id').single();
    data = res.data;
    error = res.error;
    // FK self-heal (persistSwing #9 precedent): missing profiles row → create
    // and retry exactly once.
    if (res.error?.code === '23503') {
      const healed = await ensureProfile(authUserId);
      if (healed) {
        const retry = await supabase.from('swings').insert(row).select('id').single();
        data = retry.data;
        error = retry.error;
      }
    }
  } catch (e) {
    error = e;
  }
  if (error || !data?.id) {
    console.error('[persistPutt] insert failed:', error);
    return null;
  }

  // Local counter parity with the DB row (limit behavior — see header).
  try {
    await incrementLocalSwingCount();
  } catch (e) {
    console.error('[persistPutt] incrementLocalSwingCount failed', e);
  }

  console.log('[persistPutt] putt persisted', data.id);
  return data.id;
}
