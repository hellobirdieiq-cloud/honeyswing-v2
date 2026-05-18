/**
 * Run with: npx tsx scripts/export-faceon-phase-analysis.ts
 *
 * Offline research tooling. Recomputes face-on phase markers for 5 candidate
 * swings and exports per-frame signals + a per-swing summary as CSV.
 *
 * Does NOT touch production code paths:
 *   - does not import phaseDetection.ts / scoring.ts / persistSwing.ts
 *   - does not write to the database
 *   - does not read swing_debug.phases (NULL for these swings) or angle_gating.*
 *     (foreshortening is broken for face-on captures — see plan)
 *
 * Rules: see docs/phase-analysis/faceon-offline-rules.md
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PoseFrame, NormalizedJoint, JointName } from '../packages/pose/PoseTypes';

// ---------------------------------------------------------------------------
// Constants — all in milliseconds. See plan section 5.
// ---------------------------------------------------------------------------

const BASELINE_MS = 833;                 // spec "frames 1-30" at 36 fps
const SUSTAIN_MS = 333;                  // spec "12 consecutive frames" at 36 fps
const ADDRESS_LOCK_MS = 833;             // spec "address frames 0-30" at 36 fps
const RISE_DELTA_MS = 83;                // spec "3-frame delta" at 36 fps
const RISE_SUSTAIN_MS = 111;             // spec "4+ frames" at 36 fps
const TOP_SMOOTH_MS = 83;                // ~3 frames at 36 fps
const TOP_CONFIRM_HALFWINDOW_MS = 139;   // ±5 frames at 36 fps
const ENDFS_SMOOTH_MS = 139;             // 5 frames at 36 fps

const VELOCITY_CONF_MIN = 0.5;
const BASELINE_LOWEST_RATIO = 2 / 3;     // 20 of 30 frames
const TRIGGER_BASELINE_MULT = 2.5;
const CONFIRM_MEAN_MULT = 10;
const RISE_RATE_MIN = 0.03;              // normalized x per RISE_DELTA_MS
const RISE_SUSTAIN_FAILURES_ALLOWED = 1; // k-of-N: up to N-k frames may fail the rise rate
const TOP_ARC_LO = 0.25;
const TOP_ARC_HI = 0.80;

const IMPACT_CORRECTION_FPS_SPLIT = 70;  // <70 fps → 1f, ≥70 fps → 2f

// Version A (V1) end-of-swing
const ENDFS_V1_CAP_MS = 1500;            // upper cap = impact + 1.5s

// Version B (V2) — E_body composite deceleration
const E_BODY_W_THORAX = 0.35;
const E_BODY_W_PELVIS = 0.25;
const E_BODY_W_SHOULDER_LINE = 0.20;
const E_BODY_W_HIP_LINE = 0.15;
const E_BODY_W_HANDS = 0.05;
const E_BODY_SMOOTH_MS = 139;            // 5-frame rolling mean at 36fps
const ENDFS_V2_PEAK_WINDOW_MS = 450;     // post-impact peak search: impact..impact+0.45s
const ENDFS_V2_DECEL_OFFSET_MS = 200;    // start decel search at impact+0.20s
const ENDFS_V2_THRESHOLD_RATIO = 0.15;   // E_body < 0.15 * postImpactPeak
const ENDFS_V2_SUSTAIN_MS = 100;         // condition must hold for 0.10s
const ENDFS_V2_SLOPE_WINDOW_MS = 100;    // slope sampled over 100ms
const ENDFS_V2_FALLBACK_MS = 1500;       // fallback if criterion never met

// Hand-tracking confidence dropout under motion blur is a per-frame event
// (not a time-based one), so this gap limit is intentionally frame-count
// rather than ms. Applied to hand_avg_x only — not velocities.
const HAND_AVG_X_MAX_INTERPOLATE_FRAMES = 10;

const SWING_IDS = [
  '37f42a0b-f23b-419d-82ed-d78e8abb168e',
  '9942e307-bfe5-4eae-9082-3e9588125a21',
  'ed737420-82e4-43cf-a7cd-e3c862f70710',
  '43639b49-1beb-4796-9323-8b31cc79cf7a',
  'd7f96108-ffd7-4767-81bb-9227ee1f1b54',
  '3d78c7ad-9bb4-4072-9eff-7a4dbd38fa54',
  '15e749da-4300-4e3a-99b5-666da6d79efd',
];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const ENV_PATH = join(REPO_ROOT, '.env');
const OUT_DIR = join(REPO_ROOT, 'exports', 'faceon-phase-analysis');
const PER_FRAME_CSV = join(OUT_DIR, 'per-frame-signals.csv');
const SUMMARY_CSV = join(OUT_DIR, 'phase-summary.csv');

// ---------------------------------------------------------------------------
// .env parse (mirrors scripts/analyzeMaster.mjs)
// ---------------------------------------------------------------------------

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  let text = '';
  try {
    text = readFileSync(ENV_PATH, 'utf8');
  } catch {
    return env;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (env[k] === undefined) env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const conf = (j: NormalizedJoint | undefined): number => j?.confidence ?? 0;

function framesFor(ms: number, fps: number): number {
  return Math.max(1, Math.round((ms * fps) / 1000));
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

function estimateFps(frames: PoseFrame[]): { fps: number; defaulted: boolean } {
  const dts: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i].timestampMs - frames[i - 1].timestampMs;
    if (Number.isFinite(dt) && dt > 0) dts.push(dt);
  }
  if (dts.length === 0) return { fps: 36, defaulted: true };
  const m = median(dts);
  if (!Number.isFinite(m) || m <= 0) return { fps: 36, defaulted: true };
  return { fps: 1000 / m, defaulted: false };
}

// 3-point central-difference velocity (normalized units / ms).
// Endpoints set to 0. NaN when any of i-1, i, i+1 has confidence < min.
function jointVelocity(frames: PoseFrame[], name: JointName): number[] {
  const v = new Array<number>(frames.length).fill(0);
  for (let i = 1; i < frames.length - 1; i++) {
    const a = frames[i - 1].joints[name];
    const b = frames[i + 1].joints[name];
    const c = frames[i].joints[name];
    if (!a || !b || !c) {
      v[i] = NaN;
      continue;
    }
    if (
      conf(a) < VELOCITY_CONF_MIN ||
      conf(b) < VELOCITY_CONF_MIN ||
      conf(c) < VELOCITY_CONF_MIN
    ) {
      v[i] = NaN;
      continue;
    }
    const dt = frames[i + 1].timestampMs - frames[i - 1].timestampMs;
    if (!Number.isFinite(dt) || dt <= 0) {
      v[i] = NaN;
      continue;
    }
    v[i] = Math.hypot(b.x - a.x, b.y - a.y) / dt;
  }
  return v;
}

// NaN-aware mean across N parallel arrays. Requires ≥ minCount non-NaN values.
function nanMeanRow(arrays: number[][], i: number, minCount: number): number {
  const present: number[] = [];
  for (const arr of arrays) {
    const x = arr[i];
    if (Number.isFinite(x)) present.push(x);
  }
  if (present.length < minCount) return NaN;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

// Linearly interpolate NaN gaps in `values` of length ≤ maxGap. Gaps that
// extend past either end of the array (no anchor on one side) cannot be
// interpolated and remain NaN. Returns a new array and the count of frames
// that were filled.
function interpolateNaNGaps(
  values: number[],
  maxGap: number,
): { filled: number[]; interpolatedCount: number } {
  const out = values.slice();
  let i = 0;
  let interpolated = 0;
  while (i < out.length) {
    if (Number.isFinite(out[i])) {
      i++;
      continue;
    }
    // Found start of a NaN run. Find its end (first finite value after, or end of array).
    const gapStart = i;
    let j = i;
    while (j < out.length && !Number.isFinite(out[j])) j++;
    const gapEnd = j; // out[gapEnd] is finite, or j === out.length
    const gapLength = gapEnd - gapStart;
    if (gapStart === 0 || gapEnd === out.length) {
      // Edge gap — no anchor on one side; leave NaN.
      i = gapEnd;
      continue;
    }
    if (gapLength > maxGap) {
      i = gapEnd;
      continue;
    }
    const a = out[gapStart - 1];
    const b = out[gapEnd];
    const span = gapEnd - (gapStart - 1); // distance from anchor to anchor
    for (let k = gapStart; k < gapEnd; k++) {
      const t = (k - (gapStart - 1)) / span;
      out[k] = a + (b - a) * t;
      interpolated++;
    }
    i = gapEnd;
  }
  return { filled: out, interpolatedCount: interpolated };
}

function rollingMean(values: number[], window: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const half = Math.floor(window / 2);
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length - 1, i + half);
    let sum = 0;
    let n = 0;
    for (let k = lo; k <= hi; k++) {
      if (Number.isFinite(values[k])) {
        sum += values[k];
        n++;
      }
    }
    out[i] = n > 0 ? sum / n : NaN;
  }
  return out;
}

// Find min index of values[lo..hi] inclusive, ignoring NaN.
function argMinRange(values: number[], lo: number, hi: number): number {
  let best = -1;
  let bestVal = Infinity;
  for (let i = lo; i <= hi; i++) {
    const v = values[i];
    if (Number.isFinite(v) && v < bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return best;
}

function argMaxRange(values: number[], lo: number, hi: number): number {
  let best = -1;
  let bestVal = -Infinity;
  for (let i = lo; i <= hi; i++) {
    const v = values[i];
    if (Number.isFinite(v) && v > bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return best;
}

// Per-frame midpoint of two joints. NaN when either joint is missing.
function midpointSeries(
  frames: PoseFrame[],
  a: JointName,
  b: JointName,
): { x: number[]; y: number[] } {
  const xs = new Array<number>(frames.length).fill(NaN);
  const ys = new Array<number>(frames.length).fill(NaN);
  for (let i = 0; i < frames.length; i++) {
    const ja = frames[i].joints[a];
    const jb = frames[i].joints[b];
    if (ja && jb) {
      xs[i] = (ja.x + jb.x) / 2;
      ys[i] = (ja.y + jb.y) / 2;
    }
  }
  return { x: xs, y: ys };
}

// Central-difference speed (normalized/ms) on a derived 2D point series.
// Endpoints set to 0. NaN when any of i-1, i, i+1 is NaN on either axis.
function pointVelocityFromSeries(
  xs: number[],
  ys: number[],
  frames: PoseFrame[],
): number[] {
  const v = new Array<number>(frames.length).fill(0);
  for (let i = 1; i < frames.length - 1; i++) {
    const xPrev = xs[i - 1];
    const xNext = xs[i + 1];
    const yPrev = ys[i - 1];
    const yNext = ys[i + 1];
    if (
      !Number.isFinite(xPrev) ||
      !Number.isFinite(xNext) ||
      !Number.isFinite(yPrev) ||
      !Number.isFinite(yNext)
    ) {
      v[i] = NaN;
      continue;
    }
    const dt = frames[i + 1].timestampMs - frames[i - 1].timestampMs;
    if (!Number.isFinite(dt) || dt <= 0) {
      v[i] = NaN;
      continue;
    }
    v[i] = Math.hypot(xNext - xPrev, yNext - yPrev) / dt;
  }
  return v;
}

// Per-frame angle (radians) of the line from joint A to joint B. NaN if either
// joint is missing. Range [-π, π] from atan2.
function lineAngleSeries(
  frames: PoseFrame[],
  a: JointName,
  b: JointName,
): number[] {
  const out = new Array<number>(frames.length).fill(NaN);
  for (let i = 0; i < frames.length; i++) {
    const ja = frames[i].joints[a];
    const jb = frames[i].joints[b];
    if (ja && jb) {
      out[i] = Math.atan2(jb.y - ja.y, jb.x - ja.x);
    }
  }
  return out;
}

// Shortest signed angular distance from prev to curr, handling ±π wrap.
function angleDelta(prev: number, curr: number): number {
  let d = curr - prev;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// Central-difference angular speed (|rad|/ms) from an angle series.
// Endpoints set to 0. NaN when any of i-1, i, i+1 is NaN.
function angularVelocityFromAngleSeries(
  angles: number[],
  frames: PoseFrame[],
): number[] {
  const v = new Array<number>(frames.length).fill(0);
  for (let i = 1; i < frames.length - 1; i++) {
    const aPrev = angles[i - 1];
    const aNext = angles[i + 1];
    if (!Number.isFinite(aPrev) || !Number.isFinite(aNext)) {
      v[i] = NaN;
      continue;
    }
    const dt = frames[i + 1].timestampMs - frames[i - 1].timestampMs;
    if (!Number.isFinite(dt) || dt <= 0) {
      v[i] = NaN;
      continue;
    }
    v[i] = Math.abs(angleDelta(aPrev, aNext)) / dt;
  }
  return v;
}

// Median shoulder width (rightShoulder ↔ leftShoulder Euclidean distance) over
// the address-lock window. Used to normalize linear velocity components of E_body.
function lockShoulderWidth(frames: PoseFrame[], fps: number): number {
  const lockWindow = Math.min(framesFor(ADDRESS_LOCK_MS, fps), frames.length);
  const widths: number[] = [];
  for (let i = 0; i < lockWindow; i++) {
    const ls = frames[i].joints.leftShoulder;
    const rs = frames[i].joints.rightShoulder;
    if (ls && rs) {
      widths.push(Math.hypot(rs.x - ls.x, rs.y - ls.y));
    }
  }
  return widths.length > 0 ? median(widths) : NaN;
}

// ---------------------------------------------------------------------------
// Rule 1: Swing start
// ---------------------------------------------------------------------------

interface SwingStartResult {
  index: number | null;
  baseline: number;
  baselineWindow: number;
  baselineSampleCount: number;
  failureReason: string | null;
  baselineLikelyContaminated: boolean;
}

function detectSwingStart(signal3: number[], fps: number): SwingStartResult {
  const baselineWindow = Math.min(framesFor(BASELINE_MS, fps), signal3.length);
  const sustain = framesFor(SUSTAIN_MS, fps);
  const baselineWindowVals: number[] = [];
  for (let i = 0; i < baselineWindow; i++) {
    if (Number.isFinite(signal3[i])) baselineWindowVals.push(signal3[i]);
  }
  if (baselineWindowVals.length === 0) {
    return {
      index: null,
      baseline: NaN,
      baselineWindow,
      baselineSampleCount: 0,
      failureReason: 'no_baseline_samples',
      baselineLikelyContaminated: false,
    };
  }
  const sortedBase = [...baselineWindowVals].sort((a, b) => a - b);
  const lowestN = Math.max(1, Math.floor(BASELINE_LOWEST_RATIO * baselineWindow));
  const lowest = sortedBase.slice(0, Math.min(lowestN, sortedBase.length));
  const baseline = lowest.reduce((a, b) => a + b, 0) / lowest.length;

  const minBase = sortedBase[0];
  const meanBase = baselineWindowVals.reduce((a, b) => a + b, 0) / baselineWindowVals.length;
  const baselineLikelyContaminated =
    meanBase > 0 && (minBase - meanBase) / meanBase > -0.3;

  if (!Number.isFinite(baseline) || baseline <= 0) {
    return {
      index: null,
      baseline,
      baselineWindow,
      baselineSampleCount: baselineWindowVals.length,
      failureReason: 'degenerate_baseline',
      baselineLikelyContaminated,
    };
  }

  const triggerThreshold = TRIGGER_BASELINE_MULT * baseline;
  const confirmThreshold = CONFIRM_MEAN_MULT * baseline;

  for (let i = baselineWindow; i + sustain - 1 < signal3.length; i++) {
    if (!Number.isFinite(signal3[i]) || signal3[i] <= triggerThreshold) continue;
    let sustained = true;
    let sum = 0;
    let n = 0;
    for (let k = i; k < i + sustain; k++) {
      const v = signal3[k];
      if (!Number.isFinite(v) || v <= triggerThreshold) {
        sustained = false;
        break;
      }
      sum += v;
      n++;
    }
    if (!sustained || n === 0) continue;
    const meanSustain = sum / n;
    if (meanSustain <= confirmThreshold) continue;
    return {
      index: i,
      baseline,
      baselineWindow,
      baselineSampleCount: baselineWindowVals.length,
      failureReason: null,
      baselineLikelyContaminated,
    };
  }
  return {
    index: null,
    baseline,
    baselineWindow,
    baselineSampleCount: baselineWindowVals.length,
    failureReason: 'no_sustained_trigger',
    baselineLikelyContaminated,
  };
}

// ---------------------------------------------------------------------------
// Rule 2: Impact
// ---------------------------------------------------------------------------

interface ImpactResult {
  index: number | null;
  candidateIndex: number | null;
  footRefX: number | null;
  footRefStdDev: number;
  footRefSamples: number;
  thumbFallback: boolean;
  correctionFrames: number;
  correctionMs: number;
  failureReason: string | null;
}

function buildHandAvgX(frames: PoseFrame[]): {
  hand: number[];
  handRaw: number[];
  thumbFallback: boolean;
} {
  let thumbFallbackCount = 0;
  let bothPresent = 0;
  const hand = new Array<number>(frames.length).fill(NaN);
  const handRaw = new Array<number>(frames.length).fill(NaN);
  for (let i = 0; i < frames.length; i++) {
    const rw = frames[i].joints.rightWrist;
    const th = frames[i].joints.rightThumb;

    // Confidence-floored variant — used by the impact rule.
    if (rw && conf(rw) >= VELOCITY_CONF_MIN && th && conf(th) >= VELOCITY_CONF_MIN) {
      hand[i] = (rw.x + th.x) / 2;
      bothPresent++;
    } else if (rw && conf(rw) >= VELOCITY_CONF_MIN) {
      hand[i] = rw.x;
      thumbFallbackCount++;
    }

    // Raw variant — no confidence filter. Whatever the pose tracker emitted.
    if (rw && th) {
      handRaw[i] = (rw.x + th.x) / 2;
    } else if (rw) {
      handRaw[i] = rw.x;
    }
  }
  const thumbFallback = bothPresent === 0 || thumbFallbackCount > bothPresent;
  return { hand, handRaw, thumbFallback };
}

function lockFootRefX(frames: PoseFrame[], fps: number): {
  value: number | null;
  std: number;
  samples: number;
} {
  const lockWindow = Math.min(framesFor(ADDRESS_LOCK_MS, fps), frames.length);
  const samples: number[] = [];
  for (let i = 0; i < lockWindow; i++) {
    const heel = frames[i].joints.leftHeel;
    const ankle = frames[i].joints.leftAnkle;
    if (heel && ankle && conf(heel) >= VELOCITY_CONF_MIN && conf(ankle) >= VELOCITY_CONF_MIN) {
      samples.push((heel.x + ankle.x) / 2);
    }
  }
  if (samples.length === 0) return { value: null, std: 0, samples: 0 };
  return { value: median(samples), std: stddev(samples), samples: samples.length };
}

function detectImpact(
  hand: number[],
  footRefX: number | null,
  startIdx: number | null,
  thumbFallback: boolean,
  fps: number,
): ImpactResult {
  const correctionFrames = fps < IMPACT_CORRECTION_FPS_SPLIT ? 1 : 2;
  const correctionMs = (-correctionFrames * 1000) / fps;

  if (footRefX == null) {
    return {
      index: null,
      candidateIndex: null,
      footRefX,
      footRefStdDev: 0,
      footRefSamples: 0,
      thumbFallback,
      correctionFrames,
      correctionMs,
      failureReason: 'no_foot_ref',
    };
  }
  if (startIdx == null) {
    return {
      index: null,
      candidateIndex: null,
      footRefX,
      footRefStdDev: 0,
      footRefSamples: 0,
      thumbFallback,
      correctionFrames,
      correctionMs,
      failureReason: 'no_swing_start',
    };
  }

  const riseDeltaFrames = framesFor(RISE_DELTA_MS, fps);
  const riseSustainFrames = framesFor(RISE_SUSTAIN_MS, fps);

  for (let i = startIdx + 1; i < hand.length; i++) {
    const prev = hand[i - 1];
    const cur = hand[i];
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    if (!(prev < footRefX && cur >= footRefX)) continue;

    // Rise-rate gate: framesFor(111ms) consecutive frames ending at i where
    // hand[k] - hand[k - framesFor(83ms)] >= 0.03. k-of-N slack: up to
    // RISE_SUSTAIN_FAILURES_ALLOWED frames in the window may fail (NaN counts
    // as a failure).
    let sustained = true;
    let failures = 0;
    const sustainStart = i - riseSustainFrames + 1;
    if (sustainStart < riseDeltaFrames) {
      sustained = false;
    } else {
      for (let k = sustainStart; k <= i; k++) {
        const earlier = hand[k - riseDeltaFrames];
        const here = hand[k];
        const passes =
          Number.isFinite(earlier) &&
          Number.isFinite(here) &&
          here - earlier >= RISE_RATE_MIN;
        if (!passes) {
          failures++;
          if (failures > RISE_SUSTAIN_FAILURES_ALLOWED) {
            sustained = false;
            break;
          }
        }
      }
    }
    if (!sustained) continue;

    const corrected = Math.max(0, i + Math.round((correctionMs * fps) / 1000));
    return {
      index: corrected,
      candidateIndex: i,
      footRefX,
      footRefStdDev: 0, // filled by caller
      footRefSamples: 0, // filled by caller
      thumbFallback,
      correctionFrames,
      correctionMs,
      failureReason: null,
    };
  }
  return {
    index: null,
    candidateIndex: null,
    footRefX,
    footRefStdDev: 0,
    footRefSamples: 0,
    thumbFallback,
    correctionFrames,
    correctionMs,
    failureReason: 'no_crossing',
  };
}

// ---------------------------------------------------------------------------
// Rule 3: Top of backswing
// ---------------------------------------------------------------------------

interface TopResult {
  index: number | null;
  zConfirm: boolean;
  shoulderXConfirm: boolean;
  threeSignalAgreement: boolean;
  velocityMinIdx: number | null;
  zMaxIdx: number | null;
  shoulderXMinIdx: number | null;
  failureReason: string | null;
}

function detectTop(
  rightWristVel: number[],
  rightWristZ: number[],
  leftShoulderX: number[],
  startIdx: number | null,
  impactIdx: number | null,
  fps: number,
): TopResult {
  const empty: TopResult = {
    index: null,
    zConfirm: false,
    shoulderXConfirm: false,
    threeSignalAgreement: false,
    velocityMinIdx: null,
    zMaxIdx: null,
    shoulderXMinIdx: null,
    failureReason: null,
  };
  if (startIdx == null || impactIdx == null) {
    return { ...empty, failureReason: 'missing_arc' };
  }
  if (impactIdx <= startIdx + 4) {
    return { ...empty, failureReason: 'arc_too_short' };
  }
  const arcLen = impactIdx - startIdx;
  const lo = startIdx + Math.floor(TOP_ARC_LO * arcLen);
  const hi = startIdx + Math.floor(TOP_ARC_HI * arcLen);

  const smoothWin = framesFor(TOP_SMOOTH_MS, fps);
  const smoothedVel = rollingMean(rightWristVel, smoothWin);
  const velMinIdx = argMinRange(smoothedVel, lo, hi);
  if (velMinIdx < 0) {
    return { ...empty, failureReason: 'no_velocity_min' };
  }

  const halfWin = framesFor(TOP_CONFIRM_HALFWINDOW_MS, fps);
  const cLo = Math.max(0, velMinIdx - halfWin);
  const cHi = Math.min(rightWristVel.length - 1, velMinIdx + halfWin);

  const zMaxIdx = argMaxRange(rightWristZ, cLo, cHi);
  const sxMinIdx = argMinRange(leftShoulderX, cLo, cHi);
  const zConfirm = zMaxIdx >= 0;
  const shoulderXConfirm = sxMinIdx >= 0;

  // Canonical rule: top frame = average of velocity-min, z-max, leftShoulder-x-min
  // when both confirmations fall within ±halfWin of velocity-min. If z is missing
  // entirely from the window (no finite z value), average the two remaining
  // signals. If neither confirms, fall back to velocity-min and flag agreement=false.
  let topIdx: number;
  let agreement: boolean;
  if (zConfirm && shoulderXConfirm) {
    topIdx = Math.round((velMinIdx + zMaxIdx + sxMinIdx) / 3);
    agreement = true;
  } else if (!zConfirm && shoulderXConfirm) {
    topIdx = Math.round((velMinIdx + sxMinIdx) / 2);
    agreement = true;
  } else {
    topIdx = velMinIdx;
    agreement = false;
  }

  return {
    index: topIdx,
    zConfirm,
    shoulderXConfirm,
    threeSignalAgreement: agreement,
    velocityMinIdx: velMinIdx,
    zMaxIdx: zConfirm ? zMaxIdx : null,
    shoulderXMinIdx: shoulderXConfirm ? sxMinIdx : null,
    failureReason: null,
  };
}

// ---------------------------------------------------------------------------
// Rule 4: End of forward swing
// ---------------------------------------------------------------------------

interface EndFsV1Result {
  index: number | null;
  rolledRightShoulderX: number[];
  argmaxIdx: number | null;
  capIdx: number | null;
  failureReason: string | null;
}

// Version A (V1): argmax of rolling-mean rightShoulder.x in [impact, end],
// capped at impact + 1.5s. Both bounds clamped to last frame.
function detectEndForwardSwingV1(
  rightShoulderX: number[],
  impactIdx: number | null,
  fps: number,
): EndFsV1Result {
  const smoothWin = framesFor(ENDFS_SMOOTH_MS, fps);
  const rolled = rollingMean(rightShoulderX, smoothWin);
  if (impactIdx == null) {
    return {
      index: null,
      rolledRightShoulderX: rolled,
      argmaxIdx: null,
      capIdx: null,
      failureReason: 'no_impact',
    };
  }
  const argmax = argMaxRange(rolled, impactIdx, rolled.length - 1);
  if (argmax < 0) {
    return {
      index: null,
      rolledRightShoulderX: rolled,
      argmaxIdx: null,
      capIdx: null,
      failureReason: 'no_finite_rolled_values',
    };
  }
  const cap = Math.min(impactIdx + framesFor(ENDFS_V1_CAP_MS, fps), rolled.length - 1);
  return {
    index: Math.min(argmax, cap),
    rolledRightShoulderX: rolled,
    argmaxIdx: argmax,
    capIdx: cap,
    failureReason: null,
  };
}

interface EndFsV2Result {
  index: number | null;
  criterionMet: boolean;
  postImpactPeak: number;
  threshold: number;
  failureReason: string | null;
}

// Version B (V2): E_body composite deceleration.
// Three conditions, all must hold simultaneously starting at frame k:
//   (1) E_body[k] < 0.15 * postImpactPeak
//   (2) condition (1) holds for the next ENDFS_V2_SUSTAIN_MS frames
//   (3) rolling slope at k is flat or negative (E_body[k+slopeWin] - E_body[k] ≤ 0)
// postImpactPeak = max(E_body) over [impact, impact + 0.45s].
// Search starts at impact + 0.20s. Fallback if no k satisfies = impact + 1.5s.
function detectEndForwardSwingV2(
  eBody: number[],
  impactIdx: number | null,
  fps: number,
): EndFsV2Result {
  if (impactIdx == null) {
    return {
      index: null,
      criterionMet: false,
      postImpactPeak: NaN,
      threshold: NaN,
      failureReason: 'no_impact',
    };
  }
  const N = eBody.length;
  const peakHi = Math.min(impactIdx + framesFor(ENDFS_V2_PEAK_WINDOW_MS, fps), N - 1);
  const peakIdx = argMaxRange(eBody, impactIdx, peakHi);
  if (peakIdx < 0) {
    const fallback = Math.min(impactIdx + framesFor(ENDFS_V2_FALLBACK_MS, fps), N - 1);
    return {
      index: fallback,
      criterionMet: false,
      postImpactPeak: NaN,
      threshold: NaN,
      failureReason: 'no_post_impact_peak',
    };
  }
  const peak = eBody[peakIdx];
  const threshold = ENDFS_V2_THRESHOLD_RATIO * peak;
  const sustainN = framesFor(ENDFS_V2_SUSTAIN_MS, fps);
  const slopeWin = framesFor(ENDFS_V2_SLOPE_WINDOW_MS, fps);
  const searchStart = Math.min(impactIdx + framesFor(ENDFS_V2_DECEL_OFFSET_MS, fps), N - 1);

  for (let k = searchStart; k < N; k++) {
    if (!Number.isFinite(eBody[k])) continue;
    if (eBody[k] >= threshold) continue;

    // Condition 2: every frame in [k, k+sustainN-1] must satisfy threshold.
    const sustainEnd = Math.min(k + sustainN - 1, N - 1);
    let sustainOk = true;
    for (let j = k; j <= sustainEnd; j++) {
      if (!Number.isFinite(eBody[j]) || eBody[j] >= threshold) {
        sustainOk = false;
        break;
      }
    }
    if (!sustainOk) continue;

    // Condition 3: slope across slopeWin from k must be ≤ 0.
    const slopeEnd = Math.min(k + slopeWin, N - 1);
    if (slopeEnd > k && Number.isFinite(eBody[slopeEnd])) {
      const slope = (eBody[slopeEnd] - eBody[k]) / (slopeEnd - k);
      if (slope > 0) continue;
    }

    return { index: k, criterionMet: true, postImpactPeak: peak, threshold, failureReason: null };
  }

  // Fallback: unconditional impact + 1.5s, clamped.
  const fallback = Math.min(impactIdx + framesFor(ENDFS_V2_FALLBACK_MS, fps), N - 1);
  return {
    index: fallback,
    criterionMet: false,
    postImpactPeak: peak,
    threshold,
    failureReason: 'criterion_not_met_used_fallback',
  };
}

// ---------------------------------------------------------------------------
// Phase labeling
// ---------------------------------------------------------------------------

function labelPhase(
  i: number,
  startIdx: number | null,
  topIdx: number | null,
  impactIdx: number | null,
  endFsIdx: number | null,
): string {
  if (startIdx == null && topIdx == null && impactIdx == null && endFsIdx == null) return 'unknown';
  if (endFsIdx != null && i >= endFsIdx) return 'finish';
  if (impactIdx != null && i >= impactIdx) return 'forward_swing';
  if (topIdx != null && i >= topIdx) return 'downswing';
  if (startIdx != null && i >= startIdx) return 'backswing';
  return 'address';
}

// ---------------------------------------------------------------------------
// CSV writing
// ---------------------------------------------------------------------------

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',');
}

function fmt(n: number, decimals = 6): string {
  if (!Number.isFinite(n)) return '';
  return Number(n.toFixed(decimals)).toString();
}

// ---------------------------------------------------------------------------
// Per-swing run
// ---------------------------------------------------------------------------

interface SwingDiagnostic {
  swingId: string;
  frameCount: number;
  fps: number;
  fpsDefaulted: boolean;
  startIdx: number | null;
  topIdx: number | null;
  impactIdx: number | null;
  startTimestampMs: number | null;
  topTimestampMs: number | null;
  impactTimestampMs: number | null;
  endFsV1TimestampMs: number | null;
  endFsV2TimestampMs: number | null;
  baseline: number;
  baselineWindowFrames: number;
  baselineLikelyContaminated: boolean;
  swingStartFailureReason: string | null;
  footRefX: number | null;
  footRefStdDev: number;
  footRefSamples: number;
  thumbFallback: boolean;
  handAvgXInterpolatedFrames: number;
  impactCandidateIdx: number | null;
  impactCorrectionFrames: number;
  impactCorrectionMs: number;
  impactFailureReason: string | null;
  topZConfirm: boolean;
  topShoulderXConfirm: boolean;
  topThreeSignalAgreement: boolean;
  topVelocityMinIdx: number | null;
  topZMaxIdx: number | null;
  topShoulderXMinIdx: number | null;
  topFailureReason: string | null;
  endFsV1Idx: number | null;
  endFsV1ArgmaxIdx: number | null;
  endFsV1CapIdx: number | null;
  endFsV1FailureReason: string | null;
  endFsV2Idx: number | null;
  endFsV2CriterionMet: boolean;
  endFsV2PostImpactPeak: number;
  endFsV2Threshold: number;
  endFsV2FailureReason: string | null;
  shoulderWidth: number;
  phaseOrderingViolationV1: boolean;
  phaseOrderingViolationV2: boolean;
  jointMeanConf: Record<string, number>;
  lowConfidenceJoints: string[];
}

const PER_FRAME_HEADER = [
  'swingId',
  'frameIndex',
  'timestampMs',
  'fps_estimate',
  'rightWrist_x',
  'rightWrist_x_raw',
  'rightWrist_y',
  'rightWrist_z',
  'rightWrist_confidence',
  'leftWrist_x',
  'leftWrist_y',
  'leftWrist_confidence',
  'leftShoulder_x',
  'leftShoulder_y',
  'leftShoulder_confidence',
  'rightShoulder_x',
  'rightShoulder_y',
  'rightShoulder_confidence',
  'leftHip_x',
  'leftHip_y',
  'leftHip_confidence',
  'rightHip_x',
  'rightHip_y',
  'rightHip_confidence',
  'rightThumb_x',
  'rightThumb_confidence',
  'leftHeel_x',
  'leftHeel_confidence',
  'leftAnkle_x',
  'leftAnkle_confidence',
  'rightWrist_velocity',
  'leftWrist_velocity',
  'leftShoulder_velocity',
  'signal3_avg',
  'hand_avg_x',
  'hand_avg_x_raw',
  'foot_ref_x',
  'rightShoulder_x_rolled',
  'E_body',
  'detected_swing_start_frame',
  'detected_top_frame',
  'detected_impact_frame',
  'detected_end_forward_swing_frame_v1',
  'detected_end_forward_swing_frame_v2',
  'phase_label_v1',
  'phase_label_v2',
];

interface PerFrameRows {
  rows: string[];
  diagnostic: SwingDiagnostic;
}

const CRITICAL_JOINTS: JointName[] = [
  'rightWrist',
  'leftWrist',
  'rightThumb',
  'leftHeel',
  'leftAnkle',
  'rightShoulder',
  'leftShoulder',
  'leftHip',
  'rightHip',
];

function meanConfidence(frames: PoseFrame[], name: JointName): number {
  let sum = 0;
  let n = 0;
  for (const f of frames) {
    const j = f.joints[name];
    if (j) {
      sum += conf(j);
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

function processSwing(swingId: string, frames: PoseFrame[]): PerFrameRows {
  const fpsInfo = estimateFps(frames);
  const fps = fpsInfo.fps;

  // Velocities (px/ms equivalent — actually normalized/ms).
  const rwVel = jointVelocity(frames, 'rightWrist');
  const lwVel = jointVelocity(frames, 'leftWrist');
  const lsVel = jointVelocity(frames, 'leftShoulder');
  const signal3: number[] = new Array(frames.length).fill(NaN);
  for (let i = 0; i < frames.length; i++) {
    signal3[i] = nanMeanRow([rwVel, lwVel, lsVel], i, 2);
  }

  // Hand and foot references.
  const { hand: handFiltered, handRaw, thumbFallback } = buildHandAvgX(frames);
  const { filled: hand, interpolatedCount: handAvgXInterpolatedFrames } =
    interpolateNaNGaps(handFiltered, HAND_AVG_X_MAX_INTERPOLATE_FRAMES);
  const footRef = lockFootRefX(frames, fps);

  // Rule 1.
  const startRes = detectSwingStart(signal3, fps);

  // Rule 2 — canonical: hand_avg = (rightWrist.x + rightThumb.x) / 2, no
  // confidence floor on either joint. `handRaw` from buildHandAvgX is exactly
  // that (falls back to rightWrist.x alone if rightThumb is missing entirely).
  const impactRes = detectImpact(handRaw, footRef.value, startRes.index, thumbFallback, fps);
  impactRes.footRefStdDev = footRef.std;
  impactRes.footRefSamples = footRef.samples;

  // Rule 3.
  const rwZ = frames.map((f) => f.joints.rightWrist?.z ?? NaN);
  const lsX = frames.map((f) => f.joints.leftShoulder?.x ?? NaN);
  const topRes = detectTop(rwVel, rwZ, lsX, startRes.index, impactRes.index, fps);

  // E_body composite (used by V2 end-of-swing).
  const sw = lockShoulderWidth(frames, fps);
  const swSafe = Number.isFinite(sw) && sw > 0 ? sw : 1; // guard against divide-by-zero
  const thoraxMid = midpointSeries(frames, 'leftShoulder', 'rightShoulder');
  const pelvisMid = midpointSeries(frames, 'leftHip', 'rightHip');
  const handsMid = midpointSeries(frames, 'leftWrist', 'rightWrist');
  const vThorax = pointVelocityFromSeries(thoraxMid.x, thoraxMid.y, frames);
  const vPelvis = pointVelocityFromSeries(pelvisMid.x, pelvisMid.y, frames);
  const vHands = pointVelocityFromSeries(handsMid.x, handsMid.y, frames);
  const shoulderLineAngle = lineAngleSeries(frames, 'leftShoulder', 'rightShoulder');
  const hipLineAngle = lineAngleSeries(frames, 'leftHip', 'rightHip');
  const omegaShoulder = angularVelocityFromAngleSeries(shoulderLineAngle, frames);
  const omegaHip = angularVelocityFromAngleSeries(hipLineAngle, frames);

  const fin = (x: number) => (Number.isFinite(x) ? x : 0);
  const eRaw = new Array<number>(frames.length).fill(0);
  for (let i = 0; i < frames.length; i++) {
    eRaw[i] =
      E_BODY_W_THORAX * (fin(vThorax[i]) / swSafe) +
      E_BODY_W_PELVIS * (fin(vPelvis[i]) / swSafe) +
      E_BODY_W_SHOULDER_LINE * fin(omegaShoulder[i]) +
      E_BODY_W_HIP_LINE * fin(omegaHip[i]) +
      E_BODY_W_HANDS * (fin(vHands[i]) / swSafe);
  }
  const eBodySmoothed = rollingMean(eRaw, framesFor(E_BODY_SMOOTH_MS, fps));

  // Rule 4 — both versions.
  const rsX = frames.map((f) => f.joints.rightShoulder?.x ?? NaN);
  const endV1 = detectEndForwardSwingV1(rsX, impactRes.index, fps);
  const endV2 = detectEndForwardSwingV2(eBodySmoothed, impactRes.index, fps);

  // Marker-ordering invariants (per version).
  function checkOrdering(endIdx: number | null): boolean {
    let last = -Infinity;
    for (const v of [startRes.index, topRes.index, impactRes.index, endIdx]) {
      if (v == null) continue;
      if (v <= last) return true;
      last = v;
    }
    return false;
  }
  const phaseOrderingViolationV1 = checkOrdering(endV1.index);
  const phaseOrderingViolationV2 = checkOrdering(endV2.index);

  // Joint coverage diagnostic.
  const jointMeanConf: Record<string, number> = {};
  const lowConf: string[] = [];
  for (const j of CRITICAL_JOINTS) {
    const c = meanConfidence(frames, j);
    jointMeanConf[j] = Number(c.toFixed(3));
    if (c < 0.6) lowConf.push(j);
  }

  // Rows.
  const rows: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const rw = f.joints.rightWrist;
    const lw = f.joints.leftWrist;
    const ls = f.joints.leftShoulder;
    const rs = f.joints.rightShoulder;
    const lh = f.joints.leftHip;
    const rh = f.joints.rightHip;
    const th = f.joints.rightThumb;
    const heel = f.joints.leftHeel;
    const ankle = f.joints.leftAnkle;
    rows.push(
      csvRow([
        swingId,
        i,
        fmt(f.timestampMs, 3),
        fmt(fps, 2),
        rw ? fmt(rw.x) : '',
        rw ? fmt(rw.x) : '',
        rw ? fmt(rw.y) : '',
        rw && rw.z != null ? fmt(rw.z) : '',
        rw ? fmt(conf(rw), 3) : '',
        lw ? fmt(lw.x) : '',
        lw ? fmt(lw.y) : '',
        lw ? fmt(conf(lw), 3) : '',
        ls ? fmt(ls.x) : '',
        ls ? fmt(ls.y) : '',
        ls ? fmt(conf(ls), 3) : '',
        rs ? fmt(rs.x) : '',
        rs ? fmt(rs.y) : '',
        rs ? fmt(conf(rs), 3) : '',
        lh ? fmt(lh.x) : '',
        lh ? fmt(lh.y) : '',
        lh ? fmt(conf(lh), 3) : '',
        rh ? fmt(rh.x) : '',
        rh ? fmt(rh.y) : '',
        rh ? fmt(conf(rh), 3) : '',
        th ? fmt(th.x) : '',
        th ? fmt(conf(th), 3) : '',
        heel ? fmt(heel.x) : '',
        heel ? fmt(conf(heel), 3) : '',
        ankle ? fmt(ankle.x) : '',
        ankle ? fmt(conf(ankle), 3) : '',
        fmt(rwVel[i]),
        fmt(lwVel[i]),
        fmt(lsVel[i]),
        fmt(signal3[i]),
        fmt(hand[i]),
        fmt(handRaw[i]),
        footRef.value != null ? fmt(footRef.value) : '',
        fmt(endV1.rolledRightShoulderX[i]),
        fmt(eBodySmoothed[i]),
        startRes.index ?? '',
        topRes.index ?? '',
        impactRes.index ?? '',
        endV1.index ?? '',
        endV2.index ?? '',
        labelPhase(i, startRes.index, topRes.index, impactRes.index, endV1.index),
        labelPhase(i, startRes.index, topRes.index, impactRes.index, endV2.index),
      ]),
    );
  }

  const ts = (idx: number | null): number | null =>
    idx == null ? null : frames[idx]?.timestampMs ?? null;

  const diagnostic: SwingDiagnostic = {
    swingId,
    frameCount: frames.length,
    fps,
    fpsDefaulted: fpsInfo.defaulted,
    startIdx: startRes.index,
    topIdx: topRes.index,
    impactIdx: impactRes.index,
    endFsV1Idx: endV1.index,
    endFsV2Idx: endV2.index,
    startTimestampMs: ts(startRes.index),
    topTimestampMs: ts(topRes.index),
    impactTimestampMs: ts(impactRes.index),
    endFsV1TimestampMs: ts(endV1.index),
    endFsV2TimestampMs: ts(endV2.index),
    baseline: startRes.baseline,
    baselineWindowFrames: startRes.baselineWindow,
    baselineLikelyContaminated: startRes.baselineLikelyContaminated,
    swingStartFailureReason: startRes.failureReason,
    footRefX: footRef.value,
    footRefStdDev: footRef.std,
    footRefSamples: footRef.samples,
    thumbFallback,
    handAvgXInterpolatedFrames,
    impactCandidateIdx: impactRes.candidateIndex,
    impactCorrectionFrames: impactRes.correctionFrames,
    impactCorrectionMs: impactRes.correctionMs,
    impactFailureReason: impactRes.failureReason,
    topZConfirm: topRes.zConfirm,
    topShoulderXConfirm: topRes.shoulderXConfirm,
    topThreeSignalAgreement: topRes.threeSignalAgreement,
    topVelocityMinIdx: topRes.velocityMinIdx,
    topZMaxIdx: topRes.zMaxIdx,
    topShoulderXMinIdx: topRes.shoulderXMinIdx,
    topFailureReason: topRes.failureReason,
    endFsV1ArgmaxIdx: endV1.argmaxIdx,
    endFsV1CapIdx: endV1.capIdx,
    endFsV1FailureReason: endV1.failureReason,
    endFsV2CriterionMet: endV2.criterionMet,
    endFsV2PostImpactPeak: endV2.postImpactPeak,
    endFsV2Threshold: endV2.threshold,
    endFsV2FailureReason: endV2.failureReason,
    shoulderWidth: sw,
    phaseOrderingViolationV1,
    phaseOrderingViolationV2,
    jointMeanConf,
    lowConfidenceJoints: lowConf,
  };

  return { rows, diagnostic };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error(
      '[face-on-phase] Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/EXPO_PUBLIC_SUPABASE_ANON_KEY in .env',
    );
    process.exit(1);
  }

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const allRows: string[] = [PER_FRAME_HEADER.join(',')];
  const diagnostics: SwingDiagnostic[] = [];

  for (const id of SWING_IDS) {
    console.log(`[face-on-phase] fetching ${id}`);
    const { data, error } = await sb
      .from('swings')
      .select('id, motion_frames')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.error(`[face-on-phase] error for ${id}: ${error.message}`);
      continue;
    }
    if (!data || !data.motion_frames) {
      console.error(`[face-on-phase] no motion_frames for ${id}`);
      continue;
    }
    const frames = data.motion_frames as PoseFrame[];
    if (!Array.isArray(frames) || frames.length === 0) {
      console.error(`[face-on-phase] empty motion_frames for ${id}`);
      continue;
    }
    console.log(`[face-on-phase] processing ${id} (${frames.length} frames)`);
    const { rows, diagnostic } = processSwing(id, frames);
    allRows.push(...rows);
    diagnostics.push(diagnostic);

    if (diagnostic.fps < 25 || diagnostic.fps > 50) {
      console.warn(
        `[face-on-phase] WARNING: fps ${diagnostic.fps.toFixed(2)} for ${id} outside expected ~36 ± range`,
      );
    }
  }

  writeFileSync(PER_FRAME_CSV, allRows.join('\n') + '\n', 'utf8');
  console.log(`[face-on-phase] wrote ${PER_FRAME_CSV}`);

  // Summary CSV.
  const summaryHeader = [
    'swingId',
    'frame_count',
    'fps_estimate',
    'fps_defaulted',
    'detected_swing_start_frame',
    'detected_top_frame',
    'detected_impact_frame',
    'detected_end_forward_swing_frame_v1',
    'detected_end_forward_swing_frame_v2',
    'swing_start_timestamp_ms',
    'top_timestamp_ms',
    'impact_timestamp_ms',
    'end_forward_swing_v1_timestamp_ms',
    'end_forward_swing_v2_timestamp_ms',
    'baseline',
    'baseline_window_frames',
    'baseline_likely_contaminated',
    'swing_start_failure_reason',
    'foot_ref_x',
    'foot_ref_x_stddev',
    'foot_ref_samples',
    'impact_thumb_fallback',
    'hand_avg_x_interpolated_frames',
    'impact_candidate_index',
    'impact_correction_frames',
    'impact_correction_ms',
    'impact_failure_reason',
    'top_z_confirm',
    'top_shoulder_x_confirm',
    'top_three_signal_agreement',
    'top_velocity_min_idx',
    'top_z_max_idx',
    'top_shoulder_x_min_idx',
    'top_failure_reason',
    'end_fs_v1_argmax_idx',
    'end_fs_v1_cap_idx',
    'end_fs_v1_failure_reason',
    'end_fs_v2_criterion_met',
    'end_fs_v2_post_impact_peak',
    'end_fs_v2_threshold',
    'end_fs_v2_failure_reason',
    'shoulder_width',
    'phase_ordering_violation_v1',
    'phase_ordering_violation_v2',
    'low_confidence_joints',
    'mean_conf_rightWrist',
    'mean_conf_leftWrist',
    'mean_conf_rightThumb',
    'mean_conf_leftHeel',
    'mean_conf_leftAnkle',
    'mean_conf_rightShoulder',
    'mean_conf_leftShoulder',
    'mean_conf_leftHip',
    'mean_conf_rightHip',
  ];
  const summaryRows: string[] = [summaryHeader.join(',')];
  for (const d of diagnostics) {
    summaryRows.push(
      csvRow([
        d.swingId,
        d.frameCount,
        fmt(d.fps, 2),
        d.fpsDefaulted,
        d.startIdx ?? '',
        d.topIdx ?? '',
        d.impactIdx ?? '',
        d.endFsV1Idx ?? '',
        d.endFsV2Idx ?? '',
        d.startTimestampMs == null ? '' : fmt(d.startTimestampMs, 3),
        d.topTimestampMs == null ? '' : fmt(d.topTimestampMs, 3),
        d.impactTimestampMs == null ? '' : fmt(d.impactTimestampMs, 3),
        d.endFsV1TimestampMs == null ? '' : fmt(d.endFsV1TimestampMs, 3),
        d.endFsV2TimestampMs == null ? '' : fmt(d.endFsV2TimestampMs, 3),
        fmt(d.baseline, 8),
        d.baselineWindowFrames,
        d.baselineLikelyContaminated,
        d.swingStartFailureReason ?? '',
        d.footRefX == null ? '' : fmt(d.footRefX),
        fmt(d.footRefStdDev),
        d.footRefSamples,
        d.thumbFallback,
        d.handAvgXInterpolatedFrames,
        d.impactCandidateIdx ?? '',
        d.impactCorrectionFrames,
        fmt(d.impactCorrectionMs, 3),
        d.impactFailureReason ?? '',
        d.topZConfirm,
        d.topShoulderXConfirm,
        d.topThreeSignalAgreement,
        d.topVelocityMinIdx ?? '',
        d.topZMaxIdx ?? '',
        d.topShoulderXMinIdx ?? '',
        d.topFailureReason ?? '',
        d.endFsV1ArgmaxIdx ?? '',
        d.endFsV1CapIdx ?? '',
        d.endFsV1FailureReason ?? '',
        d.endFsV2CriterionMet,
        Number.isFinite(d.endFsV2PostImpactPeak) ? fmt(d.endFsV2PostImpactPeak, 8) : '',
        Number.isFinite(d.endFsV2Threshold) ? fmt(d.endFsV2Threshold, 8) : '',
        d.endFsV2FailureReason ?? '',
        Number.isFinite(d.shoulderWidth) ? fmt(d.shoulderWidth) : '',
        d.phaseOrderingViolationV1,
        d.phaseOrderingViolationV2,
        d.lowConfidenceJoints.join('|'),
        d.jointMeanConf.rightWrist ?? '',
        d.jointMeanConf.leftWrist ?? '',
        d.jointMeanConf.rightThumb ?? '',
        d.jointMeanConf.leftHeel ?? '',
        d.jointMeanConf.leftAnkle ?? '',
        d.jointMeanConf.rightShoulder ?? '',
        d.jointMeanConf.leftShoulder ?? '',
        d.jointMeanConf.leftHip ?? '',
        d.jointMeanConf.rightHip ?? '',
      ]),
    );
  }
  writeFileSync(SUMMARY_CSV, summaryRows.join('\n') + '\n', 'utf8');
  console.log(`[face-on-phase] wrote ${SUMMARY_CSV}`);

  console.log('[face-on-phase] summary:');
  if (diagnostics.length <= 20) {
    console.table(
      diagnostics.map((d) => ({
        id: d.swingId.slice(0, 8),
        frames: d.frameCount,
        fps: d.fps.toFixed(1),
        start: d.startIdx ?? '—',
        top: d.topIdx ?? '—',
        impact: d.impactIdx ?? '—',
        endFsV1: d.endFsV1Idx ?? '—',
        endFsV2: d.endFsV2Idx ?? '—',
        v2met: d.endFsV2CriterionMet,
        impactFail: d.impactFailureReason ?? '—',
      })),
    );
  } else {
    // Aggregate view for large datasets — full per-swing data is in the summary CSV.
    const startDetected = diagnostics.filter((d) => d.startIdx != null).length;
    const topDetected = diagnostics.filter((d) => d.topIdx != null).length;
    const impactDetected = diagnostics.filter((d) => d.impactIdx != null).length;
    const endFsV1Detected = diagnostics.filter((d) => d.endFsV1Idx != null).length;
    const endFsV2Detected = diagnostics.filter((d) => d.endFsV2Idx != null).length;
    const v2CriterionMet = diagnostics.filter((d) => d.endFsV2CriterionMet).length;

    const fpsBuckets = new Map<string, number>();
    for (const d of diagnostics) {
      const b = `${Math.round(d.fps / 5) * 5}fps`;
      fpsBuckets.set(b, (fpsBuckets.get(b) ?? 0) + 1);
    }

    const impactReasons = new Map<string, number>();
    for (const d of diagnostics) {
      const r = d.impactFailureReason ?? 'detected';
      impactReasons.set(r, (impactReasons.get(r) ?? 0) + 1);
    }

    const startReasons = new Map<string, number>();
    for (const d of diagnostics) {
      const r = d.swingStartFailureReason ?? 'detected';
      startReasons.set(r, (startReasons.get(r) ?? 0) + 1);
    }

    const orderingViolationsV1 = diagnostics.filter((d) => d.phaseOrderingViolationV1).length;
    const orderingViolationsV2 = diagnostics.filter((d) => d.phaseOrderingViolationV2).length;
    const thumbFallbacks = diagnostics.filter((d) => d.thumbFallback).length;

    console.log(`  total swings:          ${diagnostics.length}`);
    console.log(`  swing_start detected:  ${startDetected}`);
    console.log(`  top detected:          ${topDetected}`);
    console.log(`  impact detected:       ${impactDetected}`);
    console.log(`  end_fs_v1 detected:    ${endFsV1Detected}`);
    console.log(`  end_fs_v2 detected:    ${endFsV2Detected}`);
    console.log(`  v2 criterion met:      ${v2CriterionMet}`);
    console.log(`  ordering viol v1:      ${orderingViolationsV1}`);
    console.log(`  ordering viol v2:      ${orderingViolationsV2}`);
    console.log(`  thumb fallbacks:       ${thumbFallbacks}`);
    console.log(`  fps buckets:           ${[...fpsBuckets.entries()].sort().map(([b, n]) => `${b}=${n}`).join(', ')}`);
    console.log(`  swing_start reasons:   ${[...startReasons.entries()].map(([r, n]) => `${r}=${n}`).join(', ')}`);
    console.log(`  impact reasons:        ${[...impactReasons.entries()].map(([r, n]) => `${r}=${n}`).join(', ')}`);
  }

  const failed = diagnostics.filter((d) => d.impactFailureReason != null);
  if (failed.length > 0) {
    console.log(
      `[face-on-phase] ${failed.length}/${diagnostics.length} swings did not detect impact. ` +
        `See impact_failure_reason in the summary CSV.`,
    );
  }
}

main().catch((err) => {
  console.error('[face-on-phase] fatal:', err);
  process.exit(1);
});
