// lib/ensureProfile.ts
import { supabase } from './supabase';

export async function ensureProfile(userId: string): Promise<void> {
  const { error } = await supabase
    .from('profiles')
    .upsert({ id: userId }, { onConflict: 'id', ignoreDuplicates: true });

  if (error) {
    console.error('[HoneySwing] ensureProfile error:', error.message);
  }
}
