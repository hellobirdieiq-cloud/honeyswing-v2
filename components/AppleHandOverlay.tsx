import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import type { AppleHand, AppleJointName } from '../lib/appleHandDetection';
import { GOLD } from '../lib/colors';

const APPLE_HAND_BONES: [AppleJointName, AppleJointName][] = [
  // thumb
  ['wrist',      'thumbCMC'],
  ['thumbCMC',   'thumbMP'],
  ['thumbMP',    'thumbIP'],
  ['thumbIP',    'thumbTip'],
  // index
  ['wrist',      'indexMCP'],
  ['indexMCP',   'indexPIP'],
  ['indexPIP',   'indexDIP'],
  ['indexDIP',   'indexTip'],
  // middle
  ['wrist',      'middleMCP'],
  ['middleMCP',  'middlePIP'],
  ['middlePIP',  'middleDIP'],
  ['middleDIP',  'middleTip'],
  // ring
  ['wrist',      'ringMCP'],
  ['ringMCP',    'ringPIP'],
  ['ringPIP',    'ringDIP'],
  ['ringDIP',    'ringTip'],
  // little
  ['wrist',      'littleMCP'],
  ['littleMCP',  'littlePIP'],
  ['littlePIP',  'littleDIP'],
  ['littleDIP',  'littleTip'],
];

interface Props {
  hands: AppleHand[] | null;
  width: number;
  height: number;
}

export default function AppleHandOverlay({ hands, width, height }: Props) {
  if (!hands || hands.length === 0 || width === 0 || height === 0) return null;

  return (
    <Svg
      style={StyleSheet.absoluteFill}
      width={width}
      height={height}
      pointerEvents="none"
    >
      {hands.flatMap((hand, handIdx) => {
        const joints = hand.joints;
        const lines = APPLE_HAND_BONES.map(([a, b]) => {
          const ja = joints[a];
          const jb = joints[b];
          if (!ja || !jb) return null;
          return (
            <Line
              key={`h${handIdx}-${a}-${b}`}
              x1={ja.x * width}
              y1={(1 - ja.y) * height}
              x2={jb.x * width}
              y2={(1 - jb.y) * height}
              stroke={GOLD}
              strokeWidth={2}
              strokeLinecap="round"
            />
          );
        });
        const dots = (Object.keys(joints) as AppleJointName[]).map((name) => {
          const j = joints[name];
          if (!j) return null;
          return (
            <Circle
              key={`h${handIdx}-${name}`}
              cx={j.x * width}
              cy={(1 - j.y) * height}
              r={4}
              fill={GOLD}
            />
          );
        });
        return [...lines, ...dots];
      })}
    </Svg>
  );
}
