import { JointName, PoseFrame } from "../../pose/PoseTypes";

export interface GolfAngles {
  spineAngle: number | null;
  leftElbowAngle: number | null;
  rightElbowAngle: number | null;
  leftKneeAngle: number | null;
  rightKneeAngle: number | null;
  hipRotation: number | null;
  shoulderTilt: number | null;
}

function angleBetween(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number }
): number {
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };
  const dot = ba.x * bc.x + ba.y * bc.y;
  const magBA = Math.sqrt(ba.x * ba.x + ba.y * ba.y);
  const magBC = Math.sqrt(bc.x * bc.x + bc.y * bc.y);
  if (magBA === 0 || magBC === 0) return 0;
  const cosAngle = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
  return Math.round((Math.acos(cosAngle) * 180) / Math.PI);
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function angleToVertical(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag === 0) return 0;
  return Math.round((Math.acos(Math.abs(dy) / mag) * 180) / Math.PI);
}

const MIN_CONFIDENCE = 0.5;

function getJoint(frame: PoseFrame, name: JointName) {
  return frame.joints[name];
}

function isGood(joint: { confidence?: number } | undefined): boolean {
  return (joint?.confidence ?? 0) >= MIN_CONFIDENCE;
}

export function calculateGolfAngles(frame: PoseFrame): GolfAngles {
  const ls = getJoint(frame, "leftShoulder");
  const rs = getJoint(frame, "rightShoulder");
  const le = getJoint(frame, "leftElbow");
  const re = getJoint(frame, "rightElbow");
  const lw = getJoint(frame, "leftWrist");
  const rw = getJoint(frame, "rightWrist");
  const lh = getJoint(frame, "leftHip");
  const rh = getJoint(frame, "rightHip");
  const lk = getJoint(frame, "leftKnee");
  const rk = getJoint(frame, "rightKnee");
  const la = getJoint(frame, "leftAnkle");
  const ra = getJoint(frame, "rightAnkle");

  let spineAngle: number | null = null;
  if (isGood(ls) && isGood(rs) && isGood(lh) && isGood(rh)) {
    const shoulderMid = midpoint(ls!, rs!);
    const hipMid = midpoint(lh!, rh!);
    spineAngle = angleToVertical(hipMid, shoulderMid);
  }

  let leftElbowAngle: number | null = null;
  if (isGood(ls) && isGood(le) && isGood(lw)) {
    leftElbowAngle = angleBetween(ls!, le!, lw!);
  }

  let rightElbowAngle: number | null = null;
  if (isGood(rs) && isGood(re) && isGood(rw)) {
    rightElbowAngle = angleBetween(rs!, re!, rw!);
  }

  let leftKneeAngle: number | null = null;
  if (isGood(lh) && isGood(lk) && isGood(la)) {
    leftKneeAngle = angleBetween(lh!, lk!, la!);
  }

  let rightKneeAngle: number | null = null;
  if (isGood(rh) && isGood(rk) && isGood(ra)) {
    rightKneeAngle = angleBetween(rh!, rk!, ra!);
  }

  let hipRotation: number | null = null;
  if (isGood(lh) && isGood(rh)) {
    hipRotation = Math.round(Math.abs(rh!.x - lh!.x) * 100);
  }

  let shoulderTilt: number | null = null;
  if (isGood(ls) && isGood(rs)) {
    const dx = rs!.x - ls!.x;
    const dy = rs!.y - ls!.y;
    shoulderTilt = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
  }

  return {
    spineAngle,
    leftElbowAngle,
    rightElbowAngle,
    leftKneeAngle,
    rightKneeAngle,
    hipRotation,
    shoulderTilt,
  };
}
