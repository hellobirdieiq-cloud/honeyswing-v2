import type { MotionFrame } from '@/lib/clinic/fetchMotionFrames';

export interface Threshold {
  label: string;
  value: number;
  kind: 'hard' | 'watch';
}

export interface WatchRegion {
  start: number;
  end: number;
}

export interface PhaseSignalResult {
  points: { x: number; y: number }[];
  thresholds: Threshold[];
  triggerFrame: number | null;
  annotations: string[];
  watchRegions: WatchRegion[];
}

export type Handedness = 'left' | 'right';
export type CameraAngle = 'dtl' | 'face_on';

const EMPTY_RESULT: PhaseSignalResult = {
  points: [],
  thresholds: [],
  triggerFrame: null,
  annotations: [],
  watchRegions: [],
};

function emptyFaceOn(): PhaseSignalResult {
  return {
    points: [],
    thresholds: [],
    triggerFrame: null,
    annotations: ['Face-on signal not yet implemented.'],
    watchRegions: [],
  };
}

function leadWristJoint(handedness: Handedness): 'leftWrist' | 'rightWrist' {
  return handedness === 'right' ? 'leftWrist' : 'rightWrist';
}

function trailWristJoint(handedness: Handedness): 'leftWrist' | 'rightWrist' {
  return handedness === 'right' ? 'rightWrist' : 'leftWrist';
}

function trailKneeJoint(handedness: Handedness): 'leftKnee' | 'rightKnee' {
  return handedness === 'right' ? 'rightKnee' : 'leftKnee';
}

function trailHipJoint(handedness: Handedness): 'leftHip' | 'rightHip' {
  return handedness === 'right' ? 'rightHip' : 'leftHip';
}

function trailAnkleJoint(handedness: Handedness): 'leftAnkle' | 'rightAnkle' {
  return handedness === 'right' ? 'rightAnkle' : 'leftAnkle';
}

interface Phase0Core {
  triggerFrame: number | null;
  hard: number;
  watch: number;
  baseline: number;
  dSpreadX: number[];
  watchRegions: WatchRegion[];
}

function _phase0Core(frames: MotionFrame[]): Phase0Core {
  const n = frames.length;
  const spreadX: number[] = new Array(n);
  const midX: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = frames[i].joints;
    spreadX[i] = j.leftHip.x - j.rightHip.x;
    midX[i] = (j.leftWrist.x + j.rightWrist.x) / 2;
  }

  const dSpreadX: number[] = new Array(n);
  dSpreadX[0] = 0;
  for (let i = 1; i < n; i++) dSpreadX[i] = spreadX[i] - spreadX[i - 1];

  const baseFrames = Math.min(10, n);
  let sum = 0;
  for (let i = 0; i < baseFrames; i++) sum += Math.abs(dSpreadX[i]);
  const baseline = baseFrames > 0 ? sum / baseFrames : 0;
  const hard = Math.max(baseline * 3, 0.002);
  const watch = Math.max(baseline * 2, 0.0015);

  let triggerFrame: number | null = null;
  let watchMode = false;
  let watchTimeout = 0;
  let watchStart: number | null = null;
  const watchRegions: WatchRegion[] = [];

  for (let F = 3; F < n - 1; F++) {
    const spreadXRise = spreadX[F] - spreadX[F - 3] > 0.003;
    const midXDrift = Math.abs(midX[F] - midX[F - 3]) > 0.004;

    if (spreadXRise || midXDrift) {
      if (!watchMode) {
        watchMode = true;
        watchStart = F;
      }
      watchTimeout = 5;
    } else if (watchMode) {
      watchTimeout--;
      if (watchTimeout <= 0) {
        if (watchStart !== null) watchRegions.push({ start: watchStart, end: F });
        watchMode = false;
        watchStart = null;
      }
    }

    const threshold = watchMode ? watch : hard;
    if (dSpreadX[F] > threshold && dSpreadX[F + 1] > 0) {
      triggerFrame = F - 1;
      break;
    }
  }

  if (watchMode && watchStart !== null) {
    watchRegions.push({ start: watchStart, end: n - 1 });
  }

  return { triggerFrame, hard, watch, baseline, dSpreadX, watchRegions };
}

interface Phase3Core {
  triggerFrame: number | null;
  searchStart: number;
  searchEnd: number;
}

function _phase3Core(
  frames: MotionFrame[],
  handedness: Handedness,
  msPerFrame: number,
  phase0Trigger: number | null,
): Phase3Core {
  const MIN_TRAVEL = 0.04;
  const swingStart = phase0Trigger ?? 0;
  const searchStart = swingStart + Math.round(200 / msPerFrame);
  const searchEnd = swingStart + Math.round(2000 / msPerFrame);

  const n = frames.length;
  const leadKey = leadWristJoint(handedness);
  const lWx = frames.map((f) => f.joints[leadKey].x);

  // Direction inverted for the faithful-anatomical convention (decode
  // conjugation fix): backswing now carries the wrist x DOWN, so track the
  // running MIN and fire on a confirmed local-MAX reversal (was max/min on
  // the pre-fix mirrored frames).
  let triggerFrame: number | null = null;
  let runningMin = Infinity;
  const loopStart = Math.max(1, searchStart);
  const loopEnd = Math.min(n - 2, searchEnd - 1);

  for (let F = loopStart; F < loopEnd; F++) {
    if (lWx[F] < runningMin) runningMin = lWx[F];
    if (
      lWx[F] > lWx[F - 1] &&
      lWx[F] > lWx[F + 1] &&
      lWx[F + 1] > lWx[F + 2] &&
      lWx[F] > runningMin + MIN_TRAVEL
    ) {
      triggerFrame = F;
      break;
    }
  }

  return { triggerFrame, searchStart, searchEnd };
}

interface Phase4Core {
  triggerFrame: number | null;
  searchStart: number;
  searchEnd: number;
  combinedY: number[];
  handLowFrame: number | null;
}

function _phase4Core(
  frames: MotionFrame[],
  handedness: Handedness,
  msPerFrame: number,
  topFrame: number | null,
): Phase4Core {
  const HAND_LOW_TO_IMPACT_MS = 67;
  const n = frames.length;
  const leadKey = leadWristJoint(handedness);
  const trailKey = trailWristJoint(handedness);
  const combinedY: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    combinedY[i] = frames[i].joints[leadKey].y + frames[i].joints[trailKey].y;
  }

  if (topFrame === null) {
    return {
      triggerFrame: null,
      searchStart: 0,
      searchEnd: 0,
      combinedY,
      handLowFrame: null,
    };
  }

  const searchStart = topFrame + Math.round(100 / msPerFrame);
  const searchEnd = topFrame + Math.round(1500 / msPerFrame);

  let handLowFrame: number | null = null;
  const loopStart = Math.max(1, searchStart);
  const loopEnd = Math.min(n - 2, searchEnd - 1);
  for (let F = loopStart; F < loopEnd; F++) {
    if (
      combinedY[F] > combinedY[F - 1] &&
      combinedY[F] > combinedY[F + 1] &&
      combinedY[F + 1] > combinedY[F + 2]
    ) {
      handLowFrame = F;
      break;
    }
  }

  const triggerFrame =
    handLowFrame !== null
      ? handLowFrame + Math.round(HAND_LOW_TO_IMPACT_MS / msPerFrame)
      : null;

  return { triggerFrame, searchStart, searchEnd, combinedY, handLowFrame };
}

export function computePhase0Signal(
  frames: MotionFrame[] | null,
  _handedness: Handedness,
  _msPerFrame: number,
  cameraAngle: CameraAngle,
): PhaseSignalResult {
  if (cameraAngle === 'face_on') return emptyFaceOn();
  if (!frames || frames.length < 4) return EMPTY_RESULT;

  const core = _phase0Core(frames);
  return {
    points: core.dSpreadX.map((y, x) => ({ x, y })),
    thresholds: [
      { label: 'hard', value: core.hard, kind: 'hard' },
      { label: 'watch', value: core.watch, kind: 'watch' },
    ],
    triggerFrame: core.triggerFrame,
    annotations: [`baseline=${core.baseline.toFixed(4)}`],
    watchRegions: core.watchRegions,
  };
}

export function computePhase1Signal(
  frames: MotionFrame[] | null,
  handedness: Handedness,
  _msPerFrame: number,
  cameraAngle: CameraAngle,
): PhaseSignalResult {
  if (cameraAngle === 'face_on') return emptyFaceOn();
  if (!frames || frames.length < 8) return EMPTY_RESULT;

  const n = frames.length;
  const spineAngles: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = frames[i].joints;
    const midShoulderX = (j.leftShoulder.x + j.rightShoulder.x) / 2;
    const midShoulderY = (j.leftShoulder.y + j.rightShoulder.y) / 2;
    const midHipX = (j.leftHip.x + j.rightHip.x) / 2;
    const midHipY = (j.leftHip.y + j.rightHip.y) / 2;
    const sx = midShoulderX - midHipX;
    const sy = midShoulderY - midHipY;
    spineAngles[i] = (Math.atan2(sx, -sy) * 180) / Math.PI;
  }

  const tKnee = trailKneeJoint(handedness);
  const tHip = trailHipJoint(handedness);
  const tAnkle = trailAnkleJoint(handedness);
  const kneeAngles: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = frames[i].joints;
    const a = Math.atan2(j[tAnkle].y - j[tKnee].y, j[tAnkle].x - j[tKnee].x);
    const b = Math.atan2(j[tHip].y - j[tKnee].y, j[tHip].x - j[tKnee].x);
    kneeAngles[i] = ((a - b) * 180) / Math.PI;
  }

  let triggerFrame: number | null = null;
  const scanStart = Math.min(n - 1, n - 20);
  for (let W = scanStart; W >= 7; W--) {
    let smin = Infinity;
    let smax = -Infinity;
    let kmin = Infinity;
    let kmax = -Infinity;
    for (let i = W - 7; i <= W; i++) {
      if (spineAngles[i] < smin) smin = spineAngles[i];
      if (spineAngles[i] > smax) smax = spineAngles[i];
      if (kneeAngles[i] < kmin) kmin = kneeAngles[i];
      if (kneeAngles[i] > kmax) kmax = kneeAngles[i];
    }
    if (smax - smin < 1.5 && kmax - kmin < 2.0) {
      triggerFrame = W;
      break;
    }
  }

  return {
    points: spineAngles.map((y, x) => ({ x, y })),
    thresholds: [{ label: 'spine var ≤1.5°', value: 1.5, kind: 'hard' }],
    triggerFrame,
    annotations: ['Phase 1: spine+knee only — head joints unavailable. Reliability: LOW.'],
    watchRegions: [],
  };
}

export function computePhase2Signal(
  frames: MotionFrame[] | null,
  _handedness: Handedness,
  msPerFrame: number,
  cameraAngle: CameraAngle,
): PhaseSignalResult {
  if (cameraAngle === 'face_on') return emptyFaceOn();
  if (!frames || frames.length < 4 || msPerFrame <= 0) return EMPTY_RESULT;

  const DIRECTION_FRAMES = Math.max(1, Math.round(167 / msPerFrame));
  const DIRECTION_THRESHOLD = 0.002;
  const n = frames.length;
  const midX: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    midX[i] = (frames[i].joints.leftWrist.x + frames[i].joints.rightWrist.x) / 2;
  }

  // Direction inverted for the faithful-anatomical convention (decode
  // conjugation fix): takeaway Δx is now NEGATIVE in raw frame space for the
  // RH-tuned corpus (was positive on the pre-fix mirrored frames). Gate is
  // handedness-blind by design — sign flip preserves parity.
  let triggerFrame: number | null = null;
  for (let F = DIRECTION_FRAMES; F < n; F++) {
    if (midX[F] - midX[F - DIRECTION_FRAMES] < -DIRECTION_THRESHOLD) {
      let monotonic = true;
      for (let Fp = F - DIRECTION_FRAMES + 1; Fp <= F; Fp++) {
        if (midX[Fp] - midX[Fp - 1] >= 0) {
          monotonic = false;
          break;
        }
      }
      if (monotonic) {
        triggerFrame = F;
        break;
      }
    }
  }

  return {
    points: midX.map((y, x) => ({ x, y })),
    thresholds: [{ label: 'Δx threshold', value: DIRECTION_THRESHOLD, kind: 'hard' }],
    triggerFrame,
    annotations: [`window=${DIRECTION_FRAMES}f (~167ms)`],
    watchRegions: [],
  };
}

export function computePhase3Signal(
  frames: MotionFrame[] | null,
  handedness: Handedness,
  msPerFrame: number,
  cameraAngle: CameraAngle,
): PhaseSignalResult {
  if (cameraAngle === 'face_on') return emptyFaceOn();
  if (!frames || frames.length < 4 || msPerFrame <= 0) return EMPTY_RESULT;

  const phase0 = _phase0Core(frames);
  const phase3 = _phase3Core(frames, handedness, msPerFrame, phase0.triggerFrame);
  const leadKey = leadWristJoint(handedness);

  return {
    points: frames.map((f, x) => ({ x, y: f.joints[leadKey].x })),
    thresholds: [],
    triggerFrame: phase3.triggerFrame,
    annotations: [
      `searchStart=f${phase3.searchStart}`,
      `searchEnd=f${phase3.searchEnd}`,
      'MIN_TRAVEL=0.04',
    ],
    watchRegions: [{ start: phase3.searchStart, end: phase3.searchEnd }],
  };
}

export function computePhase4Signal(
  frames: MotionFrame[] | null,
  handedness: Handedness,
  msPerFrame: number,
  cameraAngle: CameraAngle,
): PhaseSignalResult {
  if (cameraAngle === 'face_on') return emptyFaceOn();
  if (!frames || frames.length < 4 || msPerFrame <= 0) return EMPTY_RESULT;

  const phase0 = _phase0Core(frames);
  const phase3 = _phase3Core(frames, handedness, msPerFrame, phase0.triggerFrame);
  const phase4 = _phase4Core(frames, handedness, msPerFrame, phase3.triggerFrame);

  return {
    points: phase4.combinedY.map((y, x) => ({ x, y })),
    thresholds: [],
    triggerFrame: phase4.triggerFrame,
    annotations: ['hand_low + 67ms', `searchStart=f${phase4.searchStart}`],
    watchRegions: [{ start: phase4.searchStart, end: phase4.searchEnd }],
  };
}

export function computePhase5Signal(
  frames: MotionFrame[] | null,
  handedness: Handedness,
  msPerFrame: number,
  cameraAngle: CameraAngle,
): PhaseSignalResult {
  if (cameraAngle === 'face_on') return emptyFaceOn();
  if (!frames || frames.length < 4 || msPerFrame <= 0) return EMPTY_RESULT;

  const VEL_NOISE_FLOOR = 0.008;
  const phase0 = _phase0Core(frames);
  const phase3 = _phase3Core(frames, handedness, msPerFrame, phase0.triggerFrame);
  const phase4 = _phase4Core(frames, handedness, msPerFrame, phase3.triggerFrame);
  const topFrame = phase3.triggerFrame;
  const impactFrame = phase4.triggerFrame;

  const n = frames.length;
  const leadKey = leadWristJoint(handedness);
  const trailKey = trailWristJoint(handedness);
  const midX: number[] = new Array(n);
  const midY: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const j = frames[i].joints;
    midX[i] = (j[leadKey].x + j[trailKey].x) / 2;
    midY[i] = (j[leadKey].y + j[trailKey].y) / 2;
  }
  const velXY: number[] = new Array(n);
  velXY[0] = 0;
  for (let i = 1; i < n; i++) {
    const dx = midX[i] - midX[i - 1];
    const dy = midY[i] - midY[i - 1];
    velXY[i] = Math.sqrt(dx * dx + dy * dy);
  }

  if (topFrame === null || impactFrame === null) {
    return {
      points: velXY.map((y, x) => ({ x, y })),
      thresholds: [{ label: 'noise floor', value: VEL_NOISE_FLOOR, kind: 'hard' }],
      triggerFrame: null,
      annotations: ['follow_through_complete=false'],
      watchRegions: [],
    };
  }

  const downswingMs = (impactFrame - topFrame) * msPerFrame;
  const searchEnd = Math.min(
    impactFrame + Math.round((downswingMs * 3.0) / msPerFrame),
    n - 1,
  );
  const minFollow = Math.round(300 / msPerFrame);
  const startSearch = impactFrame + minFollow;

  let triggerFrame: number | null = null;
  const loopEnd = Math.min(n - 2, searchEnd - 1);
  for (let F = startSearch; F < loopEnd; F++) {
    if (
      velXY[F] < VEL_NOISE_FLOOR &&
      velXY[F + 1] < VEL_NOISE_FLOOR &&
      velXY[F + 2] < VEL_NOISE_FLOOR
    ) {
      triggerFrame = F;
      break;
    }
  }

  const annotations: string[] = [];
  if (triggerFrame === null) {
    triggerFrame = searchEnd;
    annotations.push('follow_through_complete=false');
  }
  annotations.push(`searchStart=f${startSearch}`, `searchEnd=f${searchEnd}`);

  return {
    points: velXY.map((y, x) => ({ x, y })),
    thresholds: [{ label: 'noise floor', value: VEL_NOISE_FLOOR, kind: 'hard' }],
    triggerFrame,
    annotations,
    watchRegions: [{ start: startSearch, end: searchEnd }],
  };
}

export const PHASE_LABEL_MAP = {
  'hard':                          'Trigger line',
  'watch':                         'Warning line',
  'noise floor':                   'Stopped moving',
  'Δx threshold':                  'Club moving back',
  'spine var ≤1.5°':              'Spine variance < 1.5°',
  'hand_low':                      'Both hands lowest point',
  'MIN_TRAVEL':                    'Minimum travel',
  'follow_through_complete=false': 'Finish not detected',
  'baseline':                      'Baseline',
  'searchStart':                   'Frame search start',
  'searchEnd':                     'Frame search end',
  'velXY':                         'Lead + trail wrist speed',
  'combinedY':                     'Both hands vertical',
  'dSpreadX':                      'Hip rotation speed',
  'midX':                          'Both wrists horizontal',
  'leadWrist.x':                   'Lead wrist horizontal',
  'trailWrist.x':                  'Trail wrist horizontal',
  'Phase 0':                       'Swing Start',
  'Phase 1':                       'Address',
  'Phase 2':                       'Takeaway',
  'Phase 3':                       'Top of Backswing',
  'Phase 4':                       'Impact',
  'Phase 5':                       'Finish',
} as const;
