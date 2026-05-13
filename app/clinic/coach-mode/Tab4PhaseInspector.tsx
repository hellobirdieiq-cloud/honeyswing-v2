import React, { useState } from 'react';
import { Dimensions, Pressable, ScrollView, Text, View } from 'react-native';
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
  color: string;
  zeroBaseline: boolean;
  svgW: number;
}

function PhasePanel({ label, values, color, zeroBaseline, svgW }: PanelProps): React.ReactElement {
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
                fill={color}
              />
            );
          })}
        </Svg>
      </ScrollView>
    </View>
  );
}

export default function Tab4PhaseInspector({ frames, phaseTags, handedness }: Props): React.ReactElement {
  const [phaseIdx, setPhaseIdx] = useState(0);
  const phaseList = phaseTags;

  if (phaseList.length === 0) {
    return <Text style={styles.rawDebugMono}>(no phase tags)</Text>;
  }

  if (phaseIdx >= phaseList.length) {
    return <View />;
  }

  const selectedTag = phaseList[phaseIdx];
  const signals = computeTab4Signals(frames, phaseTags, handedness, { collapseAddress: false });

  const sliceStart = selectedTag.startFrameIndex;
  const sliceEnd = Math.min(selectedTag.endFrameIndex, frames.length - 1);
  const phaseFrames = frames.slice(sliceStart, sliceEnd + 1);

  const segmentRow = (
    <View style={styles.segmentedControl}>
      {phaseList.map((p, i) => (
        <Pressable
          key={i}
          onPress={() => setPhaseIdx(i)}
          style={[styles.segmentButton, i === phaseIdx ? styles.segmentButtonActive : null]}
          accessibilityRole="button"
        >
          <Text style={{ color: i === phaseIdx ? '#000' : '#FFF', fontWeight: '600', fontSize: 12 }}>
            {p.phase[0].toUpperCase()}
          </Text>
        </Pressable>
      ))}
    </View>
  );

  if (phaseFrames.length === 0) {
    return (
      <View>
        {segmentRow}
        <View style={{ height: 8 }} />
        <Text style={styles.rawDebugMono}>(no frames in this phase)</Text>
      </View>
    );
  }

  const sliceTrailX = signals.trailX.slice(sliceStart - signals.startIdx, sliceEnd - signals.startIdx + 1);
  const sliceTrailY = signals.trailY.slice(sliceStart - signals.startIdx, sliceEnd - signals.startIdx + 1);
  const sliceHipDelta = signals.hipDelta.slice(sliceStart - signals.startIdx, sliceEnd - signals.startIdx + 1);
  const sliceWristDX = signals.wristDX.slice(sliceStart - signals.startIdx, sliceEnd - signals.startIdx + 1);

  const color = PHASE_COLORS[selectedTag.phase] ?? '#444444';
  const svgW = Math.max(SCREEN_W - 64, phaseFrames.length * BAR_PITCH);

  return (
    <View>
      {segmentRow}
      <View style={{ height: 8 }} />
      <PhasePanel label="trailX" values={sliceTrailX} color={color} zeroBaseline={false} svgW={svgW} />
      <PhasePanel label="trailY" values={sliceTrailY} color={color} zeroBaseline={false} svgW={svgW} />
      <PhasePanel label="hipDelta" values={sliceHipDelta} color={color} zeroBaseline={true} svgW={svgW} />
      <PhasePanel label="wristDX" values={sliceWristDX} color={color} zeroBaseline={true} svgW={svgW} />
    </View>
  );
}
