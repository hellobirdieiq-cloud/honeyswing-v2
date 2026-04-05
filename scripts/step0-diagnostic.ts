/**
 * Step 0 Diagnostic — Body Proportion Calibration (Task 12)
 *
 * Determines whether anatomically implausible frames in stored swing data
 * actually affect angle calculations enough to justify building calibration.
 *
 * Usage:
 *   SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx npx tsx scripts/step0-diagnostic.ts
 */

import { createClient } from '@supabase/supabase-js';
import type { JointName, NormalizedJoint, PoseFrame } from '../packages/pose/PoseTypes';
import { calculateGolfAngles, type GolfAngles } from '../packages/domain/swing/angles';

// ---------------------------------------------------------------------------
// Copied verbatim from analysisPipeline.ts:76-135
// ---------------------------------------------------------------------------

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

  const joints = {} as Record<JointName, NormalizedJoint | undefined>;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEGMENT_CONFIDENCE_THRESHOLD = 0.3;

function dist(a: NormalizedJoint, b: NormalizedJoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RatioType = 'upperArm/torso' | 'forearm/upperArm' | 'shoulderWidth/torso';

type FrameRatios = {
  frameIndex: number;
  ratios: Record<RatioType, number>;
};

type SwingResult = {
  swingIndex: number;
  totalFrames: number;
  flaggedCount: number;
  pctFlagged: number;
  topFlagTrigger: RatioType | 'none';
  addressDeltas: Record<string, number | null>; // null = insufficient data
  impactDeltas: Record<string, number | null>;
  maxAbsDelta: number | null;
  addressFlaggedCount: number;
  impactFlaggedCount: number;
};

const METRIC_KEYS = ['spineAngle', 'leftElbowAngle', 'leftKneeAngle', 'hipRotation'] as const;
type MetricKey = typeof METRIC_KEYS[number];

// ---------------------------------------------------------------------------
// Pass 1: Collect segment ratios across all swings
// ---------------------------------------------------------------------------

function getJointIfConfident(
  frame: PoseFrame,
  name: JointName,
): NormalizedJoint | null {
  const j = frame.joints[name];
  if (!j || (j.confidence ?? 0) < SEGMENT_CONFIDENCE_THRESHOLD) return null;
  return j;
}

function computeFrameRatios(frame: PoseFrame, frameIndex: number): FrameRatios | null {
  const ls = getJointIfConfident(frame, 'leftShoulder');
  const rs = getJointIfConfident(frame, 'rightShoulder');
  const le = getJointIfConfident(frame, 'leftElbow');
  const lw = getJointIfConfident(frame, 'leftWrist');
  const lh = getJointIfConfident(frame, 'leftHip');
  // rightHip needed for shoulder width context but not a segment endpoint for torso
  const _rh = getJointIfConfident(frame, 'rightHip');

  if (!ls || !rs || !le || !lw || !lh || !_rh) return null;

  const upperArm = dist(ls, le);
  const forearm = dist(le, lw);
  const torso = dist(ls, lh);
  const shoulderWidth = dist(ls, rs);

  // Guard against zero-length segments
  if (torso === 0 || upperArm === 0) return null;

  return {
    frameIndex,
    ratios: {
      'upperArm/torso': upperArm / torso,
      'forearm/upperArm': forearm / upperArm,
      'shoulderWidth/torso': shoulderWidth / torso,
    },
  };
}

// ---------------------------------------------------------------------------
// Pass 2: Flag frames against global medians
// ---------------------------------------------------------------------------

const DEVIATION_THRESHOLD = 0.25; // 25%

type GlobalMedians = Record<RatioType, number>;

function flagFrames(
  allFrameRatios: FrameRatios[],
  globalMedians: GlobalMedians,
): { flagged: Set<number>; triggerCounts: Record<RatioType, number> } {
  const flagged = new Set<number>();
  const triggerCounts: Record<RatioType, number> = {
    'upperArm/torso': 0,
    'forearm/upperArm': 0,
    'shoulderWidth/torso': 0,
  };

  for (const fr of allFrameRatios) {
    let isFlagged = false;
    for (const rt of Object.keys(fr.ratios) as RatioType[]) {
      const med = globalMedians[rt];
      if (med === 0) continue;
      const deviation = Math.abs(fr.ratios[rt] - med) / med;
      if (deviation > DEVIATION_THRESHOLD) {
        triggerCounts[rt]++;
        isFlagged = true;
      }
    }
    if (isFlagged) flagged.add(fr.frameIndex);
  }

  return { flagged, triggerCounts };
}

// ---------------------------------------------------------------------------
// Impact detection: max wrist displacement
// ---------------------------------------------------------------------------

function detectImpactIndex(frames: PoseFrame[]): number {
  let maxDisp = 0;
  let maxIdx = Math.floor(frames.length / 2); // fallback to midpoint

  for (let i = 1; i < frames.length; i++) {
    const prevLw = frames[i - 1].joints.leftWrist;
    const prevRw = frames[i - 1].joints.rightWrist;
    const currLw = frames[i].joints.leftWrist;
    const currRw = frames[i].joints.rightWrist;

    if (!prevLw || !prevRw || !currLw || !currRw) continue;

    const prevMidX = (prevLw.x + prevRw.x) / 2;
    const prevMidY = (prevLw.y + prevRw.y) / 2;
    const currMidX = (currLw.x + currRw.x) / 2;
    const currMidY = (currLw.y + currRw.y) / 2;

    const dx = currMidX - prevMidX;
    const dy = currMidY - prevMidY;
    const displacement = Math.sqrt(dx * dx + dy * dy);

    if (displacement > maxDisp) {
      maxDisp = displacement;
      maxIdx = i;
    }
  }

  return maxIdx;
}

// ---------------------------------------------------------------------------
// Angle delta computation for a single window
// ---------------------------------------------------------------------------

const MIN_FILTERED_FRAMES = 3;

function extractAngles(frame: PoseFrame): Record<MetricKey, number | null> {
  const a = calculateGolfAngles(frame);
  return {
    spineAngle: a.spineAngle,
    leftElbowAngle: a.leftElbowAngle,
    leftKneeAngle: a.leftKneeAngle,
    hipRotation: a.hipRotation,
  };
}

function computeWindowDeltas(
  frames: PoseFrame[],
  windowStart: number,
  windowEnd: number,
  flaggedSet: Set<number>,
): { deltas: Record<MetricKey, number | null>; flaggedInWindow: number } {
  const s = Math.max(0, windowStart);
  const e = Math.min(frames.length - 1, windowEnd);

  // Extract window frames (all)
  const windowFrames: PoseFrame[] = [];
  const filteredFrames: PoseFrame[] = [];
  let flaggedInWindow = 0;

  for (let i = s; i <= e; i++) {
    windowFrames.push(frames[i]);
    if (flaggedSet.has(i)) {
      flaggedInWindow++;
    } else {
      filteredFrames.push(frames[i]);
    }
  }

  if (windowFrames.length === 0) {
    return {
      deltas: { spineAngle: null, leftElbowAngle: null, leftKneeAngle: null, hipRotation: null },
      flaggedInWindow,
    };
  }

  // All-frames pass
  const avgAll = averageFrames(windowFrames, 0, windowFrames.length - 1);
  const anglesAll = extractAngles(avgAll);

  // Insufficient data guard
  if (filteredFrames.length < MIN_FILTERED_FRAMES) {
    return {
      deltas: { spineAngle: null, leftElbowAngle: null, leftKneeAngle: null, hipRotation: null },
      flaggedInWindow,
    };
  }

  // Clean pass
  const avgClean = averageFrames(filteredFrames, 0, filteredFrames.length - 1);
  const anglesClean = extractAngles(avgClean);

  // Compute deltas
  const deltas: Record<MetricKey, number | null> = {
    spineAngle: null,
    leftElbowAngle: null,
    leftKneeAngle: null,
    hipRotation: null,
  };

  for (const key of METRIC_KEYS) {
    const allVal = anglesAll[key];
    const cleanVal = anglesClean[key];
    if (allVal != null && cleanVal != null) {
      deltas[key] = Math.abs(allVal - cleanVal);
    }
  }

  return { deltas, flaggedInWindow };
}

// ---------------------------------------------------------------------------
// Per-swing analysis
// ---------------------------------------------------------------------------

function analyzeSwing(
  frames: PoseFrame[],
  swingIndex: number,
  globalMedians: GlobalMedians,
  swingFrameRatios: FrameRatios[],
): SwingResult {
  const { flagged, triggerCounts } = flagFrames(swingFrameRatios, globalMedians);

  // Find top trigger
  let topTrigger: RatioType | 'none' = 'none';
  let topCount = 0;
  for (const rt of Object.keys(triggerCounts) as RatioType[]) {
    if (triggerCounts[rt] > topCount) {
      topCount = triggerCounts[rt];
      topTrigger = rt;
    }
  }

  // Detect impact once from full sequence
  const impactIdx = detectImpactIndex(frames);

  // Address window: 0-9, Impact window: impactIdx-2 to impactIdx+2
  const addressResult = computeWindowDeltas(frames, 0, 9, flagged);
  const impactResult = computeWindowDeltas(frames, impactIdx - 2, impactIdx + 2, flagged);

  // Max absolute delta across both windows
  let maxAbsDelta: number | null = null;
  for (const key of METRIC_KEYS) {
    for (const result of [addressResult, impactResult]) {
      const d = result.deltas[key];
      if (d != null && (maxAbsDelta === null || d > maxAbsDelta)) {
        maxAbsDelta = d;
      }
    }
  }

  return {
    swingIndex,
    totalFrames: frames.length,
    flaggedCount: flagged.size,
    pctFlagged: Math.round((flagged.size / frames.length) * 1000) / 10,
    topFlagTrigger: topTrigger,
    addressDeltas: addressResult.deltas,
    impactDeltas: impactResult.deltas,
    maxAbsDelta,
    addressFlaggedCount: addressResult.flaggedInWindow,
    impactFlaggedCount: impactResult.flaggedInWindow,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function generateReport(results: SwingResult[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('  STEP 0 DIAGNOSTIC — Body Proportion Calibration (Task 12)');
  console.log('='.repeat(80));

  // --- Per-swing flagging table ---
  console.log('\n--- Per-Swing Frame Flagging ---\n');
  console.table(
    results.map(r => ({
      swing: r.swingIndex,
      frames: r.totalFrames,
      flagged: r.flaggedCount,
      '%flagged': r.pctFlagged,
      topTrigger: r.topFlagTrigger,
    })),
  );

  // --- Per-swing angle deltas table ---
  console.log('\n--- Per-Swing Angle Deltas (degrees) ---\n');

  const fmt = (v: number | null) => v === null ? 'insuff.' : v.toFixed(1);

  console.table(
    results.map(r => ({
      swing: r.swingIndex,
      'addr:spine': fmt(r.addressDeltas.spineAngle as number | null),
      'addr:elbow': fmt(r.addressDeltas.leftElbowAngle as number | null),
      'addr:knee': fmt(r.addressDeltas.leftKneeAngle as number | null),
      'addr:hip': fmt(r.addressDeltas.hipRotation as number | null),
      'imp:spine': fmt(r.impactDeltas.spineAngle as number | null),
      'imp:elbow': fmt(r.impactDeltas.leftElbowAngle as number | null),
      'imp:knee': fmt(r.impactDeltas.leftKneeAngle as number | null),
      'imp:hip': fmt(r.impactDeltas.hipRotation as number | null),
      maxDelta: r.maxAbsDelta !== null ? r.maxAbsDelta.toFixed(1) : 'n/a',
    })),
  );

  // --- Summary statistics ---
  console.log('\n--- Summary ---\n');

  // Collect all non-null deltas per metric
  const allDeltas: Record<MetricKey, number[]> = {
    spineAngle: [],
    leftElbowAngle: [],
    leftKneeAngle: [],
    hipRotation: [],
  };

  for (const r of results) {
    for (const key of METRIC_KEYS) {
      const ad = r.addressDeltas[key] as number | null;
      const id = r.impactDeltas[key] as number | null;
      if (ad != null) allDeltas[key].push(ad);
      if (id != null) allDeltas[key].push(id);
    }
  }

  const mean = (arr: number[]) => arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
  const max = (arr: number[]) => arr.length === 0 ? 0 : Math.max(...arr);

  console.table(
    METRIC_KEYS.map(key => ({
      metric: key,
      'mean delta': allDeltas[key].length > 0 ? mean(allDeltas[key]).toFixed(2) : 'n/a',
      'max delta': allDeltas[key].length > 0 ? max(allDeltas[key]).toFixed(1) : 'n/a',
      samples: allDeltas[key].length,
    })),
  );

  // % swings with ≥2° and ≥5° movement
  let swingsGte2 = 0;
  let swingsGte5 = 0;

  for (const r of results) {
    if (r.maxAbsDelta !== null && r.maxAbsDelta >= 2) swingsGte2++;
    if (r.maxAbsDelta !== null && r.maxAbsDelta >= 5) swingsGte5++;
  }

  const pctGte2 = Math.round((swingsGte2 / results.length) * 100);
  const pctGte5 = Math.round((swingsGte5 / results.length) * 100);

  console.log(`Swings with any metric ≥2°: ${swingsGte2}/${results.length} (${pctGte2}%)`);
  console.log(`Swings with any metric ≥5°: ${swingsGte5}/${results.length} (${pctGte5}%)`);

  // Address vs impact flagged frames
  let totalAddressFlagged = 0;
  let totalImpactFlagged = 0;
  for (const r of results) {
    totalAddressFlagged += r.addressFlaggedCount;
    totalImpactFlagged += r.impactFlaggedCount;
  }
  console.log(`\nFlagged frames in address windows: ${totalAddressFlagged}`);
  console.log(`Flagged frames in impact windows:  ${totalImpactFlagged}`);
  console.log(`More flags in: ${totalAddressFlagged > totalImpactFlagged ? 'ADDRESS' : totalImpactFlagged > totalAddressFlagged ? 'IMPACT' : 'EQUAL'}`);

  // Median % flagged per swing
  const pctFlaggedArr = results.map(r => r.pctFlagged);
  console.log(`\nMedian % flagged per swing: ${median(pctFlaggedArr).toFixed(1)}%`);

  // Most commonly flagged ratio (global — sum across all swings)
  const globalTriggerCounts: Record<RatioType, number> = {
    'upperArm/torso': 0,
    'forearm/upperArm': 0,
    'shoulderWidth/torso': 0,
  };
  // Re-count would require access to per-swing trigger counts.
  // Use topFlagTrigger as proxy: count how many swings each ratio was the top trigger.
  for (const r of results) {
    if (r.topFlagTrigger !== 'none') {
      globalTriggerCounts[r.topFlagTrigger]++;
    }
  }
  let mostCommon: RatioType = 'upperArm/torso';
  let mcCount = 0;
  for (const rt of Object.keys(globalTriggerCounts) as RatioType[]) {
    if (globalTriggerCounts[rt] > mcCount) {
      mcCount = globalTriggerCounts[rt];
      mostCommon = rt;
    }
  }
  console.log(`Most commonly flagged ratio: ${mostCommon} (top trigger in ${mcCount} swings)`);

  // --- Verdict ---
  console.log('\n' + '='.repeat(80));
  if (pctGte2 < 5) {
    console.log('  VERDICT: ABORT — <5% of swings show ≥2° movement. Calibration not justified.');
  } else if (pctGte2 > 20) {
    console.log('  VERDICT: BUILD — >20% of swings show ≥2° movement. Calibration is warranted.');
  } else {
    console.log('  VERDICT: INVESTIGATE — 5-20% of swings show ≥2° movement. Consider camera-angle bucketing.');
  }
  console.log('='.repeat(80) + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
    process.exit(1);
  }

  const supabase = createClient(url, key);

  console.log('Fetching last 30 swings...');
  const { data, error } = await supabase
    .from('swings')
    .select('motion_frames')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) {
    console.error('Supabase query error:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.error('No swings found.');
    process.exit(1);
  }

  console.log(`Fetched ${data.length} swings.`);

  // --- PASS 1: Collect global ratios ---
  const allRatioArrays: Record<RatioType, number[]> = {
    'upperArm/torso': [],
    'forearm/upperArm': [],
    'shoulderWidth/torso': [],
  };

  // Store per-swing frame ratios for Pass 2
  const perSwingRatios: FrameRatios[][] = [];

  for (const row of data) {
    const frames = row.motion_frames as PoseFrame[];
    if (!frames || !Array.isArray(frames)) {
      perSwingRatios.push([]);
      continue;
    }

    const swingRatios: FrameRatios[] = [];
    for (let i = 0; i < frames.length; i++) {
      const fr = computeFrameRatios(frames[i], i);
      if (fr) {
        swingRatios.push(fr);
        for (const rt of Object.keys(fr.ratios) as RatioType[]) {
          allRatioArrays[rt].push(fr.ratios[rt]);
        }
      }
    }
    perSwingRatios.push(swingRatios);
  }

  // Compute global medians
  const globalMedians: GlobalMedians = {
    'upperArm/torso': median(allRatioArrays['upperArm/torso']),
    'forearm/upperArm': median(allRatioArrays['forearm/upperArm']),
    'shoulderWidth/torso': median(allRatioArrays['shoulderWidth/torso']),
  };

  console.log('\nGlobal medians:');
  console.table(globalMedians);
  console.log(`Total valid ratio samples: ${allRatioArrays['upperArm/torso'].length}`);

  // --- PASS 2: Flag & compute deltas per swing ---
  const results: SwingResult[] = [];

  for (let i = 0; i < data.length; i++) {
    const frames = data[i].motion_frames as PoseFrame[];
    if (!frames || !Array.isArray(frames) || frames.length < 10) {
      continue; // skip swings with too few frames
    }

    const result = analyzeSwing(frames, i, globalMedians, perSwingRatios[i]);
    results.push(result);
  }

  if (results.length === 0) {
    console.error('No valid swings to analyze.');
    process.exit(1);
  }

  // --- PASS 3: Report ---
  generateReport(results);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
