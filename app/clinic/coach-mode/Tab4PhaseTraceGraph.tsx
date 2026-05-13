import React from 'react';
import { Dimensions, ScrollView, Text, View } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';
import type { MotionFrame } from '@/lib/clinic/fetchMotionFrames';
import type { PhaseTagRange } from '@/packages/domain/clinic/SwingRecord';
import { styles } from '../clinicStyles';
import { PHASE_COLORS, computeTab4Signals } from './tab4Signals';

interface Props {
  frames: MotionFrame[];
  phaseTags: PhaseTagRange[];
  handedness: 'left' | 'right';
}

const SCREEN_W = Dimensions.get('window').width;
const BAR_W = 4;
const BAR_GAP = 2;
const BAR_PITCH = BAR_W + BAR_GAP;
const PANEL_H = 80;
const Y_AXIS_PAD_RATIO = 0.1;

interface PanelProps {
  label: string;
  values: number[];
  colors: string[];
  boundaryXs: number[];
  zeroBaseline: boolean;
  svgW: number;
}

function SignalPanel({ label, values, colors, boundaryXs, zeroBaseline, svgW }: PanelProps): React.ReactElement {
  const rawMin = values.length > 0 ? Math.min(...values) : 0;
  const rawMax = values.length > 0 ? Math.max(...values) : 1;
  const range = rawMax - rawMin || 1;
  const yMin = rawMin - range * Y_AXIS_PAD_RATIO;
  const yMax = rawMax + range * Y_AXIS_PAD_RATIO;
  const yToPx = (y: number): number => PANEL_H - ((y - yMin) / (yMax - yMin)) * PANEL_H;
  const baseY = PANEL_H;

  return (
    <View style={{ marginBottom: 8 }}>
      <Text style={styles.rawDebugMono}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Svg width={svgW} height={PANEL_H}>
          {zeroBaseline && yMin <= 0 && yMax >= 0 ? (
            <Line
              x1={0}
              y1={yToPx(0)}
              x2={svgW}
              y2={yToPx(0)}
              stroke="#444444"
              strokeWidth={1}
            />
          ) : null}
          {values.map((v, i) => {
            const top = yToPx(v);
            const bottom = zeroBaseline && yMin <= 0 && yMax >= 0 ? yToPx(0) : baseY;
            const y = Math.min(top, bottom);
            const h = Math.max(1, Math.abs(bottom - top));
            return (
              <Rect
                key={i}
                x={i * BAR_PITCH}
                y={y}
                width={BAR_W}
                height={h}
                fill={colors[i]}
              />
            );
          })}
          {boundaryXs.map((x, i) => (
            <Line
              key={`b-${i}`}
              x1={x}
              y1={0}
              x2={x}
              y2={PANEL_H}
              stroke="#FFFFFF"
              strokeOpacity={0.4}
              strokeWidth={1}
            />
          ))}
        </Svg>
      </ScrollView>
    </View>
  );
}

export default function Tab4PhaseTraceGraph({ frames, phaseTags, handedness }: Props): React.ReactElement {
  const signals = computeTab4Signals(frames, phaseTags, handedness, { collapseAddress: true });
  const svgW = Math.max(SCREEN_W - 64, signals.visibleFrames.length * BAR_PITCH);

  const colors = signals.visibleFrames.map((_, i) => {
    const absIdx = signals.startIdx + i;
    const phase = signals.indexToPhase[absIdx];
    return phase ? PHASE_COLORS[phase] ?? '#444444' : '#444444';
  });

  const boundaryXs: number[] = [];
  for (let n = 1; n < phaseTags.length; n++) {
    const localIdx = phaseTags[n].startFrameIndex - signals.startIdx;
    if (localIdx >= 0 && localIdx < signals.visibleFrames.length) {
      boundaryXs.push(localIdx * BAR_PITCH);
    }
  }

  return (
    <View>
      {signals.onset === null && (
        <Text style={styles.rawDebugMono}>(takeaway tag missing — address not collapsed)</Text>
      )}
      <SignalPanel
        label="trailX"
        values={signals.trailX}
        colors={colors}
        boundaryXs={boundaryXs}
        zeroBaseline={false}
        svgW={svgW}
      />
      <SignalPanel
        label="trailY"
        values={signals.trailY}
        colors={colors}
        boundaryXs={boundaryXs}
        zeroBaseline={false}
        svgW={svgW}
      />
      <SignalPanel
        label="hipDelta"
        values={signals.hipDelta}
        colors={colors}
        boundaryXs={boundaryXs}
        zeroBaseline={true}
        svgW={svgW}
      />
      <SignalPanel
        label="wristDX"
        values={signals.wristDX}
        colors={colors}
        boundaryXs={boundaryXs}
        zeroBaseline={true}
        svgW={svgW}
      />
    </View>
  );
}
