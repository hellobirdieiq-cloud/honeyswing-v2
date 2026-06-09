import { supabase } from './supabase';

// ≥ 1hr — outlives a viewing session, so the URL is generated ONCE per screen
// open and never refreshed per render/seek.
const SIGNED_URL_TTL_S = 3600;

/**
 * Resolve a swing's uploaded video (private `swing-videos` bucket) into a
 * playable signed URL. `storagePath` is the object key persisted in
 * swings.video_storage_path by uploadSwingVideo.ts (`${userId}/${swingId}.mov`).
 * Returns null on any failure (logged). Never throws.
 */
export async function getSwingVideoSignedUrl(storagePath: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage
      .from('swing-videos')
      .createSignedUrl(storagePath, SIGNED_URL_TTL_S);
    if (error) {
      console.warn('[HoneySwing] getSwingVideoSignedUrl error:', error.message);
      return null;
    }
    return data?.signedUrl ?? null;
  } catch (err) {
    console.warn('[HoneySwing] getSwingVideoSignedUrl error:', err);
    return null;
  }
}
