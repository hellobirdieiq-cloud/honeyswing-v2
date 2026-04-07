import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { SUPABASE_URL, SUPABASE_ANON_KEY, getSession } from './supabase';
import { getIsLeftHanded } from './handedness';

export interface GripClassification {
  lead_hand: 'weak' | 'neutral' | 'strong';
  trail_hand: 'over' | 'neutral' | 'under';
  hands_match: 'yes' | 'no';
  overall: 'needs_adjustment' | 'playable' | 'solid';
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  analysis_failed?: boolean;
}

export type GripError = 'timeout' | 'network' | 'server';

export class GripClassifyError extends Error {
  type: GripError;
  constructor(type: GripError, message?: string) {
    super(message ?? type);
    this.type = type;
  }
}

const TIMEOUT_MS = 10_000;

export async function classifyGrip(
  photoUri: string,
  landmarks?: unknown[],
): Promise<GripClassification> {
  // 1. Resize to ~800px width, JPEG 80%
  const resized = await manipulateAsync(
    photoUri,
    [{ resize: { width: 800 } }],
    { compress: 0.8, format: SaveFormat.JPEG },
  );

  // 2. Read as base64
  const imageBase64 = await FileSystem.readAsStringAsync(resized.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // 3. Get handedness and auth
  const isLeftHanded = await getIsLeftHanded();
  const session = await getSession();

  // 4. Build request
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_ANON_KEY,
  };
  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }

  // 5. POST with 10s timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/classify-grip`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        image_base64: imageBase64,
        handedness: isLeftHanded ? 'left' : 'right',
        ...(landmarks && landmarks.length > 0 ? { landmarks } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new GripClassifyError('timeout');
    }
    throw new GripClassifyError('network');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new GripClassifyError('server');
  }

  let body: { success?: boolean; classification?: GripClassification };
  try {
    body = await response.json();
  } catch {
    throw new GripClassifyError('server');
  }

  console.log('[classifyGrip] raw response:', JSON.stringify(body));

  if (!body.success || !body.classification) {
    throw new GripClassifyError('server');
  }

  return body.classification;
}
