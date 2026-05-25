import { supabase } from './supabase';
import type { Rtmw133Frame } from '../packages/pose/rtmw/Rtmw133Frame';

export const POSE_SOURCE_TAG = 'rtmw-l-2d-v1';

export async function persistPoseFull(swingId: string, frames: Rtmw133Frame[]): Promise<void> {
  try {
    await supabase
      .from('swings')
      .update({ pose_full: frames, pose_source: POSE_SOURCE_TAG })
      .eq('id', swingId);
  } catch (err) {
    console.error('[HoneySwing] persistPoseFull error:', err);
  }
}
