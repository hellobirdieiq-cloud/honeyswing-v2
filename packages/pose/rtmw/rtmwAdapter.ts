import {
  JointName,
  NormalizedJoint,
  PoseFrame,
  createEmptyJoints,
} from '../PoseTypes';
import { Rtmw133Frame } from './Rtmw133Frame';
import {
  COCO_WHOLEBODY_NAMES,
  IDX_NOSE,
  IDX_LEFT_SHOULDER,
  IDX_RIGHT_SHOULDER,
  IDX_LEFT_ELBOW,
  IDX_RIGHT_ELBOW,
  IDX_LEFT_WRIST,
  IDX_RIGHT_WRIST,
  IDX_LEFT_HIP,
  IDX_RIGHT_HIP,
  IDX_LEFT_KNEE,
  IDX_RIGHT_KNEE,
  IDX_LEFT_ANKLE,
  IDX_RIGHT_ANKLE,
  IDX_LEFT_HEEL,
  IDX_LEFT_INDEX,
  IDX_RIGHT_INDEX,
  IDX_LEFT_THUMB,
  IDX_RIGHT_THUMB,
  IDX_LEFT_THUMB_TIP,
  IDX_RIGHT_THUMB_TIP,
  IDX_LEFT_PINKY,
  IDX_RIGHT_PINKY,
  IDX_LEFT_FOOT_INDEX,
  IDX_RIGHT_FOOT_INDEX,
} from './cocoWholebody';

// COCO-WholeBody `names`-array indices for joints not in the load-bearing-18
// block but present as plain body keypoints (derived, not load-bearing).
const IDX_LEFT_EYE = COCO_WHOLEBODY_NAMES.indexOf('left_eye');
const IDX_RIGHT_EYE = COCO_WHOLEBODY_NAMES.indexOf('right_eye');
const IDX_LEFT_EAR = COCO_WHOLEBODY_NAMES.indexOf('left_ear');
const IDX_RIGHT_EAR = COCO_WHOLEBODY_NAMES.indexOf('right_ear');
const IDX_RIGHT_HEEL = COCO_WHOLEBODY_NAMES.indexOf('right_heel');

// Exhaustive map: every one of the 33 JointNames is either a COCO-WholeBody
// keypoint index, or null = intentionally unmapped (no COCO-WholeBody source).
// The 6 null entries are BlazePose-specific face joints absent from COCO-WholeBody;
// they are NOT consumed by the scoring stack's load-bearing-18. See convergence note.
const JOINT_TO_COCOWB_INDEX: Record<JointName, number | null> = {
  // face
  nose: IDX_NOSE,
  leftEyeInner: null,
  leftEye: IDX_LEFT_EYE,
  leftEyeOuter: null,
  rightEyeInner: null,
  rightEye: IDX_RIGHT_EYE,
  rightEyeOuter: null,
  leftEar: IDX_LEFT_EAR,
  rightEar: IDX_RIGHT_EAR,
  mouthLeft: null,
  mouthRight: null,
  // upper body
  leftShoulder: IDX_LEFT_SHOULDER,
  rightShoulder: IDX_RIGHT_SHOULDER,
  leftElbow: IDX_LEFT_ELBOW,
  rightElbow: IDX_RIGHT_ELBOW,
  leftWrist: IDX_LEFT_WRIST,
  rightWrist: IDX_RIGHT_WRIST,
  // hands (anatomical traps)
  leftPinky: IDX_LEFT_PINKY,
  rightPinky: IDX_RIGHT_PINKY,
  leftIndex: IDX_LEFT_INDEX,
  rightIndex: IDX_RIGHT_INDEX,
  leftThumb: IDX_LEFT_THUMB,
  rightThumb: IDX_RIGHT_THUMB,
  leftThumbTip: IDX_LEFT_THUMB_TIP,
  rightThumbTip: IDX_RIGHT_THUMB_TIP,
  // lower body
  leftHip: IDX_LEFT_HIP,
  rightHip: IDX_RIGHT_HIP,
  leftKnee: IDX_LEFT_KNEE,
  rightKnee: IDX_RIGHT_KNEE,
  leftAnkle: IDX_LEFT_ANKLE,
  rightAnkle: IDX_RIGHT_ANKLE,
  // feet
  leftHeel: IDX_LEFT_HEEL,
  rightHeel: IDX_RIGHT_HEEL,
  leftFootIndex: IDX_LEFT_FOOT_INDEX,
  rightFootIndex: IDX_RIGHT_FOOT_INDEX,
};

// JointNames intentionally left unmapped — no COCO-WholeBody source.
// Exported so the golden test can assert exactly this set stays undefined.
export const UNMAPPED_JOINTS: readonly JointName[] = [
  'leftEyeInner',
  'leftEyeOuter',
  'rightEyeInner',
  'rightEyeOuter',
  'mouthLeft',
  'mouthRight',
];

export function rtmwToPoseFrame(r: Rtmw133Frame): PoseFrame {
  const joints = createEmptyJoints();

  (Object.keys(JOINT_TO_COCOWB_INDEX) as JointName[]).forEach((jointName) => {
    const idx = JOINT_TO_COCOWB_INDEX[jointName];
    if (idx === null) {
      return; // intentionally unmapped — stays undefined
    }
    const kp = r.keypoints[idx];
    if (kp === undefined) {
      return; // defensive: malformed input frame
    }
    const joint: NormalizedJoint = {
      name: jointName,
      x: kp.x / r.frameWidth,
      y: kp.y / r.frameHeight,
      confidence: kp.confidence,
    };
    joints[jointName] = joint;
  });

  return {
    timestampMs: r.timestampMs,
    joints,
    frameWidth: r.frameWidth,
    frameHeight: r.frameHeight,
  };
}
