import React from 'react';
import { Text, View } from 'react-native';
import type { MotionFrame } from '@/lib/clinic/fetchMotionFrames';
import type { PhaseTagRange } from '@/packages/domain/clinic/SwingRecord';
import { styles } from '../clinicStyles';
import { PHASE_COLORS, computeTab4Signals } from './tab4Signals';

interface Props {
  frames: MotionFrame[];
  phaseTags: PhaseTagRange[];
  handedness: 'left' | 'right';
}

function pad3(n: number): string {
  const s = String(n);
  return s.length >= 3 ? s : ' '.repeat(3 - s.length) + s;
}

export default function Tab4PhaseTrace({ frames, phaseTags, handedness }: Props): React.ReactElement {
  const signals = computeTab4Signals(frames, phaseTags, handedness, { collapseAddress: true });

  return (
    <View>
      {signals.onset === null && (
        <Text style={styles.rawDebugMono}>(takeaway tag missing — full address shown)</Text>
      )}
      <Text style={styles.rawDebugMono}>  f#  | Wrist X | Wrist Y | Hip Δ  | dX    </Text>
      {signals.visibleFrames.map((_, i) => {
        const absIdx = signals.startIdx + i;
        const phase = signals.indexToPhase[absIdx];
        const color = phase ? PHASE_COLORS[phase] ?? '#444444' : '#444444';
        const hd = signals.hipDelta[i];
        const dx = signals.wristDX[i];
        const line =
          pad3(absIdx) +
          '  ' +
          signals.trailX[i].toFixed(3) +
          '  ' +
          signals.trailY[i].toFixed(3) +
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
