import indexData from '../../../models/coco_wholebody_index.json';

export const COCO_WHOLEBODY_NAMES: readonly string[] = indexData.names;

if (COCO_WHOLEBODY_NAMES.length !== 133) {
  throw new Error(
    `coco_wholebody_index.json names array must be length 133, got ${COCO_WHOLEBODY_NAMES.length}`,
  );
}

// Anatomical-trap indices — derived from the JSON trap_indices block (single source of truth).
export const IDX_LEFT_INDEX = indexData.trap_indices.leftIndex.cocowb_index;
export const IDX_RIGHT_INDEX = indexData.trap_indices.rightIndex.cocowb_index;
export const IDX_LEFT_THUMB = indexData.trap_indices.leftThumb.cocowb_index;
export const IDX_RIGHT_THUMB = indexData.trap_indices.rightThumb.cocowb_index;
export const IDX_LEFT_PINKY = indexData.trap_indices.leftPinky.cocowb_index;
export const IDX_RIGHT_PINKY = indexData.trap_indices.rightPinky.cocowb_index;
export const IDX_LEFT_FOOT_INDEX = indexData.trap_indices.leftFootIndex.cocowb_index;
export const IDX_RIGHT_FOOT_INDEX = indexData.trap_indices.rightFootIndex.cocowb_index;

// Load-bearing body-joint indices — derived from the JSON load_bearing_18.body_joints block.
const body = indexData.load_bearing_18.body_joints;
export const IDX_NOSE = body.nose;
export const IDX_LEFT_SHOULDER = body.leftShoulder;
export const IDX_RIGHT_SHOULDER = body.rightShoulder;
export const IDX_LEFT_ELBOW = body.leftElbow;
export const IDX_RIGHT_ELBOW = body.rightElbow;
export const IDX_LEFT_WRIST = body.leftWrist;
export const IDX_RIGHT_WRIST = body.rightWrist;
export const IDX_LEFT_HIP = body.leftHip;
export const IDX_RIGHT_HIP = body.rightHip;
export const IDX_LEFT_KNEE = body.leftKnee;
export const IDX_RIGHT_KNEE = body.rightKnee;
export const IDX_LEFT_ANKLE = body.leftAnkle;
export const IDX_RIGHT_ANKLE = body.rightAnkle;
export const IDX_LEFT_HEEL = body.leftHeel;
