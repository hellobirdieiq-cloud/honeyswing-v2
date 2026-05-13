import React, { useState } from 'react';
import { Dimensions, Pressable, ScrollView, Text, View } from 'react-native';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';
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
const AVAIL_W = SCREEN_W - 64;
const PANEL_H = 80;
const Y_AXIS_PAD_RATIO = 0.1;
const SEGMENT_OVERFLOW_THRESHOLD = 4;

interface PanelProps {
  label: string;
  values: number[];
  colors: string[];
  boundaryLocal: number;
  boundaryFrameAbs: number;
  phaseChangeXs: number[];
  zeroBaseline: boolean;
  barW: number;
  barPitch: number;
}

function WindowPanel({
  label,
  values,
  colors,
  boundaryLocal,
  boundaryFrameAbs,
  phaseChangeXs,
  zeroBaseline,
  barW,
  barPitch,
}: PanelProps): React.ReactElement {
  const rawMin = values.length > 0 ? Math.min(...values) : 0;
  const rawMax = values.length > 0 ? Math.max(...values) : 1;
  const range = rawMax - rawMin || 1;
  const yMin = rawMin - range * Y_AXIS_PAD_RATIO;
  const yMax = rawMax + range * Y_AXIS_PAD_RATIO;
  const yToPx = (y: number): number => PANEL_H - ((y - yMin) / (yMax - yMin)) * PANEL_H;
  const baseY = PANEL_H;
  const centerX = boundaryLocal * barPitch + barW / 2;

  return (
    <View style={{ marginBottom: 8 }}>
      <Text style={styles.rawDebugMono}>{label}</Text>
      <Svg width={AVAIL_W} height={PANEL_H + 14}>
        {zeroBaseline && yMin <= 0 && yMax >= 0 ? (
          <Line
            x1={0}
            y1={yToPx(0)}
            x2={AVAIL_W}
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
              x={i * barPitch}
              y={y}
              width={barW}
              height={h}
              fill={colors[i]}
            />
          );
        })}
        {phaseChangeXs.map((x, i) => (
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
        <Line
          x1={centerX}
          y1={0}
          x2={centerX}
          y2={PANEL_H}
          stroke="#FFFFFF"
          strokeWidth={1.5}
        />
        <SvgText
          x={centerX}
          y={PANEL_H + 12}
          fill="#FFFFFF"
          fontSize={10}
          textAnchor="middle"
        >
          {`f${boundaryFrameAbs}`}
        </SvgText>
      </Svg>
    </View>
  );
}

export default function Tab4BoundaryInspector({ frames, phaseTags, handedness }: Props): React.ReactElement {
  const [transitionIdx, setTransitionIdx] = useState(0);
  const signals = computeTab4Signals(frames, phaseTags, handedness, { collapseAddress: false });

  const transitions = phaseTags.slice(0, -1).map((tag, i) => ({
    label: `${tag.phase[0].toUpperCase()}→${phaseTags[i + 1].phase[0].toUpperCase()}`,
    boundaryFrame: phaseTags[i + 1].startFrameIndex,
    fromPhase: tag.phase,
    toPhase: phaseTags[i + 1].phase,
  }));

  if (transitions.length < 1) {
    return <Text style={styles.rawDebugMono}>(insufficient phase tags)</Text>;
  }

  const safeIdx = Math.min(transitionIdx, transitions.length - 1);
  const active = transitions[safeIdx];
  const boundary = active.boundaryFrame;
  const windowStart = Math.max(0, boundary - 6);
  const windowEnd = Math.min(frames.length - 1, boundary + 6);
  const windowLen = windowEnd - windowStart + 1;

  const barW = Math.max(1, Math.floor(AVAIL_W / windowLen) - 2);
  const barPitch = barW + 2;

  const windowTrailX = signals.trailX.slice(windowStart - signals.startIdx, windowEnd - signals.startIdx + 1);
  const windowTrailY = signals.trailY.slice(windowStart - signals.startIdx, windowEnd - signals.startIdx + 1);
  const windowHipDelta = signals.hipDelta.slice(windowStart - signals.startIdx, windowEnd - signals.startIdx + 1);
  const windowWristDX = signals.wristDX.slice(windowStart - signals.startIdx, windowEnd - signals.startIdx + 1);

  const colors: string[] = [];
  for (let absIdx = windowStart; absIdx <= windowEnd; absIdx++) {
    const phase = signals.indexToPhase[absIdx];
    colors.push(phase ? PHASE_COLORS[phase] ?? '#444444' : '#444444');
  }

  const phaseChangeXs: number[] = [];
  for (let i = 1; i < windowLen; i++) {
    const prevPhase = signals.indexToPhase[windowStart + i - 1];
    const curPhase = signals.indexToPhase[windowStart + i];
    if (prevPhase !== curPhase) {
      phaseChangeXs.push(i * barPitch);
    }
  }

  const boundaryLocal = boundary - windowStart;
  const overflow = transitions.length > SEGMENT_OVERFLOW_THRESHOLD;

  const segmentRow = (
    <View style={styles.segmentedControl}>
      {transitions.map((t, i) => (
        <Pressable
          key={i}
          onPress={() => setTransitionIdx(i)}
          style={[styles.segmentButton, i === safeIdx ? styles.segmentButtonActive : null]}
          accessibilityRole="button"
        >
          <Text style={{ color: i === safeIdx ? '#000' : '#FFF', fontWeight: '600', fontSize: 12 }}>
            {t.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <View>
      {overflow ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {segmentRow}
        </ScrollView>
      ) : (
        segmentRow
      )}
      <View style={{ height: 8 }} />
      <WindowPanel
        label="trailX"
        values={windowTrailX}
        colors={colors}
        boundaryLocal={boundaryLocal}
        boundaryFrameAbs={boundary}
        phaseChangeXs={phaseChangeXs}
        zeroBaseline={false}
        barW={barW}
        barPitch={barPitch}
      />
      <WindowPanel
        label="trailY"
        values={windowTrailY}
        colors={colors}
        boundaryLocal={boundaryLocal}
        boundaryFrameAbs={boundary}
        phaseChangeXs={phaseChangeXs}
        zeroBaseline={false}
        barW={barW}
        barPitch={barPitch}
      />
      <WindowPanel
        label="hipDelta"
        values={windowHipDelta}
        colors={colors}
        boundaryLocal={boundaryLocal}
        boundaryFrameAbs={boundary}
        phaseChangeXs={phaseChangeXs}
        zeroBaseline={true}
        barW={barW}
        barPitch={barPitch}
      />
      <WindowPanel
        label="wristDX"
        values={windowWristDX}
        colors={colors}
        boundaryLocal={boundaryLocal}
        boundaryFrameAbs={boundary}
        phaseChangeXs={phaseChangeXs}
        zeroBaseline={true}
        barW={barW}
        barPitch={barPitch}
      />
    </View>
  );
}
