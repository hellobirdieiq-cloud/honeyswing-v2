import * as FileSystem from 'expo-file-system/legacy';
import { decode } from 'base64-arraybuffer';
import { supabase, getUserId, getSession } from './supabase';

export async function uploadSwingVideo(swingId: string, videoPath: string): Promise<void> {
  const userId = await getUserId();
  if (!userId) return; // anonymous user — skip upload

  const storagePath = `${userId}/${swingId}.mov`;

  try {
    const session = await getSession();
    if (!session) {
      console.error('[HoneySwing] uploadSwingVideo: no session');
      return;
    }

    const fileUri = videoPath.startsWith('file://') ? videoPath : `file://${videoPath}`;

    const base64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const arrayBuffer = decode(base64);

    const { error: uploadError } = await supabase.storage
      .from('swing-videos')
      .upload(storagePath, arrayBuffer, {
        contentType: 'video/quicktime',
        upsert: false,
      });

    if (uploadError) {
      console.error('[HoneySwing] uploadSwingVideo upload failed:', JSON.stringify(uploadError, null, 2));
      return;
    }

    const { error: updateError } = await supabase
      .from('swings')
      .update({
        video_storage_path: storagePath,
        video_uploaded_at: new Date().toISOString(),
      })
      .eq('id', swingId);

    if (updateError) {
      console.error('[HoneySwing] uploadSwingVideo update error:', updateError.message);
    } else {
      console.log('[HoneySwing] Video uploaded:', storagePath);
    }
  } catch (err) {
    console.error('[HoneySwing] uploadSwingVideo error:', err);
  }
}
