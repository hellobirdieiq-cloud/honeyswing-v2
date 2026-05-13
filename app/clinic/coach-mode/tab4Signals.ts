import type { MotionFrame } from '@/lib/clinic/fetchMotionFrames';
import type { PhaseTagRange } from '@/packages/domain/clinic/SwingRecord';

export const PHASE_COLORS: Record<string, string> = {
  address:   '#6E6E73',
  takeaway:  '#5AC8FA',
  top:       '#AF52DE',
  downswing: '#FF9F0A',
  impact:    '#FF3B30',
  finish:    '#34C759',
};

export interface Tab4Signals {
  startIdx: number;
  visibleFrames: MotionFrame[];
  indexToPhase: (string | undefined)[];
  trailX: number[];
  trailY: number[];
  hipDelta: number[];
  wristDX: number[];
  onset: number | null;
}

export function computeTab4Signals(
  frames: MotionFrame[],
  phaseTags: PhaseTagRange[],
  handedness: 'left' | 'right',
  options?: { collapseAddress?: boolean },
): Tab4Signals {
  const collapseAddress = options?.collapseAddress !== false;

  const indexToPhase: (string | undefined)[] = new Array(frames.length).fill(undefined);
  for (const tag of phaseTags) {
    const end = Math.min(tag.endFrameIndex, frames.length - 1);
    for (let i = tag.startFrameIndex; i <= end; i++) {
      if (i >= 0 && i < frames.length) indexToPhase[i] = tag.phase;
    }
  }

  const takeaway = phaseTags.find((p) => p.phase === 'takeaway');
  const onset = takeaway ? takeaway.startFrameIndex : null;
  const startIdx = collapseAddress && onset !== null ? Math.max(0, onset - 7) : 0;
  const visibleFrames = frames.slice(startIdx);

  const trailKey: 'leftWrist' | 'rightWrist' = handedness === 'right' ? 'rightWrist' : 'leftWrist';

  const trailX: number[] = visibleFrames.map((f) => f.joints[trailKey]?.x ?? 0);
  const trailY: number[] = visibleFrames.map((f) => f.joints[trailKey]?.y ?? 0);
  const hipSpread: number[] = visibleFrames.map(
    (f) => (f.joints.leftHip?.x ?? 0) - (f.joints.rightHip?.x ?? 0),
  );
  const hipDelta: number[] = hipSpread.map((v, i) => (i === 0 ? 0 : v - hipSpread[i - 1]));
  const wristDX: number[] = trailX.map((v, i) => (i === 0 ? 0 : v - trailX[i - 1]));

  return {
    startIdx,
    visibleFrames,
    indexToPhase,
    trailX,
    trailY,
    hipDelta,
    wristDX,
    onset,
  };
}
