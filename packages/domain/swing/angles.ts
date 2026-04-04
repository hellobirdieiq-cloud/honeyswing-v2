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

type Point = { x: number; y: number; z?: number };

/** Z is considered reliable when the range across joints exceeds this threshold */
const Z_RANGE_THRESHOLD = 0.02;

function isZReliable(...joints: (Point | undefined)[]): boolean {
  const zValues = joints
    .map(j => j?.z)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (zValues.length < 2) return false;
  return Math.max(...zValues) - Math.min(...zValues) >= Z_RANGE_THRESHOLD;
}

function angleBetween(a: Point, b: Point, c: Point): number {
  const use3D = isZReliable(a, b, c);
  const ba = { x: a.x - b.x, y: a.y - b.y, z: use3D ? (a.z! - b.z!) : 0 };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: use3D ? (c.z! - b.z!) : 0 };
  const dot = ba.x * bc.x + ba.y * bc.y + ba.z * bc.z;
  const magBA = Math.sqrt(ba.x * ba.x + ba.y * ba.y + ba.z * ba.z);
  const magBC = Math.sqrt(bc.x * bc.x + bc.y * bc.y + bc.z * bc.z);
  if (magBA === 0 || magBC === 0) return 0;
  const cosAngle = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
  return Math.round((Math.acos(cosAngle) * 180) / Math.PI);
}

function midpoint(a: Point, b: Point): Point {
  const result: Point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (a.z != null && b.z != null) result.z = (a.z + b.z) / 2;
  return result;
}

function angleToVertical(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const use3D = isZReliable(a, b);
  const dz = use3D ? (b.z! - a.z!) : 0;
  const mag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (mag === 0) return 0;
  const cosAngle = Math.max(-1, Math.min(1, Math.abs(dy) / mag));
  return Math.round((Math.acos(cosAngle) * 180) / Math.PI);
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
    const absDx = Math.abs(dx);
    shoulderTilt = Math.round((Math.atan2(dy, absDx) * 180) / Math.PI);
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
