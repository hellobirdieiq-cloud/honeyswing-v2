import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { FunctionsFetchError } from '@supabase/supabase-js';
import { supabase } from './supabase';
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

  // 3. Get handedness (auth is injected by supabase client's clerkFetch)
  const isLeftHanded = await getIsLeftHanded();

  // 4. Invoke edge function with 10s timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let result: Awaited<
    ReturnType<
      typeof supabase.functions.invoke<{
        success?: boolean;
        classification?: GripClassification;
      }>
    >
  >;
  try {
    result = await supabase.functions.invoke<{
      success?: boolean;
      classification?: GripClassification;
    }>('classify-grip', {
      body: {
        image_base64: imageBase64,
        handedness: isLeftHanded ? 'left' : 'right',
        ...(landmarks && landmarks.length > 0 ? { landmarks } : {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (result.error) {
    if (controller.signal.aborted) {
      throw new GripClassifyError('timeout');
    }
    if (result.error instanceof FunctionsFetchError) {
      throw new GripClassifyError('network');
    }
    throw new GripClassifyError('server');
  }

  const data = result.data;
  console.log('[classifyGrip] raw response:', JSON.stringify(data));

  if (!data || !data.success || !data.classification) {
    throw new GripClassifyError('server');
  }

  return data.classification;
}
