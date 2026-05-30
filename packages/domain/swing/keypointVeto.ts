/**
 * keypointVeto.ts — Layer 1 of the smoothing pipeline.
 *
 * A scoped, isolated pre-processing pass that cleans raw pose keypoints BEFORE
 * phase detection. It does NOT alter phase-detection logic — it only cleans the
 * keypoints feeding it.
 *
 * CORE RULE: per joint, track the last UNFLAGGED ("good") frame + position. For
 * the current frame, gap = currentFrame − lastGoodFrame, and the allowed motion
 * scales with the gap (allowed = perJointThreshold × gap, capped at MAX_GAP),
 * because real motion accumulates over time. A frame within `allowed` of the
 * last good position is GOOD (advances the anchor); otherwise it is FLAGGED and
 * the anchor is NOT advanced, so a teleport cannot poison the following read.
 *
 * Short flagged runs (length 1–2) are linear-interpolated between the bounding
 * good frames; long runs (length ≥3) are left as-is and marked UNTRUSTED in the
 * returned map for downstream consumers to read.
 *
 * Thresholds are an EXTERNAL ASSUMPTION (N=4 swings, /tmp/veto_analysis.md) —
 * see PER_JOINT_THRESHOLD. Pure function, no UI/native deps.
 */

import type { JointName, NormalizedJoint, PoseFrame } from '@/packages/pose/PoseTypes';

// ---------------------------------------------------------------------------
// Tracked joints + thresholds
// ---------------------------------------------------------------------------

export type TrackedJoint =
  | 'leftWrist' | 'rightWrist'
  | 'leftElbow' | 'rightElbow'
  | 'leftShoulder' | 'rightShoulder'
  | 'leftHip' | 'rightHip'
  | 'leftKnee' | 'rightKnee'
  | 'leftAnkle' | 'rightAnkle'
  | 'leftHeel' | 'rightHeel'
  | 'leftFootIndex' | 'rightFootIndex';

// EXTERNAL ASSUMPTION (N=4 swings, /tmp/veto_analysis.md; re-validate vs corpus)
// Per-joint SINGLE-FRAME distance ceiling (normalized [0,1] coords) BEFORE gap-scaling.
export const PER_JOINT_THRESHOLD: Record<TrackedJoint, number> = {
  leftWrist: 0.15, rightWrist: 0.15,
  leftElbow: 0.15, rightElbow: 0.15,
  leftShoulder: 0.12, rightShoulder: 0.12,
  leftHip: 0.05, rightHip: 0.05,
  leftKnee: 0.05, rightKnee: 0.05,
  leftAnkle: 0.05, rightAnkle: 0.05,
  leftHeel: 0.05, rightHeel: 0.05,
  leftFootIndex: 0.05, rightFootIndex: 0.05,
};

export const TRACKED_JOINTS: TrackedJoint[] = Object.keys(
  PER_JOINT_THRESHOLD,
) as TrackedJoint[];

const MAX_GAP = 5;        // cap on gap-scaling. >MAX_GAP consecutive flags => untrust span + re-anchor.
const INIT_WINDOW = 10;   // median-seed window (address is near-stationary -> rejects a bad frame 0).
const STABLE_RUN = 3;     // consecutive in-threshold frames required to re-anchor after a long span.
const INTERP_MAX_RUN = 2; // runs of length <= 2 are interpolated; length >= 3 are untrusted.
const COFLAG_MIN = 2;     // >= this many joints TELEPORT on one frame => frame-level glitch.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FrameState = 'GOOD' | 'TELEPORT' | 'MISSING';

export interface UntrustedMap {
  /** per joint: sorted frame indices left UNTRUSTED (len>=3 runs, or un-anchorable edges) */
  byJoint: Partial<Record<TrackedJoint, number[]>>;
  /** frames where >= COFLAG_MIN tracked joints TELEPORT together (whole-skeleton glitch) */
  frameGlitches: number[];
  stats: {
    totalFlagged: number;   // not-GOOD joint-frames (teleport + missing)
    teleport: number;       // present-but-too-far joint-frames
    missing: number;        // dropout joint-frames (NOT counted as teleports)
    interpolated: number;   // joint-frames replaced by interpolation
    untrusted: number;      // joint-frames left untrusted
    perJointFlagged: Partial<Record<TrackedJoint, number>>;
  };
}

type Pt = { x: number; y: number; confidence?: number };

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function dist(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function extractJointPositions(frames: PoseFrame[], joint: TrackedJoint): (Pt | null)[] {
  return frames.map((f) => {
    const j = f.joints[joint as JointName];
    if (!j || !Number.isFinite(j.x) || !Number.isFinite(j.y)) return null;
    return { x: j.x, y: j.y, confidence: j.confidence };
  });
}

/** Median seed (component-wise) over defined positions within the first INIT_WINDOW frames. */
function medianSeed(positions: (Pt | null)[]): Pt | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const limit = Math.min(INIT_WINDOW, positions.length);
  for (let i = 0; i < limit; i++) {
    const p = positions[i];
    if (p) {
      xs.push(p.x);
      ys.push(p.y);
    }
  }
  if (xs.length === 0) return null;
  return { x: median(xs), y: median(ys) };
}

function firstDefinedIndex(positions: (Pt | null)[], from: number): number | null {
  for (let i = from; i < positions.length; i++) {
    if (positions[i]) return i;
  }
  return null;
}

/** First index s >= from that begins STABLE_RUN consecutive defined frames whose
 *  consecutive pairwise distances are all <= threshold. Returns null if none. */
function findStableRun(
  positions: (Pt | null)[],
  from: number,
  threshold: number,
): number | null {
  for (let s = from; s + STABLE_RUN - 1 < positions.length; s++) {
    let ok = true;
    for (let k = 0; k < STABLE_RUN; k++) {
      const cur = positions[s + k];
      if (!cur) { ok = false; break; }
      if (k > 0) {
        const prev = positions[s + k - 1];
        if (!prev || dist(prev, cur) > threshold) { ok = false; break; }
      }
    }
    if (ok) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase A — per-joint classification (the CORE RULE)
// ---------------------------------------------------------------------------

function classifyJoint(positions: (Pt | null)[], threshold: number): FrameState[] {
  const n = positions.length;
  const states: FrameState[] = new Array(n).fill('MISSING');
  if (n === 0) return states;

  let lastGoodFrame: number;
  let lastGoodPos: Pt;
  let i: number;

  const seed = medianSeed(positions);
  if (seed) {
    lastGoodFrame = -1;      // virtual frame -1 so gap at frame 0 is 1 (single-frame threshold)
    lastGoodPos = seed;
    i = 0;
  } else {
    // No defined frame in the seed window: defer anchoring to the first defined frame.
    const j = firstDefinedIndex(positions, 0);
    if (j === null) {
      // Joint never defined: every frame stays MISSING.
      return states;
    }
    for (let k = 0; k < j; k++) states[k] = 'MISSING';
    states[j] = 'GOOD';
    lastGoodFrame = j;
    lastGoodPos = positions[j]!;
    i = j + 1;
  }

  while (i < n) {
    const p = positions[i];
    if (!p) {
      states[i] = 'MISSING';
      i++;
      continue;
    }

    const gap = i - lastGoodFrame;
    const allowed = threshold * Math.min(gap, MAX_GAP);
    if (dist(p, lastGoodPos) <= allowed) {
      states[i] = 'GOOD';
      lastGoodFrame = i;
      lastGoodPos = p;
      i++;
      continue;
    }

    // Flagged: present but too far. Do NOT advance the anchor.
    states[i] = 'TELEPORT';

    // RE-ANCHOR: once the not-GOOD run reaches MAX_GAP, stop trusting the stale anchor.
    if (i - lastGoodFrame >= MAX_GAP) {
      const s = findStableRun(positions, i + 1, threshold);
      if (s === null) {
        // No stable run remains: mark the rest by kind and stop.
        for (let k = i + 1; k < n; k++) {
          states[k] = positions[k] ? 'TELEPORT' : 'MISSING';
        }
        break;
      }
      // Mark the span between the stale anchor and the new one by kind.
      for (let k = i + 1; k < s; k++) {
        states[k] = positions[k] ? 'TELEPORT' : 'MISSING';
      }
      states[s] = 'GOOD';
      lastGoodFrame = s;
      lastGoodPos = positions[s]!;
      i = s + 1;
      continue;
    }

    i++;
  }

  return states;
}

/** Per-frame classification for every tracked joint. Exposed for tests/diagnostics. */
export function classifyKeypointStates(
  frames: PoseFrame[],
): Record<TrackedJoint, FrameState[]> {
  const out = {} as Record<TrackedJoint, FrameState[]>;
  for (const joint of TRACKED_JOINTS) {
    const positions = extractJointPositions(frames, joint);
    out[joint] = classifyJoint(positions, PER_JOINT_THRESHOLD[joint]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase B + assembly — interpolate vs untrust, build cleaned frames + map
// ---------------------------------------------------------------------------

/** Runs of consecutive not-GOOD (TELEPORT | MISSING) frames. */
function notGoodRuns(states: FrameState[]): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let i = 0; i < states.length; i++) {
    const notGood = states[i] !== 'GOOD';
    if (notGood && start === -1) start = i;
    if (!notGood && start !== -1) {
      runs.push({ start, end: i - 1 });
      start = -1;
    }
  }
  if (start !== -1) runs.push({ start, end: states.length - 1 });
  return runs;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function vetoAndInterpolateKeypoints(
  frames: PoseFrame[],
): { cleanedFrames: PoseFrame[]; untrustedMap: UntrustedMap } {
  // Deep-clone frames so the input is never mutated. Every joint (tracked or not)
  // is copied through; tracked joints may be overwritten with interpolated values.
  const cleanedFrames: PoseFrame[] = frames.map((f) => {
    const joints = {} as Record<JointName, NormalizedJoint | undefined>;
    for (const key of Object.keys(f.joints) as JointName[]) {
      const j = f.joints[key];
      joints[key] = j ? { ...j } : undefined;
    }
    return {
      timestampMs: f.timestampMs,
      joints,
      frameWidth: f.frameWidth,
      frameHeight: f.frameHeight,
    };
  });

  const byJoint: Partial<Record<TrackedJoint, number[]>> = {};
  const perJointFlagged: Partial<Record<TrackedJoint, number>> = {};
  let teleport = 0;
  let missing = 0;
  let interpolated = 0;
  let untrusted = 0;

  // Per-joint state matrix (used for the frame-level co-flag pass too).
  const stateMatrix = {} as Record<TrackedJoint, FrameState[]>;

  for (const joint of TRACKED_JOINTS) {
    const positions = extractJointPositions(frames, joint);
    const states = classifyJoint(positions, PER_JOINT_THRESHOLD[joint]);
    stateMatrix[joint] = states;

    let jointFlagged = 0;
    for (const s of states) {
      if (s === 'TELEPORT') { teleport++; jointFlagged++; }
      else if (s === 'MISSING') { missing++; jointFlagged++; }
    }
    if (jointFlagged > 0) perJointFlagged[joint] = jointFlagged;

    const threshold = PER_JOINT_THRESHOLD[joint];
    const untrustedFrames: number[] = [];

    for (const run of notGoodRuns(states)) {
      const { start, end } = run;
      const len = end - start + 1;
      const prevGood = start - 1 >= 0 && states[start - 1] === 'GOOD' ? start - 1 : null;
      const nextGood = end + 1 < states.length && states[end + 1] === 'GOOD' ? end + 1 : null;

      if (len <= INTERP_MAX_RUN && prevGood !== null && nextGood !== null) {
        const a = positions[prevGood]!;
        const b = positions[nextGood]!;
        for (let k = start; k <= end; k++) {
          const t = (k - prevGood) / (nextGood - prevGood);
          cleanedFrames[k].joints[joint as JointName] = {
            name: joint as JointName,
            x: lerp(a.x, b.x, t),
            y: lerp(a.y, b.y, t),
            confidence:
              a.confidence !== undefined && b.confidence !== undefined
                ? lerp(a.confidence, b.confidence, t)
                : undefined,
          };
          interpolated++;
        }
      } else {
        for (let k = start; k <= end; k++) {
          untrustedFrames.push(k);
          untrusted++;
        }
      }
      void threshold; // threshold already applied during classification
    }

    if (untrustedFrames.length > 0) byJoint[joint] = untrustedFrames;
  }

  // Frame-level co-flag glitch: count TELEPORT only (exclude MISSING dropout).
  const frameGlitches: number[] = [];
  const n = frames.length;
  for (let i = 0; i < n; i++) {
    let teleportCount = 0;
    for (const joint of TRACKED_JOINTS) {
      if (stateMatrix[joint][i] === 'TELEPORT') teleportCount++;
    }
    if (teleportCount >= COFLAG_MIN) frameGlitches.push(i);
  }

  const untrustedMap: UntrustedMap = {
    byJoint,
    frameGlitches,
    stats: {
      totalFlagged: teleport + missing,
      teleport,
      missing,
      interpolated,
      untrusted,
      perJointFlagged,
    },
  };

  return { cleanedFrames, untrustedMap };
}
