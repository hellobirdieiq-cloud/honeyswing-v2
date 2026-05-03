import { JointName, PoseFrame } from "../../pose/PoseTypes";
import { PoseSequence } from "../../pose/PoseTypes";
import { calculateGolfAngles, GolfAngles } from "./angles";
import { CameraAngle, CameraAngleResult, detectCameraAngle } from "./cameraAngle";
import { correctForeshortening, type ForeshorteningDebug } from './foreshorteningCorrection';
import { applyTiltCorrection, type GravityReading, type TiltCorrectionDebug } from './tiltCorrection';
import { toCanonicalSequence } from "./canonicalTransform";
import { detectSwingPhasesWithDebug, DetectedPhase, SwingTrailPoint, type FallbackGate } from "./phaseDetection";
import { calculateTempo, isTempoTrustworthy, type SwingTempo } from "./tempoAnalysis";
import { scoreSwing, ScoringBreakdownEntry } from "./scoring";
import {
  computeSwingConfidence,
  getMetricConfidence,
  shouldShowMetric,
  type SwingConfidence,
} from './confidenceScore';
import { computeAngleGating, type AngleGatingResult } from './angleGating';
import {
  scoreFramePlausibility,
  METRIC_LIMB_CHECKS,
  type ImplausibleFrameDebug,
  type PlausibilityDebugMetric,
} from './implausibleFrameFilter';
import {
  computeVisibilityWeighting,
  computeMetricWeighting,
  type FrameAngleData,
  type GatedMetricKey,
  type VisibilityWeightingResult,
  METRIC_LANDMARKS,
  ALL_METRIC_KEYS,
} from './visibilityWeighting';
import type { ConfidenceComponents } from './confidenceScore';
import { aggregateSwing, type AggregateResult } from './categoryAggregation';

export type FrameSelectionDebug = {
  frame_selection_method: 'phase_windowed' | 'mid_frame_fallback';
  fallback_gate: FallbackGate | null;
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
  angle_gating?: AngleGatingResult;
  visibility_weighting?: VisibilityWeightingResult;
  implausible_frame_filter?: ImplausibleFrameDebug;
};

export type AnalysisResult = {
  score: number | null;
  honeyBoom: boolean;
  angles?: GolfAngles;
  tempo?: SwingTempo | null;
  phases?: DetectedPhase[];
  trail?: SwingTrailPoint[];
  swing_debug?: FrameSelectionDebug;
  swingConfidence: SwingConfidence;
  cameraAngleResult: CameraAngleResult;
  // SCR-0b-0: per-metric measurement confidence, decomposed. SCR-0b-2 applies weighting.
  metricConfidences?: Partial<Record<GatedMetricKey | 'tempo', {
    visibilityConfidence: number;
    cameraConfidence: number;
  }>>;
  // SCR-0b-2: in-memory category aggregation (NOT persisted; HC12).
  aggregate?: AggregateResult;
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
  debug: Omit<FrameSelectionDebug, 'fallback_gate'>;
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
  let hipSpreadDelta: number | null = null;
  if (impactAngles.hipSpreadDelta != null && addressAngles.hipSpreadDelta != null) {
    hipSpreadDelta = impactAngles.hipSpreadDelta - addressAngles.hipSpreadDelta;
  }

  const angles: GolfAngles = {
    spineAngle: addressAngles.spineAngle,
    leftElbowAngle: impactAngles.leftElbowAngle,
    rightElbowAngle: impactAngles.rightElbowAngle,
    leftKneeAngle: addressAngles.leftKneeAngle,
    rightKneeAngle: addressAngles.rightKneeAngle,
    hipSpreadDelta,
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

// ---------------------------------------------------------------------------
// Task 11: Visibility-weighted angle calculation helpers
// ---------------------------------------------------------------------------

/** Map from MediaPipe landmark index → pipeline JointName (only indices used by visibility weighting) */
const LANDMARK_INDEX_TO_JOINT: Partial<Record<number, JointName>> = {
  11: 'leftShoulder', 12: 'rightShoulder',
  13: 'leftElbow',    14: 'rightElbow',
  15: 'leftWrist',    16: 'rightWrist',
  23: 'leftHip',      24: 'rightHip',
  25: 'leftKnee',     26: 'rightKnee',
  27: 'leftAnkle',    28: 'rightAnkle',
};

/** Extract landmark visibilities (confidence values) from a PoseFrame for a given metric. */
function extractLandmarkVisibilities(frame: PoseFrame, metricKey: GatedMetricKey): number[] {
  return METRIC_LANDMARKS[metricKey].map(idx => {
    const jointName = LANDMARK_INDEX_TO_JOINT[idx];
    if (!jointName) return 0;
    return frame.joints[jointName]?.confidence ?? 0;
  });
}

/** Build per-frame angle + visibility data for a metric across a window of frames. */
function buildPipelineFrameData(
  frames: PoseFrame[],
  start: number,
  end: number,
  metricKey: GatedMetricKey,
  extractAngle: (a: GolfAngles) => number | null,
): FrameAngleData[] {
  const s = Math.max(0, start);
  const e = Math.min(frames.length - 1, end);
  const result: FrameAngleData[] = [];
  for (let i = s; i <= e; i++) {
    const value = extractAngle(calculateGolfAngles(frames[i]));
    if (value == null) continue;
    // Task 12: Compute plausibility score for this frame
    const limbCheck = METRIC_LIMB_CHECKS[metricKey];
    const plausibility = limbCheck
      ? scoreFramePlausibility(frames[i], limbCheck).score
      : 1.0;

    result.push({
      angle: value,
      landmarkVisibilities: extractLandmarkVisibilities(frames[i], metricKey),
      plausibility,
    });
  }
  return result;
}

/** Apply visibility weighting to phase-windowed angles. */
function applyVisibilityWeighting(
  frames: PoseFrame[],
  phases: DetectedPhase[],
  currentAngles: GolfAngles,
): { angles: GolfAngles; debug: VisibilityWeightingResult; implausibleDebug: ImplausibleFrameDebug } {
  const topPhase = phases.find(p => p.phase === 'top')!;
  const impactPhase = phases.find(p => p.phase === 'impact')!;

  const addressRange: [number, number] = [0, Math.min(9, frames.length - 1)];
  const impactRange: [number, number] = [impactPhase.index - 2, impactPhase.index + 2];
  const topRange: [number, number] = [topPhase.index - 2, topPhase.index + 2];

  const config: { key: GatedMetricKey; range: [number, number]; extract: (a: GolfAngles) => number | null }[] = [
    { key: 'spineAngle',      range: addressRange, extract: a => a.spineAngle },
    { key: 'leftElbowAngle',  range: impactRange,  extract: a => a.leftElbowAngle },
    { key: 'rightElbowAngle', range: impactRange,  extract: a => a.rightElbowAngle },
    { key: 'leftKneeAngle',   range: addressRange, extract: a => a.leftKneeAngle },
    { key: 'rightKneeAngle',  range: addressRange, extract: a => a.rightKneeAngle },
    { key: 'shoulderTilt',    range: topRange,      extract: a => a.shoulderTilt },
  ];

  const metricFrames: Record<string, FrameAngleData[]> = {};

  for (const { key, range, extract } of config) {
    if (currentAngles[key] == null) continue;
    metricFrames[key] = buildPipelineFrameData(frames, range[0], range[1], key, extract);
  }

  // hipSpreadDelta is a delta (impact - address) — weight each component separately
  if (currentAngles.hipSpreadDelta != null) {
    metricFrames['hipSpreadDelta_address'] = buildPipelineFrameData(
      frames, addressRange[0], addressRange[1], 'hipSpreadDelta', a => a.hipSpreadDelta,
    );
    metricFrames['hipSpreadDelta_impact'] = buildPipelineFrameData(
      frames, impactRange[0], impactRange[1], 'hipSpreadDelta', a => a.hipSpreadDelta,
    );
  }

  const weightingResult = computeVisibilityWeighting(metricFrames);
  const weightedAngles = { ...currentAngles };

  // Apply weighted values for simple metrics
  for (const { key } of config) {
    const result = weightingResult.metrics[key];
    if (result?.applied && Number.isFinite(result.weightedValue)) {
      weightedAngles[key] = Math.round(result.weightedValue);
    }
  }

  // Apply weighted hipSpreadDelta delta
  const addrResult = weightingResult.metrics['hipSpreadDelta_address'];
  const impResult = weightingResult.metrics['hipSpreadDelta_impact'];
  if (addrResult && impResult &&
      (addrResult.applied || impResult.applied) &&
      Number.isFinite(addrResult.weightedValue) && Number.isFinite(impResult.weightedValue)) {
    weightedAngles.hipSpreadDelta = Math.round(impResult.weightedValue - addrResult.weightedValue);
  }

  // Task 12: Build implausible frame debug from already-computed plausibility scores
  const implausibleMetrics: Record<string, PlausibilityDebugMetric> = {};
  let anyImplausible = false;

  const allMetricKeys = [...config.map(c => c.key), 'hipSpreadDelta_address', 'hipSpreadDelta_impact'];
  for (const key of allMetricKeys) {
    const frameData = metricFrames[key];
    if (!frameData) continue;

    const implausibleIndices: number[] = [];
    let worstRatio: number | null = null;

    for (let i = 0; i < frameData.length; i++) {
      if ((frameData[i].plausibility ?? 1.0) <= 0) {
        implausibleIndices.push(i);
      }
    }

    if (implausibleIndices.length > 0) anyImplausible = true;

    implausibleMetrics[key] = {
      framesChecked: frameData.length,
      framesImplausible: implausibleIndices.length,
      implausibleIndices,
      worstRatio,
    };
  }

  const implausibleDebug: ImplausibleFrameDebug = {
    version: '12.1.0',
    applied: anyImplausible,
    metrics: implausibleMetrics,
  };

  return { angles: weightedAngles, debug: weightingResult, implausibleDebug };
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
        weights: { spineAngle: 0, leftElbowAngle: 0, rightElbowAngle: 0, leftKneeAngle: 0, rightKneeAngle: 0, hipSpreadDelta: 0, shoulderTilt: 0, tempo: 0 },
      },
    };
  }

  const trail = buildTrailPoints(canonical);
  const { phases, fallbackGate } = detectSwingPhasesWithDebug(trail);

  const addressFrame = averageFrames(canonical.frames, 0, Math.min(9, canonical.frames.length - 1));

  let angles: GolfAngles;
  let frameDebug: Omit<FrameSelectionDebug, 'fallback_gate'>;
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

  // Task 11: Visibility-weighted angle calculation (phase-windowed path only)
  // Task 12: Implausible frame filter integrated into visibility weighting
  let visibilityWeightingDebug: VisibilityWeightingResult | undefined;
  let implausibleFrameDebug: ImplausibleFrameDebug | undefined;
  if (isHeuristicPhases) {
    const visWeighting = applyVisibilityWeighting(canonical.frames, phases, angles);
    angles = visWeighting.angles;
    visibilityWeightingDebug = visWeighting.debug;
    implausibleFrameDebug = visWeighting.implausibleDebug;
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

  const angleGating = computeAngleGating(foreshorteningResult.debug.estimatedAngleDegrees ?? 0);

  // SCR-0b-0: expose per-metric measurement confidence (decomposed). Heuristic
  // path reads avgWeight from MetricWeightingResult; mid_frame_fallback path
  // has no visibility data so the record stays empty. SCR-0b-2 owns aggregation.
  const metricConfidences: Partial<Record<GatedMetricKey | 'tempo', {
    visibilityConfidence: number;
    cameraConfidence: number;
  }>> = {};
  if (isHeuristicPhases) {
    for (const key of ALL_METRIC_KEYS) {
      metricConfidences[key] = getMetricConfidence(
        key,
        cameraAngle.weights,
        visibilityWeightingDebug ?? null,
      );
    }
    metricConfidences.tempo = {
      visibilityConfidence: 1,
      cameraConfidence: cameraAngle.weights.tempo ?? 1,
    };
  }

  const aggregate = aggregateSwing(scoring, metricConfidences);

  return {
    score: scoring.score,
    honeyBoom: scoring.honeyBoom,
    angles,
    tempo,
    phases,
    trail,
    swingConfidence,
    cameraAngleResult: cameraAngle,
    metricConfidences,
    aggregate,
    swing_debug: {
      ...frameDebug,
      fallback_gate: fallbackGate,
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
      angle_gating: angleGating,
      visibility_weighting: visibilityWeightingDebug,
      implausible_frame_filter: implausibleFrameDebug,
    },
  };
}
