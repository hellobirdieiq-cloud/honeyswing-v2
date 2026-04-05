import { JointName, PoseFrame } from "../../pose/PoseTypes";
import { PoseSequence } from "../../pose/PoseTypes";
import { calculateGolfAngles, GolfAngles } from "./angles";
import { CameraAngle, CameraAngleResult, detectCameraAngle } from "./cameraAngle";
import { correctForeshortening, type ForeshorteningDebug } from './foreshorteningCorrection';
import { applyTiltCorrection, type GravityReading, type TiltCorrectionDebug } from './tiltCorrection';
import { toCanonicalSequence } from "./canonicalTransform";
import { detectSwingPhases, DetectedPhase, SwingTrailPoint } from "./phaseDetection";
import { calculateTempo, isTempoTrustworthy } from "./tempoAnalysis";
import { scoreSwing, ScoringBreakdownEntry } from "./scoring";
import {
  computeSwingConfidence,
  shouldShowMetric,
  type SwingConfidence,
} from './confidenceScore';
import type { ConfidenceComponents } from './confidenceScore';

export type FrameSelectionDebug = {
  frame_selection_method: 'phase_windowed' | 'mid_frame_fallback';
  address_frame_range?: [number, number];
  impact_frame_index?: number;
  backswing_peak_frame_index?: number;
  camera_angle?: CameraAngle;
  camera_angle_avg_spread?: number;
  camera_angle_shoulder_spread?: number;
  camera_angle_hip_spread?: number;
  scoring_breakdown?: ScoringBreakdownEntry[];
  confidence_overall?: number;
  confidence_tier?: string;
  confidence_components?: ConfidenceComponents;
  foreshortening?: ForeshorteningDebug;
  tilt_correction?: TiltCorrectionDebug;
};

export type AnalysisResult = {
  score: number;
  honeyBoom: boolean;
  angles?: any;
  tempo?: any;
  phases?: any[];
  swing_debug?: FrameSelectionDebug;
  swingConfidence: SwingConfidence;
  cameraAngleResult: CameraAngleResult;
};

function buildTrailPoints(sequence: PoseSequence): SwingTrailPoint[] {
  const points: SwingTrailPoint[] = [];

  for (const frame of sequence.frames) {
    const lw = frame.joints.leftWrist;
    const rw = frame.joints.rightWrist;

    if (!lw || !rw) continue;

    points.push({
      x: (lw.x + rw.x) / 2,
      y: (lw.y + rw.y) / 2,
      timestamp: frame.timestampMs,
    });
  }

  return points;
}

const ALL_JOINT_NAMES: JointName[] = [
  "nose", "leftEyeInner", "leftEye", "leftEyeOuter",
  "rightEyeInner", "rightEye", "rightEyeOuter",
  "leftEar", "rightEar", "mouthLeft", "mouthRight",
  "leftShoulder", "rightShoulder", "leftElbow", "rightElbow",
  "leftWrist", "rightWrist", "leftPinky", "rightPinky",
  "leftIndex", "rightIndex", "leftThumb", "rightThumb",
  "leftHip", "rightHip", "leftKnee", "rightKnee",
  "leftAnkle", "rightAnkle", "leftHeel", "rightHeel",
  "leftFootIndex", "rightFootIndex",
];

const MIN_AVG_CONFIDENCE = 0.5;

/** Average joint positions across a window of frames to reduce per-frame noise. */
function averageFrames(frames: PoseFrame[], start: number, end: number): PoseFrame {
  const s = Math.max(0, start);
  const e = Math.min(frames.length - 1, end);
  const window = frames.slice(s, e + 1);
  const midFrame = window[Math.floor(window.length / 2)];

  const joints = {} as Record<JointName, import("../../pose/PoseTypes").NormalizedJoint | undefined>;

  for (const name of ALL_JOINT_NAMES) {
    const valid = window
      .map(f => f.joints[name])
      .filter((j): j is NonNullable<typeof j> => j != null && (j.confidence ?? 0) >= MIN_AVG_CONFIDENCE);

    if (valid.length === 0) {
      joints[name] = undefined;
      continue;
    }

    let sumX = 0, sumY = 0, sumZ = 0, sumConf = 0;
    let hasZ = false;
    let zCount = 0;
    for (const j of valid) {
      sumX += j.x;
      sumY += j.y;
      if (j.z != null) { sumZ += j.z; hasZ = true; zCount++; }
      sumConf += j.confidence ?? 0;
    }

    const n = valid.length;
    joints[name] = {
      name,
      x: sumX / n,
      y: sumY / n,
      ...(hasZ ? { z: sumZ / zCount } : {}),
      confidence: sumConf / n,
    };
  }

  return {
    timestampMs: midFrame.timestampMs,
    joints,
    frameWidth: midFrame.frameWidth,
    frameHeight: midFrame.frameHeight,
  };
}

type PhaseWindowResult = {
  angles: GolfAngles;
  debug: FrameSelectionDebug;
};

/** Compute angles using phase-specific measurement windows for reduced variance. */
function computePhaseWindowedAngles(
  frames: PoseFrame[],
  phases: DetectedPhase[],
): PhaseWindowResult {
  const addressPhase = phases.find(p => p.phase === 'address')!;
  const topPhase = phases.find(p => p.phase === 'top')!;
  const impactPhase = phases.find(p => p.phase === 'impact')!;

  // Assumes capture starts at address. May need wrist-velocity gate if users start recording mid-backswing.
  const addressFrame = averageFrames(frames, 0, 9);
  const impactFrame = averageFrames(frames, impactPhase.index - 2, impactPhase.index + 2);
  const topFrame = averageFrames(frames, topPhase.index - 2, topPhase.index + 2);

  const addressAngles = calculateGolfAngles(addressFrame);
  const impactAngles = calculateGolfAngles(impactFrame);
  const topAngles = calculateGolfAngles(topFrame);

  // Hip rotation as delta: how much the hips opened from address to impact
  let hipRotation: number | null = null;
  if (impactAngles.hipRotation != null && addressAngles.hipRotation != null) {
    hipRotation = impactAngles.hipRotation - addressAngles.hipRotation;
  }

  const angles: GolfAngles = {
    spineAngle: addressAngles.spineAngle,
    leftElbowAngle: impactAngles.leftElbowAngle,
    rightElbowAngle: impactAngles.rightElbowAngle,
    leftKneeAngle: addressAngles.leftKneeAngle,
    rightKneeAngle: addressAngles.rightKneeAngle,
    hipRotation,
    shoulderTilt: topAngles.shoulderTilt,
  };

  return {
    angles,
    debug: {
      frame_selection_method: 'phase_windowed',
      address_frame_range: [0, Math.min(9, frames.length - 1)],
      impact_frame_index: impactPhase.index,
      backswing_peak_frame_index: topPhase.index,
    },
  };
}

function shouldFallback(
  frames: PoseFrame[],
  phases: DetectedPhase[],
): boolean {
  if (frames.length < 20) return true;
  if (phases.length === 0) return true;
  if (phases.every(p => p.source === 'fallback')) return true;

  const addressPhase = phases.find(p => p.phase === 'address');
  const topPhase = phases.find(p => p.phase === 'top');
  const impactPhase = phases.find(p => p.phase === 'impact');
  if (!addressPhase || !topPhase || !impactPhase) return true;

  if (impactPhase.index < 5 || impactPhase.index > frames.length - 6) return true;

  return false;
}

export function analyzePoseSequence(
  sequence: PoseSequence,
  isLeftHanded = false,
  gravityReadings: GravityReading[] = [],
): AnalysisResult {
  const canonical = toCanonicalSequence(sequence, isLeftHanded);

  if (!canonical.frames || canonical.frames.length === 0) {
    return {
      score: 0,
      honeyBoom: false,
      swingConfidence: {
        overall: 0,
        tier: 'low' as const,
        components: { jointVisibility: 0, cameraAngle: 0, phaseDetection: 0, frameCoverage: 0 },
      },
      cameraAngleResult: {
        angle: 'unknown' as const,
        shoulderSpread: 0,
        hipSpread: 0,
        avgSpread: 0,
        weights: { spineAngle: 0, leftElbowAngle: 0, rightElbowAngle: 0, leftKneeAngle: 0, rightKneeAngle: 0, hipRotation: 0, shoulderTilt: 0, tempo: 0 },
      },
    };
  }

  const trail = buildTrailPoints(canonical);
  const phases = detectSwingPhases(trail);

  const addressFrame = averageFrames(canonical.frames, 0, Math.min(9, canonical.frames.length - 1));

  let angles: GolfAngles;
  let frameDebug: FrameSelectionDebug;
  let isHeuristicPhases = false;

  if (shouldFallback(canonical.frames, phases)) {
    const midFrame = canonical.frames[Math.floor(canonical.frames.length / 2)];
    angles = calculateGolfAngles(midFrame);
    frameDebug = { frame_selection_method: 'mid_frame_fallback' };
  } else {
    const result = computePhaseWindowedAngles(canonical.frames, phases);
    angles = result.angles;
    frameDebug = result.debug;
    isHeuristicPhases = true;
  }

  const cameraAngle = detectCameraAngle(addressFrame);

  const foreshorteningResult = correctForeshortening(angles, cameraAngle);
  angles = foreshorteningResult.angles;

  const tiltResult = applyTiltCorrection(angles, gravityReadings);
  if (tiltResult.debug.correctionApplied) {
    angles = { ...angles, ...tiltResult.corrected };
  }

  const rawTempo = calculateTempo(phases);

  // Withhold tempo when phase detection is unreliable — scores neutral 50 instead
  const tempo = rawTempo && isTempoTrustworthy(rawTempo, phases) ? rawTempo : null;

  const scoring = scoreSwing({
    angles,
    tempo,
    weights: cameraAngle.weights,
  });

  const swingConfidence = computeSwingConfidence(
    canonical.frames,
    cameraAngle,
    isHeuristicPhases,
  );

  return {
    score: scoring.score,
    honeyBoom: scoring.honeyBoom,
    angles,
    tempo,
    phases,
    swingConfidence,
    cameraAngleResult: cameraAngle,
    swing_debug: {
      ...frameDebug,
      camera_angle: cameraAngle.angle,
      camera_angle_avg_spread: Math.round(cameraAngle.avgSpread * 1000) / 1000,
      camera_angle_shoulder_spread: Math.round(cameraAngle.shoulderSpread * 1000) / 1000,
      camera_angle_hip_spread: Math.round(cameraAngle.hipSpread * 1000) / 1000,
      scoring_breakdown: scoring.breakdown,
      confidence_overall: swingConfidence.overall,
      confidence_tier: swingConfidence.tier,
      confidence_components: swingConfidence.components,
      foreshortening: foreshorteningResult.debug,
      tilt_correction: tiltResult.debug,
    },
  };
}
