import type {
  JointName,
  NormalizedJoint,
  PoseFrame,
  PoseSequence,
} from "@/packages/pose/PoseTypes";

/** Bilateral joint pairs — swap left↔right for lefty canonical transform. */
const BILATERAL_PAIRS: [JointName, JointName][] = [
  ["leftEyeInner", "rightEyeInner"],
  ["leftEye", "rightEye"],
  ["leftEyeOuter", "rightEyeOuter"],
  ["leftEar", "rightEar"],
  ["mouthLeft", "mouthRight"],
  ["leftShoulder", "rightShoulder"],
  ["leftElbow", "rightElbow"],
  ["leftWrist", "rightWrist"],
  ["leftPinky", "rightPinky"],
  ["leftIndex", "rightIndex"],
  ["leftThumb", "rightThumb"],
  ["leftHip", "rightHip"],
  ["leftKnee", "rightKnee"],
  ["leftAnkle", "rightAnkle"],
  ["leftHeel", "rightHeel"],
  ["leftFootIndex", "rightFootIndex"],
];

/** Build a swap map from the bilateral pairs for O(1) lookup. */
const SWAP_MAP = new Map<JointName, JointName>();
for (const [a, b] of BILATERAL_PAIRS) {
  SWAP_MAP.set(a, b);
  SWAP_MAP.set(b, a);
}

function mirrorJoint(
  joint: NormalizedJoint,
  newName: JointName,
): NormalizedJoint {
  return {
    name: newName,
    x: 1.0 - joint.x,
    y: joint.y,
    z: joint.z,
    confidence: joint.confidence,
  };
}

/**
 * Mirror a single frame into right-handed canonical form.
 * When isLeftHanded=false, returns the input unchanged (identity).
 * When isLeftHanded=true, mirrors all X coords and swaps bilateral joint pairs.
 */
export function toCanonicalFrame(
  frame: PoseFrame,
  isLeftHanded: boolean,
): PoseFrame {
  if (!isLeftHanded) return frame;

  const canonicalJoints = {} as Record<JointName, NormalizedJoint | undefined>;

  for (const [name, joint] of Object.entries(frame.joints) as [
    JointName,
    NormalizedJoint | undefined,
  ][]) {
    const targetName = SWAP_MAP.get(name) ?? name;
    if (joint) {
      canonicalJoints[targetName] = mirrorJoint(joint, targetName);
    } else {
      canonicalJoints[targetName] = undefined;
    }
  }

  return {
    timestampMs: frame.timestampMs,
    joints: canonicalJoints,
    frameWidth: frame.frameWidth,
    frameHeight: frame.frameHeight,
  };
}

/**
 * Mirror an entire pose sequence into right-handed canonical form.
 * When isLeftHanded=false, returns the input unchanged (identity).
 */
export function toCanonicalSequence(
  sequence: PoseSequence,
  isLeftHanded: boolean,
): PoseSequence {
  if (!isLeftHanded) return sequence;

  return {
    frames: sequence.frames.map((frame) => toCanonicalFrame(frame, true)),
    source: sequence.source,
    metadata: sequence.metadata,
  };
}
