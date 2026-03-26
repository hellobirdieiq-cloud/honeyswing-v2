import * as FileSystem from 'expo-file-system/legacy';
import { supabase, getUserId, getSession, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase';

export async function uploadSwingVideo(swingId: string, videoPath: string): Promise<void> {
  const userId = await getUserId();
  if (!userId) return; // anonymous user — skip upload

  const storagePath = `${userId}/${swingId}.mov`;
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/swing-videos/${storagePath}`;

  try {
    const session = await getSession();
    if (!session) {
      console.error('[HoneySwing] uploadSwingVideo: no session');
      return;
    }

    const fileUri = videoPath.startsWith('file://') ? videoPath : `file://${videoPath}`;

    const result = await FileSystem.uploadAsync(uploadUrl, fileUri, {
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      httpMethod: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'video/quicktime',
      },
    });

    if (result.status < 200 || result.status >= 300) {
      console.error('[HoneySwing] uploadSwingVideo upload failed:', result.status, result.body);
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
