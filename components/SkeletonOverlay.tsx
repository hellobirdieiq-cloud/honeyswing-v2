import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

/** Landmark as returned by the native frame processor plugin (camelCase names). */
export interface Landmark {
  name: string;
  x: number; // 0-1 normalised
  y: number; // 0-1 normalised
  inFrameLikelihood: number;
}

/** Pairs of joint names to draw lines between (camelCase, matching Swift plugin output). */
const SKELETON_CONNECTIONS: [string, string][] = [
  // head → shoulders
  ['nose', 'leftShoulder'],
  ['nose', 'rightShoulder'],
  // torso
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
  // left arm
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  // right arm
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  // left leg
  ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftAnkle'],
  // right leg
  ['rightHip', 'rightKnee'],
  ['rightKnee', 'rightAnkle'],
];

const MIN_CONFIDENCE = 0.3;
const STROKE_COLOR = '#00FF66';
const DOT_COLOR = '#00FF66';

interface Props {
  landmarks: Landmark[];
  width: number;
  height: number;
  /** Set true when using front-facing camera to mirror x coordinates. */
  mirrored?: boolean;
}

export default function SkeletonOverlay({ landmarks, width, height, mirrored = false }: Props) {
  if (landmarks.length === 0 || width === 0 || height === 0) return null;

  const byName = new Map<string, Landmark>();
  for (const lm of landmarks) {
    if (lm.inFrameLikelihood >= MIN_CONFIDENCE) {
      byName.set(lm.name, lm);
    }
  }

  const px = (lm: Landmark) => (mirrored ? 1 - lm.x : lm.x) * width;
  const py = (lm: Landmark) => lm.y * height;

  return (
    <Svg style={StyleSheet.absoluteFill} width={width} height={height}>
      {SKELETON_CONNECTIONS.map(([a, b]) => {
        const ja = byName.get(a);
        const jb = byName.get(b);
        if (!ja || !jb) return null;
        return (
          <Line
            key={`${a}-${b}`}
            x1={px(ja)}
            y1={py(ja)}
            x2={px(jb)}
            y2={py(jb)}
            stroke={STROKE_COLOR}
            strokeWidth={4}
            strokeLinecap="round"
          />
        );
      })}
      {Array.from(byName.values()).map((lm) => (
        <Circle
          key={lm.name}
          cx={px(lm)}
          cy={py(lm)}
          r={6}
          fill={DOT_COLOR}
        />
      ))}
    </Svg>
  );
}
