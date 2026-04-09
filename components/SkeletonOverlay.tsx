import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import { JOINT_CONFIDENCE_THRESHOLD } from '@/lib/captureValidity';

/** Landmark as returned by the native frame processor plugin (camelCase names). */
export interface Landmark {
  name: string;
  x: number; // 0-1 normalised
  y: number; // 0-1 normalised
  inFrameLikelihood: number;
}

/** Pairs of joint names to draw lines between (camelCase, matching Swift plugin output). */
const SKELETON_CONNECTIONS: [string, string][] = [
  // face
  ['leftEyeInner', 'leftEye'],
  ['leftEye', 'leftEyeOuter'],
  ['rightEyeInner', 'rightEye'],
  ['rightEye', 'rightEyeOuter'],
  ['mouthLeft', 'mouthRight'],
  // head → shoulders
  ['nose', 'leftShoulder'],
  ['nose', 'rightShoulder'],
  // torso
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
  // left arm + hand
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['leftWrist', 'leftThumb'],
  ['leftWrist', 'leftIndex'],
  ['leftWrist', 'leftPinky'],
  // right arm + hand
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['rightWrist', 'rightThumb'],
  ['rightWrist', 'rightIndex'],
  ['rightWrist', 'rightPinky'],
  // left leg + foot
  ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftAnkle'],
  ['leftAnkle', 'leftHeel'],
  ['leftAnkle', 'leftFootIndex'],
  ['leftHeel', 'leftFootIndex'],
  // right leg + foot
  ['rightHip', 'rightKnee'],
  ['rightKnee', 'rightAnkle'],
  ['rightAnkle', 'rightHeel'],
  ['rightAnkle', 'rightFootIndex'],
  ['rightHeel', 'rightFootIndex'],
];


const STROKE_COLOR = '#00FF66';
const DOT_COLOR = '#00FF66';

interface Props {
  landmarks: Landmark[];
  width: number;
  height: number;
  /** Camera frame portrait aspect ratio (width/height). 0 = unknown, use simple mapping. */
  frameAspect?: number;
  /** Set true when using front-facing camera to mirror x coordinates. */
  mirrored?: boolean;
}

export default function SkeletonOverlay({ landmarks, width, height, frameAspect = 0, mirrored = false }: Props) {
  if (landmarks.length === 0 || width === 0 || height === 0) return null;

  const byName = new Map<string, Landmark>();
  for (const lm of landmarks) {
    // TODO: restore confidence filter after verifying all joints render
    byName.set(lm.name, lm);
  }

  // Cover-crop transform: camera uses resizeMode="cover", which center-crops the
  // frame to fill the screen. Landmarks are normalised to the full frame, so we
  // must map only the visible portion to screen coordinates.
  const screenAspect = width / height;
  const fAspect = frameAspect > 0 ? frameAspect : screenAspect;
  let offsetX = 0;
  let offsetY = 0;
  let visibleX = 1;
  let visibleY = 1;
  if (fAspect > screenAspect) {
    // frame wider than screen → left/right cropped
    visibleX = screenAspect / fAspect;
    offsetX = (1 - visibleX) / 2;
  } else {
    // frame taller than screen → top/bottom cropped
    visibleY = fAspect / screenAspect;
    offsetY = (1 - visibleY) / 2;
  }
  const px = (lm: Landmark) => {
    const nx = mirrored ? 1 - lm.x : lm.x;
    return ((nx - offsetX) / visibleX) * width;
  };
  const py = (lm: Landmark) => ((lm.y - offsetY) / visibleY) * height;

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
