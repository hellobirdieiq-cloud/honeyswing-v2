import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DTL = [
  '31f52535-6d1b-4de3-8c36-171b2e158bc6',
  '6c421b84-d172-4f9a-8e12-e29ffa9e5eb4',
  '60125e2d-4a20-43be-9886-f9cd8422dca4',
];
const FACEON = [
  'd0343840-aa57-437e-a159-a30f162ec9eb',
  'ffc10eb5-65c4-4691-b309-76689e64f3c9',
  'a77579fe-d00e-45c0-944a-61d40dccf389',
];

// ─── helpers ────────────────────────────────────────────────────────────────

function conf(joint) {
  return joint?.confidence ?? 0;
}

function avgOverFrames(frames, fn) {
  const vals = frames.map(fn).filter(v => v !== null && isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function amplitudeOverFrames(frames, fn) {
  const vals = frames.map(fn).filter(v => v !== null && isFinite(v));
  if (!vals.length) return null;
  return Math.max(...vals) - Math.min(...vals);
}

// ─── signal definitions ──────────────────────────────────────────────────────

function bilateralSpread(jA, jB) {
  return (f) => {
    const a = f.joints[jA], b = f.joints[jB];
    if (!a || !b || conf(a) < 0.5 || conf(b) < 0.5) return null;
    return Math.abs(a.x - b.x);
  };
}

function bodyHeight(f) {
  const nose = f.joints['nose'];
  const lAnkle = f.joints['leftAnkle'];
  const rAnkle = f.joints['rightAnkle'];
  if (!nose || !lAnkle || !rAnkle) return null;
  if (conf(nose) < 0.5 || conf(lAnkle) < 0.5 || conf(rAnkle) < 0.5) return null;
  const midAnkleY = (lAnkle.y + rAnkle.y) / 2;
  return Math.abs(midAnkleY - nose.y);
}

function normalizedFootSpread(f) {
  const h = bodyHeight(f);
  const lFoot = f.joints['leftFootIndex'];
  const rFoot = f.joints['rightFootIndex'];
  if (!h || h === 0 || !lFoot || !rFoot) return null;
  if (conf(lFoot) < 0.5 || conf(rFoot) < 0.5) return null;
  return Math.abs(lFoot.x - rFoot.x) / h;
}

function normalizedHipSpread(f) {
  const h = bodyHeight(f);
  const lHip = f.joints['leftHip'];
  const rHip = f.joints['rightHip'];
  if (!h || h === 0 || !lHip || !rHip) return null;
  if (conf(lHip) < 0.5 || conf(rHip) < 0.5) return null;
  return Math.abs(lHip.x - rHip.x) / h;
}

function hipXvsYRatio(f) {
  // In DTL: hips aligned front-back → small x diff, larger y diff → ratio < 1
  // In face-on: hips side-by-side → larger x diff, small y diff → ratio > 1
  const lHip = f.joints['leftHip'];
  const rHip = f.joints['rightHip'];
  if (!lHip || !rHip || conf(lHip) < 0.5 || conf(rHip) < 0.5) return null;
  const xDiff = Math.abs(lHip.x - rHip.x);
  const yDiff = Math.abs(lHip.y - rHip.y);
  if (yDiff === 0) return null;
  return xDiff / yDiff;
}

function shoulderXvsYRatio(f) {
  const lS = f.joints['leftShoulder'];
  const rS = f.joints['rightShoulder'];
  if (!lS || !rS || conf(lS) < 0.5 || conf(rS) < 0.5) return null;
  const xDiff = Math.abs(lS.x - rS.x);
  const yDiff = Math.abs(lS.y - rS.y);
  if (yDiff === 0) return null;
  return xDiff / yDiff;
}

function footXvsYRatio(f) {
  const lF = f.joints['leftFootIndex'];
  const rF = f.joints['rightFootIndex'];
  if (!lF || !rF || conf(lF) < 0.5 || conf(rF) < 0.5) return null;
  const xDiff = Math.abs(lF.x - rF.x);
  const yDiff = Math.abs(lF.y - rF.y);
  if (yDiff === 0) return null;
  return xDiff / yDiff;
}

function ankleXvsYRatio(f) {
  const lA = f.joints['leftAnkle'];
  const rA = f.joints['rightAnkle'];
  if (!lA || !rA || conf(lA) < 0.5 || conf(rA) < 0.5) return null;
  const xDiff = Math.abs(lA.x - rA.x);
  const yDiff = Math.abs(lA.y - rA.y);
  if (yDiff === 0) return null;
  return xDiff / yDiff;
}

function leftShoulderToRightHipX(f) {
  // Cross-body: torso diagonal in x
  const lS = f.joints['leftShoulder'];
  const rH = f.joints['rightHip'];
  if (!lS || !rH || conf(lS) < 0.5 || conf(rH) < 0.5) return null;
  return Math.abs(lS.x - rH.x);
}

function rightShoulderToLeftHipX(f) {
  const rS = f.joints['rightShoulder'];
  const lH = f.joints['leftHip'];
  if (!rS || !lH || conf(rS) < 0.5 || conf(lH) < 0.5) return null;
  return Math.abs(rS.x - lH.x);
}

// ─── signal registry ─────────────────────────────────────────────────────────

const AVG_SIGNALS = [
  // Bilateral spread (raw)
  { name: 'footIndex_spread', fn: bilateralSpread('leftFootIndex', 'rightFootIndex') },
  { name: 'ankle_spread', fn: bilateralSpread('leftAnkle', 'rightAnkle') },
  { name: 'heel_spread', fn: bilateralSpread('leftHeel', 'rightHeel') },
  { name: 'knee_spread', fn: bilateralSpread('leftKnee', 'rightKnee') },
  { name: 'hip_spread', fn: bilateralSpread('leftHip', 'rightHip') },
  { name: 'shoulder_spread', fn: bilateralSpread('leftShoulder', 'rightShoulder') },
  { name: 'ear_spread', fn: bilateralSpread('leftEar', 'rightEar') },
  { name: 'eye_spread', fn: bilateralSpread('leftEye', 'rightEye') },
  { name: 'wrist_spread', fn: bilateralSpread('leftWrist', 'rightWrist') },
  { name: 'elbow_spread', fn: bilateralSpread('leftElbow', 'rightElbow') },
  // Normalized by body height
  { name: 'footIndex_norm', fn: normalizedFootSpread },
  { name: 'hip_norm', fn: normalizedHipSpread },
  // X/Y axis ratio (symmetry signals)
  { name: 'hip_xOverY', fn: hipXvsYRatio },
  { name: 'shoulder_xOverY', fn: shoulderXvsYRatio },
  { name: 'foot_xOverY', fn: footXvsYRatio },
  { name: 'ankle_xOverY', fn: ankleXvsYRatio },
  // Cross-body
  { name: 'lShoulder_rHip_x', fn: leftShoulderToRightHipX },
  { name: 'rShoulder_lHip_x', fn: rightShoulderToLeftHipX },
  // Body height itself (should be camera-distance-dependent → low ratio expected)
  { name: 'bodyHeight', fn: bodyHeight },
];

const AMP_SIGNALS = [
  // Temporal amplitude (max-min across full swing)
  { name: 'AMP_footIndex_spread', fn: bilateralSpread('leftFootIndex', 'rightFootIndex') },
  { name: 'AMP_ankle_spread', fn: bilateralSpread('leftAnkle', 'rightAnkle') },
  { name: 'AMP_hip_spread', fn: bilateralSpread('leftHip', 'rightHip') },
  { name: 'AMP_hip_xOverY', fn: hipXvsYRatio },
  { name: 'AMP_foot_xOverY', fn: footXvsYRatio },
];

// ─── main ────────────────────────────────────────────────────────────────────

const { data, error } = await supabase
  .from('swings')
  .select('id, motion_frames')
  .in('id', [...DTL, ...FACEON]);

if (error) {
  console.error('Supabase error:', error);
  process.exit(1);
}

const results = [];

// Average signals
for (const sig of AVG_SIGNALS) {
  const dtlVals = DTL.map(id => {
    const row = data.find(r => r.id === id);
    return row ? avgOverFrames(row.motion_frames, sig.fn) : null;
  }).filter(v => v !== null);

  const faceonVals = FACEON.map(id => {
    const row = data.find(r => r.id === id);
    return row ? avgOverFrames(row.motion_frames, sig.fn) : null;
  }).filter(v => v !== null);

  if (!dtlVals.length || !faceonVals.length) continue;

  const dtlMean = dtlVals.reduce((a, b) => a + b, 0) / dtlVals.length;
  const faceonMean = faceonVals.reduce((a, b) => a + b, 0) / faceonVals.length;
  const ratio = faceonMean !== 0 ? dtlMean / faceonMean : null;
  const gap = dtlMean - faceonMean;

  results.push({ signal: sig.name, dtl: dtlMean, faceOn: faceonMean, ratio, gap });
}

// Amplitude signals
for (const sig of AMP_SIGNALS) {
  const dtlVals = DTL.map(id => {
    const row = data.find(r => r.id === id);
    return row ? amplitudeOverFrames(row.motion_frames, sig.fn) : null;
  }).filter(v => v !== null);

  const faceonVals = FACEON.map(id => {
    const row = data.find(r => r.id === id);
    return row ? amplitudeOverFrames(row.motion_frames, sig.fn) : null;
  }).filter(v => v !== null);

  if (!dtlVals.length || !faceonVals.length) continue;

  const dtlMean = dtlVals.reduce((a, b) => a + b, 0) / dtlVals.length;
  const faceonMean = faceonVals.reduce((a, b) => a + b, 0) / faceonVals.length;
  const ratio = faceonMean !== 0 ? dtlMean / faceonMean : null;
  const gap = dtlMean - faceonMean;

  results.push({ signal: sig.name, dtl: dtlMean, faceOn: faceonMean, ratio, gap });
}

// Sort by absolute ratio distance from 1.0 (best separation)
results.sort((a, b) => Math.abs((b.ratio ?? 1) - 1) - Math.abs((a.ratio ?? 1) - 1));

console.log('\n=== SIGNAL SEPARATION RANKING (best → worst) ===\n');
console.table(results.map(r => ({
  signal: r.signal,
  dtl: r.dtl.toFixed(4),
  faceOn: r.faceOn.toFixed(4),
  ratio: r.ratio ? r.ratio.toFixed(2) + 'x' : 'N/A',
  gap: r.gap.toFixed(4),
  direction: r.ratio > 1 ? 'DTL>FO' : 'FO>DTL',
})));

console.log('\n=== TOP 5 CLASSIFIERS ===\n');
const top5 = results.slice(0, 5);
top5.forEach((r, i) => {
  const midpoint = ((r.dtl + r.faceOn) / 2).toFixed(4);
  console.log(`${i + 1}. ${r.signal}`);
  console.log(`   DTL: ${r.dtl.toFixed(4)} | FaceOn: ${r.faceOn.toFixed(4)} | Ratio: ${r.ratio?.toFixed(2)}x`);
  console.log(`   Suggested threshold midpoint: ${midpoint}`);
  console.log('');
});
