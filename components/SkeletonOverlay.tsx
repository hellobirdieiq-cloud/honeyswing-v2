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

const MIN_CONFIDENCE = 0.3;
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
    if (lm.inFrameLikelihood >= MIN_CONFIDENCE) {
      byName.set(lm.name, lm);
    }
  }

  // ── Cover-crop transform: match camera preview's "cover" scaling ───
  // Landmarks are 0-1 in portrait image space. The camera preview scales
  // the image to cover the container, cropping the overflow axis.
  let scaleX = width;
  let scaleY = height;
  let offsetX = 0;
  let offsetY = 0;

  if (frameAspect > 0) {
    const containerAspect = width / height;
    if (frameAspect > containerAspect) {
      // Camera is relatively wider → scale by height, crop sides
      const scaledW = height * frameAspect;
      scaleX = scaledW;
      scaleY = height;
      offsetX = (width - scaledW) / 2; // negative = cropped left/right
    } else {
      // Camera is relatively taller → scale by width, crop top/bottom
      const scaledH = width / frameAspect;
      scaleX = width;
      scaleY = scaledH;
      offsetY = (height - scaledH) / 2; // negative = cropped top/bottom
    }
  }

  const px = (lm: Landmark) => offsetX + (mirrored ? 1 - lm.x : lm.x) * scaleX;
  const py = (lm: Landmark) => offsetY + lm.y * scaleY;

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
