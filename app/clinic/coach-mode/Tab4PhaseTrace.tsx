import React from 'react';
import { Text, View } from 'react-native';
import type { MotionFrame } from '@/lib/clinic/fetchMotionFrames';
import type { PhaseTagRange } from '@/packages/domain/clinic/SwingRecord';
import { styles } from '../clinicStyles';

interface Props {
  frames: MotionFrame[];
  phaseTags: PhaseTagRange[];
  handedness: 'left' | 'right';
}

const PHASE_COLORS: Record<string, string> = {
  address:   '#6E6E73',
  takeaway:  '#5AC8FA',
  top:       '#AF52DE',
  downswing: '#FF9F0A',
  impact:    '#FF3B30',
  finish:    '#34C759',
};

function pad3(n: number): string {
  const s = String(n);
  return s.length >= 3 ? s : ' '.repeat(3 - s.length) + s;
}

export default function Tab4PhaseTrace({ frames, phaseTags, handedness }: Props): React.ReactElement {
  const indexToPhase: (string | undefined)[] = new Array(frames.length).fill(undefined);
  for (const tag of phaseTags) {
    const end = Math.min(tag.endFrameIndex, frames.length - 1);
    for (let i = tag.startFrameIndex; i <= end; i++) {
      if (i >= 0 && i < frames.length) indexToPhase[i] = tag.phase;
    }
  }

  const takeaway = phaseTags.find((p) => p.phase === 'takeaway');
  const onset = takeaway ? takeaway.startFrameIndex : null;
  const startIdx = onset !== null ? Math.max(0, onset - 7) : 0;
  const visibleFrames = frames.slice(startIdx);

  const trailKey: 'leftWrist' | 'rightWrist' = handedness === 'right' ? 'rightWrist' : 'leftWrist';

  const trailX: number[] = visibleFrames.map((f) => f.joints[trailKey]?.x ?? 0);
  const trailY: number[] = visibleFrames.map((f) => f.joints[trailKey]?.y ?? 0);
  const hipSpread: number[] = visibleFrames.map(
    (f) => (f.joints.leftHip?.x ?? 0) - (f.joints.rightHip?.x ?? 0),
  );
  const hipDelta: number[] = hipSpread.map((v, i) => (i === 0 ? 0 : v - hipSpread[i - 1]));
  const wristDX: number[] = trailX.map((v, i) => (i === 0 ? 0 : v - trailX[i - 1]));

  return (
    <View>
      {onset === null && (
        <Text style={styles.rawDebugMono}>(takeaway tag missing — full address shown)</Text>
      )}
      <Text style={styles.rawDebugMono}>  f#  | Wrist X | Wrist Y | Hip Δ  | dX    </Text>
      {visibleFrames.map((_, i) => {
        const absIdx = startIdx + i;
        const phase = indexToPhase[absIdx];
        const color = phase ? PHASE_COLORS[phase] ?? '#444444' : '#444444';
        const hd = hipDelta[i];
        const dx = wristDX[i];
        const line =
          pad3(absIdx) +
          '  ' +
          trailX[i].toFixed(3) +
          '  ' +
          trailY[i].toFixed(3) +
          '  ' +
          (hd >= 0 ? '+' : '') +
          hd.toFixed(4) +
          '  ' +
          (dx >= 0 ? '+' : '') +
          dx.toFixed(4);
        return (
          <View key={absIdx} style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ width: 6, height: 14, backgroundColor: color, marginRight: 6 }} />
            <Text style={styles.rawDebugMono}>{line}</Text>
          </View>
        );
      })}
    </View>
  );
}
