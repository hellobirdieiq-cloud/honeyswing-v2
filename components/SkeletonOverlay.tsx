import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

/** Landmark as returned by the native frame processor plugin. */
export interface Landmark {
  name: string;
  x: number; // 0-1 normalised
  y: number; // 0-1 normalised
  inFrameLikelihood: number;
}

/** Pairs of joint names to draw lines between. */
const SKELETON_CONNECTIONS: [string, string][] = [
  // torso
  ['left_shoulder', 'right_shoulder'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  // left arm
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  // right arm
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  // left leg
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  // right leg
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
];

const MIN_CONFIDENCE = 0.3;

interface Props {
  landmarks: Landmark[];
  width: number;
  height: number;
}

export default function SkeletonOverlay({ landmarks, width, height }: Props) {
  if (landmarks.length === 0 || width === 0 || height === 0) return null;

  const byName = new Map<string, Landmark>();
  for (const lm of landmarks) {
    if (lm.inFrameLikelihood >= MIN_CONFIDENCE) {
      byName.set(lm.name, lm);
    }
  }

  return (
    <Svg style={StyleSheet.absoluteFill} width={width} height={height}>
      {SKELETON_CONNECTIONS.map(([a, b]) => {
        const ja = byName.get(a);
        const jb = byName.get(b);
        if (!ja || !jb) return null;
        return (
          <Line
            key={`${a}-${b}`}
            x1={ja.x * width}
            y1={ja.y * height}
            x2={jb.x * width}
            y2={jb.y * height}
            stroke="white"
            strokeWidth={3}
            strokeLinecap="round"
          />
        );
      })}
      {Array.from(byName.values()).map((lm) => (
        <Circle
          key={lm.name}
          cx={lm.x * width}
          cy={lm.y * height}
          r={5}
          fill="white"
        />
      ))}
    </Svg>
  );
}
