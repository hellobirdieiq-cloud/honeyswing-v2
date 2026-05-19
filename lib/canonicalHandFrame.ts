/**
 * Detector-neutral 21-joint hand representation.
 *
 * Joint ordering follows MediaPipe HandLandmarker indices 0-20. Adapters from
 * other detectors (Apple Vision, RTM-ANE) must emit points in this order so
 * the classify-grip edge function (which hardcodes MP indices in its geometry
 * math) works unchanged.
 */

export const HandJoint = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

export type HandJointId = (typeof HandJoint)[keyof typeof HandJoint];

/** MediaPipe-style landmark name strings, indexed by HandJoint id 0-20. */
export const HAND_JOINT_NAMES = [
  'wrist',
  'thumbCmc',
  'thumbMcp',
  'thumbIp',
  'thumbTip',
  'indexMcp',
  'indexPip',
  'indexDip',
  'indexTip',
  'middleMcp',
  'middlePip',
  'middleDip',
  'middleTip',
  'ringMcp',
  'ringPip',
  'ringDip',
  'ringTip',
  'pinkyMcp',
  'pinkyPip',
  'pinkyDip',
  'pinkyTip',
] as const;

export type DetectorType = 'mediapipe' | 'apple_vision';

/** Detected physical hand from the detector's own classifier. NOT golfer handedness. */
export type HandLabel = 'Left' | 'Right' | 'Unknown';

export type CanonicalHandPoint = {
  joint: HandJointId;
  x: number;
  y: number;
  z?: number;
  confidence: number;
};

export type CanonicalHandFrame = {
  detectorType: DetectorType;
  handIndex: number;
  handedness: HandLabel;
  handScore: number;
  points: CanonicalHandPoint[];
};
