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

    // Bounded retry: the previous fire-and-forget upload dropped ~8.5% of
    // videos on transient failures with no second chance. Retry within the
    // call; an already-exists error means a prior attempt landed (success).
    const MAX_ATTEMPTS = 3;
    let uploaded = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { error: uploadError } = await supabase.storage
        .from('swing-videos')
        .upload(storagePath, arrayBuffer, {
          contentType: 'video/quicktime',
          upsert: false,
        });

      if (!uploadError) {
        uploaded = true;
        break;
      }

      const msg = uploadError.message ?? '';
      const statusCode = (uploadError as { statusCode?: string }).statusCode;
      if (/exist|duplicate/i.test(msg) || statusCode === '409') {
        // Object already present from an earlier attempt — treat as uploaded.
        uploaded = true;
        break;
      }

      console.error(
        `[HoneySwing] uploadSwingVideo attempt ${attempt}/${MAX_ATTEMPTS} failed:`,
        JSON.stringify(uploadError, null, 2),
      );
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }

    if (!uploaded) return;

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
