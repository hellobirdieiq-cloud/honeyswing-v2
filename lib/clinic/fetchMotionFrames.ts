import { supabase } from '@/lib/supabase';

export interface MotionFrame {
  timestampMs: number;
  joints: {
    leftHip: { x: number; y: number; z: number };
    rightHip: { x: number; y: number; z: number };
    leftWrist: { x: number; y: number; z: number };
    rightWrist: { x: number; y: number; z: number };
    leftShoulder: { x: number; y: number; z: number };
    rightShoulder: { x: number; y: number; z: number };
    leftElbow: { x: number; y: number; z: number };
    rightElbow: { x: number; y: number; z: number };
    leftKnee: { x: number; y: number; z: number };
    rightKnee: { x: number; y: number; z: number };
    leftAnkle: { x: number; y: number; z: number };
    rightAnkle: { x: number; y: number; z: number };
  };
}

export interface FetchMotionFramesResult {
  frames: MotionFrame[] | null;
  handedness: 'left' | 'right' | null;
  msPerFrame: number | null;
  angleBucket: 'dtl' | 'face_on' | null;
}

const EMPTY: FetchMotionFramesResult = {
  frames: null,
  handedness: null,
  msPerFrame: null,
  angleBucket: null,
};

export async function fetchMotionFrames(
  swingId: string,
): Promise<FetchMotionFramesResult> {
  try {
    const { data, error } = await supabase
      .from('swings')
      .select('motion_frames, duration_ms, frame_count, swing_debug')
      .eq('id', swingId)
      .maybeSingle();

    if (error || !data) {
      if (error) console.warn('[fetchMotionFrames] failed:', error.message);
      return EMPTY;
    }

    const frames = (data.motion_frames as unknown as MotionFrame[] | null) ?? null;
    const debug = (data.swing_debug as unknown as Record<string, unknown> | null) ?? null;

    const rawHandedness = debug?.handedness;
    const handedness: 'left' | 'right' | null =
      rawHandedness === 'left' || rawHandedness === 'right' ? rawHandedness : null;

    const angleGating = debug?.angle_gating as Record<string, unknown> | undefined;
    const rawBucket = angleGating?.bucket;
    const angleBucket: 'dtl' | 'face_on' | null =
      rawBucket === 'dtl' ? 'dtl' :
      rawBucket === 'face_on' ? 'face_on' :
      rawBucket === 'oblique' ? 'dtl' :
      null;

    const frameCount = data.frame_count ?? 0;
    const durationMs = data.duration_ms ?? 0;
    const msPerFrame = frameCount > 0 && durationMs > 0 ? durationMs / frameCount : null;

    return { frames, handedness, msPerFrame, angleBucket };
  } catch (err) {
    console.warn('[fetchMotionFrames] failed:', err);
    return EMPTY;
  }
}
