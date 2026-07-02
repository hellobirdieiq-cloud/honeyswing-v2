import { JointName, PoseFrame } from "../../pose/PoseTypes";
import { PoseSequence } from "../../pose/PoseTypes";
import { vetoAndInterpolateKeypoints, type UntrustedMap } from "./keypointVeto";
import {
  correctLowerBodyIdentity,
  toIdentityDebug,
  type LowerBodyIdentityDebug,
} from "./lowerBodyIdentity";
import { calculateGolfAngles, GolfAngles, Z_RANGE_THRESHOLD } from "./angles";
import { CameraAngle, CameraAngleResult, detectCameraAngle, detectCameraAngleEarly } from "./cameraAngle";
import { correctForeshortening, type ForeshorteningDebug } from './foreshorteningCorrection';
import { applyTiltCorrection, type GravityReading, type TiltCorrectionDebug } from './tiltCorrection';
import { toCanonicalSequence, CANONICAL_LEAD, CANONICAL_TRAIL } from "./canonicalTransform";
import {
  detectSwingPhasesWithDebug,
  DetectedPhase,
  SwingTrailPoint,
  type FallbackGate,
  type PhaseRuleDebug,
} from "./phaseDetection";
import { detectSwingStart } from "./swingStartDetection";
import { msPerFrameFromFrames, msToFrames } from "./phaseDetectionShared";
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
import { computeLeadWristHinge, type LeadWristHinge } from './wristHinge';
import { computeSyntheticClubheadPath, type SyntheticClubheadPath } from './syntheticClubheadPath';
import { computeFaceToPath, type FaceToPath } from './faceToPath';
import type { WatchImuReading } from './watchImu';

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
  z_trace?: ZTraceDebug;
  keypoint_veto?: UntrustedMap | null;
  keypoint_identity?: LowerBodyIdentityDebug | null;
  phase_rules?: PhaseRuleDebug;
  camera_angle_pre?: CameraAngle;
  lead_wrist_hinge?: LeadWristHinge | null;
  synthetic_clubhead_path?: SyntheticClubheadPath | null;
  face_to_path?: FaceToPath | null;
  // Phase 5 telemetry seam: did this analysis receive a paired watch IMU stream?
  // No scoring consumer yet — impact-anchored use lands in Phase 6.
  watch_imu_present?: boolean;
};

/** Per-swing z-distribution summary for Z_RANGE_THRESHOLD calibration. */
export type ZTraceDebug = {
  z_min: number | null;
  z_max: number | null;
  z_range: number | null;
  use_3d_triggered: boolean;
  z_threshold: number;
  sample_count: number;
  window_frame_counts: {
    address: number;
    top: number;
    impact: number;
  };
};

export type AnalysisResult = {
  score: number | null;
  honeyBoom: boolean;
  cameraAngleValid: boolean;
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

// [EXTERNAL ASSUMPTION] — 3-frame floor confirmed on
// rightElbowAngle (swing 77b49def, 35.6° 1-frame delta).
// Not yet validated vs Dave clinic data. Recalibrate at SCR-CAL.
export const MIN_USABLE_FRAMES = 3;
// 1b: ms siblings of the pipeline frame-window literals (all @ 60fps). Live paths derive
// frame counts from these via msToFrames(ms, msPerFrame); the literals remain the 60fps fallback.
const MIN_USABLE_MS = 50;          // MIN_USABLE_FRAMES (3)
const ADDRESS_WINDOW_MS = 167;     // 10-frame address window → span +9
const PHASE_HALF_WINDOW_MS = 33;   // ±2-frame top/impact window
const MIN_ANALYZE_MS = 333;        // shouldFallback min capture length (20)
const IMPACT_EDGE_LO_MS = 83;      // shouldFallback impact-too-early margin (5)
const IMPACT_EDGE_HI_MS = 100;     // shouldFallback impact-too-late margin (6)

/** Frame count for `ms` at the given rate; falls back to `fallback` when msPerFrame is absent. */
function framesAt(ms: number, msPerFrame: number | undefined, fallback: number): number {
  return msPerFrame != null ? msToFrames(ms, msPerFrame) : fallback;
}

export function computeFrameCountSuppression(
  visibility: VisibilityWeightingResult | undefined,
  msPerFrame?: number,
): string[] {
  if (!visibility) return [];
  const minUsable = framesAt(MIN_USABLE_MS, msPerFrame, MIN_USABLE_FRAMES);
  const out: string[] = [];
  for (const [key, m] of Object.entries(visibility.metrics)) {
    if (m.framesUsed < minUsable) out.push(key);
  }
  return out;
}

function buildTrailPoints(sequence: PoseSequence): SwingTrailPoint[] {
  const points: SwingTrailPoint[] = [];

  for (const frame of sequence.frames) {
    // Honest lead/trail: in canonical space the LEAD arm is right*, the TRAIL arm
    // is left* (CANONICAL_LEAD/TRAIL — single source of truth in canonicalTransform).
    const lead = frame.joints[CANONICAL_LEAD.wrist];
    const trail = frame.joints[CANONICAL_TRAIL.wrist];

    if (!lead || !trail) continue;

    points.push({
      x: (lead.x + trail.x) / 2,
      y: (lead.y + trail.y) / 2,
      timestamp: frame.timestampMs,
      leadX: lead.x,
      leadY: lead.y,
      trailX: trail.x,
      trailY: trail.y,
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
  // Guard parity with computeZTrace (:474): an out-of-range request (s > e) slices to an
  // empty window → undefined midFrame → crash. Fall back to the nearest valid single frame.
  const window = s > e
    ? [frames[Math.min(frames.length - 1, Math.max(0, start))]]
    : frames.slice(s, e + 1);
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
  addressFrameIdx?: number,
  // Rate for the address/top/impact measurement windows (falls back to 60fps literals).
  msPerFrame?: number,
): PhaseWindowResult {
  const addressPhase = phases.find(p => p.phase === 'takeaway')!;
  const topPhase = phases.find(p => p.phase === 'top')!;
  const impactPhase = phases.find(p => p.phase === 'impact')!;

  const addrSpan = framesAt(ADDRESS_WINDOW_MS, msPerFrame, 10) - 1; // [idx, idx+span] = 10-frame window
  const half = framesAt(PHASE_HALF_WINDOW_MS, msPerFrame, 2);       // ±half around top/impact

  // Assumes capture starts at address. May need wrist-velocity gate if users start recording mid-backswing.
  const addressFrame = averageFrames(
    frames,
    addressFrameIdx ?? 0,
    (addressFrameIdx ?? 0) + addrSpan,
  );
  const impactFrame = averageFrames(frames, impactPhase.index - half, impactPhase.index + half);
  const topFrame = averageFrames(frames, topPhase.index - half, topPhase.index + half);

  const addressAngles = calculateGolfAngles(addressFrame);
  const impactAngles = calculateGolfAngles(impactFrame);
  const topAngles = calculateGolfAngles(topFrame);

  // Hip rotation as delta: how much the hips opened from address to impact
  let hipSpreadDelta: number | null = null;
  if (impactAngles.hipSpreadDelta != null && addressAngles.hipSpreadDelta != null) {
    hipSpreadDelta = impactAngles.hipSpreadDelta - addressAngles.hipSpreadDelta;
  }

  // Spine drift: signed lateral displacement of the shoulder midpoint (canonical x,
  // normalized 0–1) from address to top of backswing. Positive = away from target (sway);
  // negative = toward target (reverse pivot).
  let spineDrift: number | null = null;
  const aLS = addressFrame.joints.leftShoulder;
  const aRS = addressFrame.joints.rightShoulder;
  const tLS = topFrame.joints.leftShoulder;
  const tRS = topFrame.joints.rightShoulder;
  if (aLS && aRS && tLS && tRS) {
    const addressMidX = (aLS.x + aRS.x) / 2;
    const topMidX = (tLS.x + tRS.x) / 2;
    spineDrift = topMidX - addressMidX;
  }

  const angles: GolfAngles = {
    spineAngle: addressAngles.spineAngle,
    leftElbowAngle: impactAngles.leftElbowAngle,
    rightElbowAngle: impactAngles.rightElbowAngle,
    leftKneeAngle: addressAngles.leftKneeAngle,
    rightKneeAngle: addressAngles.rightKneeAngle,
    hipSpreadDelta,
    shoulderTilt: topAngles.shoulderTilt,
    spineDrift,
  };

  return {
    angles,
    debug: {
      frame_selection_method: 'phase_windowed',
      address_frame_range: [
        addressFrameIdx ?? 0,
        Math.min((addressFrameIdx ?? 0) + addrSpan, frames.length - 1),
      ],
      impact_frame_index: impactPhase.index,
      backswing_peak_frame_index: topPhase.index,
    },
  };
}

function shouldFallback(
  frames: PoseFrame[],
  phases: DetectedPhase[],
  // Rate for the min-capture-length + impact edge margins (falls back to 60fps literals).
  msPerFrame?: number,
): boolean {
  if (frames.length < framesAt(MIN_ANALYZE_MS, msPerFrame, 20)) return true;
  if (phases.length === 0) return true;
  if (phases.every(p => p.source === 'fallback')) return true;

  const addressPhase = phases.find(p => p.phase === 'takeaway');
  const topPhase = phases.find(p => p.phase === 'top');
  const impactPhase = phases.find(p => p.phase === 'impact');
  if (!addressPhase || !topPhase || !impactPhase) return true;

  const edgeLo = framesAt(IMPACT_EDGE_LO_MS, msPerFrame, 5);
  const edgeHi = framesAt(IMPACT_EDGE_HI_MS, msPerFrame, 6);
  if (impactPhase.index < edgeLo || impactPhase.index > frames.length - edgeHi) return true;

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
  addressIdx: number = 0,
  // Rate for the address/top/impact ranges (falls back to 60fps literals).
  msPerFrame?: number,
): { angles: GolfAngles; debug: VisibilityWeightingResult; implausibleDebug: ImplausibleFrameDebug } {
  const topPhase = phases.find(p => p.phase === 'top')!;
  const impactPhase = phases.find(p => p.phase === 'impact')!;

  const addrSpan = framesAt(ADDRESS_WINDOW_MS, msPerFrame, 10) - 1;
  const half = framesAt(PHASE_HALF_WINDOW_MS, msPerFrame, 2);
  const addressRange: [number, number] = [addressIdx, Math.min(addressIdx + addrSpan, frames.length - 1)];
  const impactRange: [number, number] = [impactPhase.index - half, impactPhase.index + half];
  const topRange: [number, number] = [topPhase.index - half, topPhase.index + half];

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

/** Dev-only: compute per-swing z-distribution over address/top/impact frame windows. */
function computeZTrace(
  frames: PoseFrame[],
  phases: DetectedPhase[],
  // Rate for the address/top/impact sample windows (falls back to 60fps literals).
  msPerFrame?: number,
): ZTraceDebug {
  const addrSpan = framesAt(ADDRESS_WINDOW_MS, msPerFrame, 10) - 1;
  const half = framesAt(PHASE_HALF_WINDOW_MS, msPerFrame, 2);
  const addressRange: [number, number] = [0, Math.min(addrSpan, frames.length - 1)];
  const topPhase = phases.find(p => p.phase === 'top');
  const impactPhase = phases.find(p => p.phase === 'impact');
  const topRange: [number, number] | null =
    topPhase ? [topPhase.index - half, topPhase.index + half] : null;
  const impactRange: [number, number] | null =
    impactPhase ? [impactPhase.index - half, impactPhase.index + half] : null;

  const zValues: number[] = [];
  const counts = { address: 0, top: 0, impact: 0 };
  const sample = (range: [number, number] | null, key: 'address' | 'top' | 'impact') => {
    if (!range) return;
    const [s, e] = [Math.max(0, range[0]), Math.min(frames.length - 1, range[1])];
    if (s > e) return;
    for (let i = s; i <= e; i++) {
      counts[key] += 1;
      for (const j of Object.values(frames[i].joints)) {
        const z = j?.z;
        if (z != null && Number.isFinite(z)) zValues.push(z);
      }
    }
  };
  sample(addressRange, 'address');
  sample(topRange, 'top');
  sample(impactRange, 'impact');

  if (zValues.length === 0) {
    return {
      z_min: null, z_max: null, z_range: null,
      use_3d_triggered: false,
      z_threshold: Z_RANGE_THRESHOLD,
      sample_count: 0,
      window_frame_counts: counts,
    };
  }
  const zMin = Math.min(...zValues);
  const zMax = Math.max(...zValues);
  const zRange = zMax - zMin;
  return {
    z_min: Math.round(zMin * 1000) / 1000,
    z_max: Math.round(zMax * 1000) / 1000,
    z_range: Math.round(zRange * 1000) / 1000,
    use_3d_triggered: zRange >= Z_RANGE_THRESHOLD,
    z_threshold: Z_RANGE_THRESHOLD,
    sample_count: zValues.length,
    window_frame_counts: counts,
  };
}

export function analyzePoseSequence(
  sequence: PoseSequence,
  isLeftHanded = false,
  gravityReadings: GravityReading[] = [],
  addressFrameIdx?: number,
  opts?: { skipVeto?: boolean },
  // Phase 5 seam — mirrors gravityReadings (optional, no-ops when empty). No scoring
  // consumer this phase; only surfaced as swing_debug.watch_imu_present telemetry.
  // Impact-spike anchoring against this stream is Phase 6.
  watchImuReadings: WatchImuReading[] = [],
): AnalysisResult {
  // Layer 1 — velocity-veto + interpolation pre-clean. Operates on the raw
  // normalized frames (matches /tmp/veto_analysis.md threshold derivation, which
  // is canonical-invariant since the transform only mirrors x). Phase detection
  // logic is untouched; it simply consumes cleaner keypoints. untrustedMap is a
  // diagnostic surface for later layers — NOT fed into phase detection here.
  //
  // skipVeto bypasses the L1 pass, reproducing the pre-L1 path (canonical =
  // toCanonicalSequence(identity-corrected sequence, mirrorToCanonical)). It
  // exists ONLY for veto-validate.ts test #1 (true veto-vs-no-veto
  // comparison) — no production/app call site passes it. Layer 0 runs in
  // BOTH branches so that comparison holds identity correction constant.
  //
  // Layer 0 — lower-body L/R identity correction (see lowerBodyIdentity.ts).
  // RTMW exchanges the whole lower body's left/right labels in runs the
  // velocity veto cannot fix (sustained swaps have low interior velocity and
  // the veto re-anchors onto the swapped track). Relabel before the veto so
  // it, the canonical mirror, and phase detection see identity-stable legs.
  const identity = correctLowerBodyIdentity(sequence.frames);
  const identitySequence: PoseSequence =
    identity.swappedFrames.length > 0
      ? { ...sequence, frames: identity.frames }
      : sequence;

  // Canonical branch INVERSION (decode conjugation fix): input frames are now
  // faithful-anatomical, but every downstream sign convention (takeaway Δx>0
  // gate, faceOn top/finish x-signals, spineDrift sign) was tuned on the
  // pre-fix corpus, whose RH captures reached this point MIRRORED with
  // appearance-swapped labels — i.e. canonical space = mirror(faithful-RH).
  // To preserve that exact layout for both handedness: mirror RIGHT-handed
  // swings, pass LEFT-handed through (old-RH M(F) via identity ≡ new-RH F via
  // mirror; old-LH M(M(F))=F via mirror ≡ new-LH F via identity). In canonical
  // space, label left* is the TRAIL arm.
  const mirrorToCanonical = !isLeftHanded;

  let canonical: PoseSequence;
  let untrustedMap: UntrustedMap | null;
  // Pre-canonical (unmirrored, normalized, post-veto) sequence — the same x-sign
  // space the face-on lead-thumb crossing rule was validated in. The canonical
  // mirror would negate thumb dx for RH; the face-on impact detector reads thumb
  // from this instead. Frame indices are 1:1 with canonical (veto interpolates,
  // never drops; mirror only flips x), so phase windows line up.
  let preCanonical: PoseSequence;
  if (opts?.skipVeto) {
    canonical = toCanonicalSequence(identitySequence, mirrorToCanonical);
    preCanonical = identitySequence;
    untrustedMap = null;
  } else {
    const veto = vetoAndInterpolateKeypoints(identitySequence.frames);
    const cleanedSequence = { ...identitySequence, frames: veto.cleanedFrames };
    canonical = toCanonicalSequence(cleanedSequence, mirrorToCanonical);
    preCanonical = cleanedSequence;
    untrustedMap = veto.untrustedMap;
  }

  if (!canonical.frames || canonical.frames.length === 0) {
    return {
      score: 0,
      honeyBoom: false,
      cameraAngleValid: false,
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
        footIndexNorm: null,
        weights: { spineAngle: 0, leftElbowAngle: 0, rightElbowAngle: 0, leftKneeAngle: 0, rightKneeAngle: 0, hipSpreadDelta: 0, shoulderTilt: 0, tempo: 0 },
      },
    };
  }

  const trail = buildTrailPoints(canonical);
  // Pipeline window helpers + detectSwingStart index canonical.frames, so they use the FRAMES-based
  // rate (may differ from the dispatcher's trail-based msPerFrame when wrists drop out). Feeds
  // averageFrames windows, min-length guards, and impact edge margins.
  const msPerFrame = msPerFrameFromFrames(canonical.frames);
  const earlyAngle = detectCameraAngleEarly(canonical);
  const { phases, fallbackGate, ruleDebug } = detectSwingPhasesWithDebug({
    canonical,
    trail,
    angle: earlyAngle.angle,
    preCanonical,
    isLeftHanded,
  });

  const phaseAddressIdx = phases.find(p => p.phase === 'takeaway')?.index ?? 0;
  const phaseTopIdx = phases.find(p => p.phase === 'top')?.index ?? canonical.frames.length - 1;
  const swingStart = detectSwingStart(
    canonical.frames,
    { address: phaseAddressIdx, top: phaseTopIdx },
    isLeftHanded,
    earlyAngle.angle,
    msPerFrame,
  );
  const resolvedAddressIdx =
    addressFrameIdx ?? (
      swingStart.reliability === 'HIGH'
        ? swingStart.trueAddressFrame
        : phaseAddressIdx
    );

  const addressFrame = averageFrames(
    canonical.frames,
    resolvedAddressIdx,
    Math.min(resolvedAddressIdx + 9, canonical.frames.length - 1),
  );

  let angles: GolfAngles;
  let frameDebug: Omit<FrameSelectionDebug, 'fallback_gate'>;
  let isHeuristicPhases = false;

  if (shouldFallback(canonical.frames, phases, msPerFrame)) {
    const midFrame = canonical.frames[Math.floor(canonical.frames.length / 2)];
    angles = calculateGolfAngles(midFrame);
    frameDebug = { frame_selection_method: 'mid_frame_fallback' };
  } else {
    const result = computePhaseWindowedAngles(canonical.frames, phases, resolvedAddressIdx, msPerFrame);
    angles = result.angles;
    frameDebug = result.debug;
    isHeuristicPhases = true;
  }

  // Task 11: Visibility-weighted angle calculation (phase-windowed path only)
  // Task 12: Implausible frame filter integrated into visibility weighting
  let visibilityWeightingDebug: VisibilityWeightingResult | undefined;
  let implausibleFrameDebug: ImplausibleFrameDebug | undefined;
  if (isHeuristicPhases) {
    const visWeighting = applyVisibilityWeighting(canonical.frames, phases, angles, resolvedAddressIdx, msPerFrame);
    angles = visWeighting.angles;
    visibilityWeightingDebug = visWeighting.debug;
    implausibleFrameDebug = visWeighting.implausibleDebug;
  }

  // Face-to-path read (swing_debug only for now; UI lands after clinic calibration).
  // Phase-windowed path only — mid-frame fallback has no trustworthy top/impact indices.
  let leadWristHinge: LeadWristHinge | null = null;
  let syntheticClubheadPath: SyntheticClubheadPath | null = null;
  let faceToPath: FaceToPath | null = null;
  if (isHeuristicPhases) {
    leadWristHinge = computeLeadWristHinge(canonical.frames, phases);
    syntheticClubheadPath = computeSyntheticClubheadPath(canonical.frames, phases);
    if (leadWristHinge && syntheticClubheadPath) {
      faceToPath = computeFaceToPath(leadWristHinge, syntheticClubheadPath);
    }
  }

  const cameraAngle = detectCameraAngle(addressFrame);

  const foreshorteningResult = correctForeshortening(angles, cameraAngle);
  angles = foreshorteningResult.angles;

  const tiltResult = applyTiltCorrection(angles, gravityReadings);
  if (tiltResult.debug.correctionApplied) {
    angles = { ...angles, ...tiltResult.corrected };
  }

  const rawTempo = calculateTempo(phases);

  // Partial-capture guard: when the caller did not pin the address frame and the
  // swing-start detector lacks HIGH confidence, the address timestamp is unreliable
  // and any computed tempo is meaningless.
  const addressUnreliable = addressFrameIdx === undefined && swingStart.reliability !== 'HIGH';

  // Withhold tempo when phase detection is unreliable — scores neutral 50 instead
  const tempo = !addressUnreliable && rawTempo && isTempoTrustworthy(rawTempo, phases) ? rawTempo : null;

  const angleGating = computeAngleGating(foreshorteningResult.debug.estimatedAngleDegrees ?? 45);

  const scoring = scoreSwing({
    angles,
    tempo,
    weights: cameraAngle.weights,
    suppressedMetrics: new Set([
      ...angleGating.suppressed,
      ...computeFrameCountSuppression(visibilityWeightingDebug, msPerFrame),
    ]),
  });

  const swingConfidence = computeSwingConfidence(
    canonical.frames,
    cameraAngle,
    isHeuristicPhases,
  );

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
    cameraAngleValid: cameraAngle.angle !== "unknown",
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
      z_trace: computeZTrace(canonical.frames, phases, msPerFrame),
      keypoint_veto: untrustedMap,
      keypoint_identity: toIdentityDebug(identity),
      phase_rules: ruleDebug,
      camera_angle_pre: earlyAngle.angle,
      lead_wrist_hinge: leadWristHinge,
      synthetic_clubhead_path: syntheticClubheadPath,
      face_to_path: faceToPath,
      watch_imu_present: watchImuReadings.length > 0,
    },
  };
}
