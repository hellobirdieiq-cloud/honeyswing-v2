import React, { useMemo } from 'react';
import { Dimensions, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import type { MotionFrame } from '@/lib/clinic/fetchMotionFrames';
import type { PhaseTagRange } from '@/packages/domain/clinic/SwingRecord';
import { GOLD } from '@/lib/colors';
import {
  computePhase0Signal,
  computePhase1Signal,
  computePhase2Signal,
  computePhase3Signal,
  computePhase4Signal,
  computePhase5Signal,
  type CameraAngle,
  type Handedness,
  type PhaseSignalResult,
} from './signalCompute';

type PhaseIndex = 0 | 1 | 2 | 3 | 4 | 5;

interface PhaseSignalCardProps {
  frames: MotionFrame[] | null;
  phaseIndex: PhaseIndex;
  phaseTags: PhaseTagRange[];
  handedness: Handedness;
  msPerFrame: number;
  cameraAngle: CameraAngle;
  loading: boolean;
}

const PHASE_TITLES: Record<PhaseIndex, string> = {
  0: 'Phase 0 — Swing Start',
  1: 'Phase 1 — Address',
  2: 'Phase 2 — Takeaway',
  3: 'Phase 3 — Top of Backswing',
  4: 'Phase 4 — Impact',
  5: 'Phase 5 — Finish',
};

const SCREEN_W = Dimensions.get('window').width;
const CHART_PADDING_H = 16;
const CHART_W = SCREEN_W - 32 - CHART_PADDING_H * 2;
const CHART_H = 200;
const Y_AXIS_PAD_RATIO = 0.1;

function computeForPhase(
  phaseIndex: PhaseIndex,
  frames: MotionFrame[] | null,
  handedness: Handedness,
  msPerFrame: number,
  cameraAngle: CameraAngle,
): PhaseSignalResult {
  switch (phaseIndex) {
    case 0: return computePhase0Signal(frames, handedness, msPerFrame, cameraAngle);
    case 1: return computePhase1Signal(frames, handedness, msPerFrame, cameraAngle);
    case 2: return computePhase2Signal(frames, handedness, msPerFrame, cameraAngle);
    case 3: return computePhase3Signal(frames, handedness, msPerFrame, cameraAngle);
    case 4: return computePhase4Signal(frames, handedness, msPerFrame, cameraAngle);
    case 5: return computePhase5Signal(frames, handedness, msPerFrame, cameraAngle);
  }
}

export default function PhaseSignalCard(props: PhaseSignalCardProps): React.ReactElement {
  const { frames, phaseIndex, phaseTags, handedness, msPerFrame, cameraAngle, loading } = props;

  const result = useMemo<PhaseSignalResult | null>(() => {
    if (loading || !frames) return null;
    return computeForPhase(phaseIndex, frames, handedness, msPerFrame, cameraAngle);
  }, [loading, frames, phaseIndex, handedness, msPerFrame, cameraAngle]);

  const detectedFrame =
    phaseTags[phaseIndex] !== undefined ? phaseTags[phaseIndex].startFrameIndex : null;
  const agreement = useMemo(() => {
    if (result === null || result.triggerFrame === null || detectedFrame === null) {
      return { mark: '—', color: 'rgba(255,255,255,0.4)', detail: '' };
    }
    const diff = Math.abs(result.triggerFrame - detectedFrame);
    if (diff <= 3) return { mark: '✓', color: '#5BE07A', detail: '' };
    return { mark: '✗', color: '#FF6B6B', detail: `off by ±${diff} frames` };
  }, [result, detectedFrame]);

  return (
    <View style={{ width: SCREEN_W, paddingHorizontal: 16, paddingTop: 24 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: '#FFFFFF', fontSize: 18, fontWeight: '700' }}>
          {PHASE_TITLES[phaseIndex]}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: agreement.color, fontSize: 20, fontWeight: '800', marginRight: 6 }}>
            {agreement.mark}
          </Text>
          {agreement.detail ? (
            <Text style={{ color: agreement.color, fontSize: 11 }}>{agreement.detail}</Text>
          ) : null}
        </View>
      </View>

      <View style={{ marginTop: 12, minHeight: CHART_H + 40 }}>
        {loading ? (
          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14, paddingVertical: 24 }}>
            Loading…
          </Text>
        ) : !frames ? (
          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14, paddingVertical: 24 }}>
            No frame data for this swing.
          </Text>
        ) : result && result.points.length === 0 && result.annotations.length > 0 ? (
          <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14, paddingVertical: 24 }}>
            {result.annotations[0]}
          </Text>
        ) : result && result.points.length === 0 ? (
          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14, paddingVertical: 24 }}>
            Not enough frames to compute.
          </Text>
        ) : result ? (
          <SignalChart result={result} detectedFrame={detectedFrame} />
        ) : null}
      </View>

      {result && result.annotations.length > 0 && result.points.length > 0 ? (
        <View style={{ marginTop: 8 }}>
          {result.annotations.map((a, i) => (
            <Text
              key={i}
              style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 2 }}
            >
              {a}
            </Text>
          ))}
        </View>
      ) : null}

      {result && detectedFrame !== null ? (
        <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 6 }}>
          phaseTags startFrame = {detectedFrame}
          {result.triggerFrame !== null ? ` · computed = ${result.triggerFrame}` : ''}
        </Text>
      ) : null}
    </View>
  );
}

interface SignalChartProps {
  result: PhaseSignalResult;
  detectedFrame: number | null;
}

function SignalChart({ result, detectedFrame }: SignalChartProps): React.ReactElement {
  const { points, thresholds, triggerFrame, watchRegions } = result;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const thresholdYs = thresholds.map((t) => t.value);
  const allYs = ys.concat(thresholdYs);

  const xMin = xs[0];
  const xMax = xs[xs.length - 1];
  const rawMin = Math.min(...allYs);
  const rawMax = Math.max(...allYs);
  const yRange = rawMax - rawMin || 1;
  const yMin = rawMin - yRange * Y_AXIS_PAD_RATIO;
  const yMax = rawMax + yRange * Y_AXIS_PAD_RATIO;
  const xSpan = xMax - xMin || 1;

  const xToPx = (x: number): number => ((x - xMin) / xSpan) * CHART_W;
  const yToPx = (y: number): number => CHART_H - ((y - yMin) / (yMax - yMin)) * CHART_H;

  const polylinePoints = points.map((p) => `${xToPx(p.x)},${yToPx(p.y)}`).join(' ');

  const frameLabelEvery = 5;
  const xTicks: number[] = [];
  for (let f = Math.ceil(xMin / frameLabelEvery) * frameLabelEvery; f <= xMax; f += frameLabelEvery) {
    xTicks.push(f);
  }

  return (
    <Svg width={CHART_W} height={CHART_H + 24}>
      <G x={0} y={0}>
        {watchRegions.map((r, i) => {
          const x0 = xToPx(r.start);
          const x1 = xToPx(r.end);
          return (
            <Rect
              key={`wr-${i}`}
              x={x0}
              y={0}
              width={Math.max(0, x1 - x0)}
              height={CHART_H}
              fill="rgba(139,90,43,0.25)"
            />
          );
        })}

        {thresholds.map((t, i) => {
          const y = yToPx(t.value);
          const isWatch = t.kind === 'watch';
          return (
            <Line
              key={`th-${i}`}
              x1={0}
              y1={y}
              x2={CHART_W}
              y2={y}
              stroke={isWatch ? '#5BE07A' : '#FF6B00'}
              strokeWidth={1.5}
              strokeDasharray={isWatch ? '4 4' : undefined}
            />
          );
        })}

        <Polyline
          points={polylinePoints}
          fill="none"
          stroke="#5AC8FA"
          strokeWidth={2}
        />

        {triggerFrame !== null && triggerFrame >= xMin && triggerFrame <= xMax ? (
          <G>
            <Line
              x1={xToPx(triggerFrame)}
              y1={0}
              x2={xToPx(triggerFrame)}
              y2={CHART_H}
              stroke="#B57CFF"
              strokeWidth={1.5}
            />
            <Circle
              cx={xToPx(triggerFrame)}
              cy={
                triggerFrame >= 0 && triggerFrame < points.length
                  ? yToPx(points[triggerFrame].y)
                  : CHART_H / 2
              }
              r={4}
              fill="#B57CFF"
            />
            <SvgText
              x={xToPx(triggerFrame) + 6}
              y={12}
              fill="#B57CFF"
              fontSize={10}
            >
              {`trigger f${triggerFrame}`}
            </SvgText>
          </G>
        ) : null}

        {detectedFrame !== null && detectedFrame >= xMin && detectedFrame <= xMax ? (
          <Line
            x1={xToPx(detectedFrame)}
            y1={0}
            x2={xToPx(detectedFrame)}
            y2={CHART_H}
            stroke={GOLD}
            strokeWidth={1}
            strokeDasharray="2 4"
          />
        ) : null}

        {xTicks.map((f, i) => (
          <SvgText
            key={`xt-${i}`}
            x={xToPx(f)}
            y={CHART_H + 14}
            fill="rgba(255,255,255,0.4)"
            fontSize={9}
            textAnchor="middle"
          >
            {String(f)}
          </SvgText>
        ))}
      </G>
    </Svg>
  );
}
