import type {
  JointName,
  NormalizedJoint,
  PoseFrame,
  PoseSequence,
} from "@/packages/pose/PoseTypes";

/** Bilateral joint pairs — swapped left↔right by the canonical mirror. */
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
  // Z pass-through under the x-mirror: pose z is subject-centered depth
  // (origin at mid-hips), sign-preserved under horizontal reflection — the
  // mirror flips x but leaves z and y unchanged. Verify with real lefty
  // capture at clinic.
  return {
    name: newName,
    x: 1.0 - joint.x,
    y: joint.y,
    z: joint.z,
    confidence: joint.confidence,
  };
}

/**
 * M: the canonical mirror — x → 1−x on every joint + bilateral label swap.
 * An involution (M∘M = identity). When mirror=false, returns the input
 * unchanged.
 *
 * WHICH swings get mirrored is the CALLER's decision (analysisPipeline
 * computes `mirrorToCanonical = !isLeftHanded`): canonical space is the
 * layout the scoring/phase corpus was tuned on — the mirror of a faithful
 * right-handed capture, where label left* is the TRAIL arm. This function
 * only implements M; it encodes no handedness policy.
 */
export function toCanonicalFrame(
  frame: PoseFrame,
  mirror: boolean,
): PoseFrame {
  if (!mirror) return frame;

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
 * Apply the canonical mirror M to an entire pose sequence.
 * When mirror=false, returns the input unchanged (identity).
 * Handedness policy lives at the call site — see toCanonicalFrame.
 */
export function toCanonicalSequence(
  sequence: PoseSequence,
  mirror: boolean,
): PoseSequence {
  if (!mirror) return sequence;

  return {
    frames: sequence.frames.map((frame) => toCanonicalFrame(frame, true)),
    source: sequence.source,
    metadata: sequence.metadata,
  };
}
