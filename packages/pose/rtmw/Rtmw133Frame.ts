export type Rtmw133Keypoint = { x: number; y: number; confidence: number };

export type Rtmw133Frame = {
  timestampMs: number;
  keypoints: Rtmw133Keypoint[]; // length 133, in coco_wholebody index order
  frameWidth: number;
  frameHeight: number;
  extractionMs?: number;
};
