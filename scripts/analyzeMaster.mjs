#!/usr/bin/env node
// Read-only master biomechanical analysis for one swing.
// Usage: node scripts/analyzeMaster.mjs <swing_id>
// Reads Supabase creds from .env (EXPO_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY or EXPO_PUBLIC_SUPABASE_ANON_KEY).
// Computes 11 biomechanical metrics (raw values, no scoring). No DB writes.
// Output: stdout summary + ~/Desktop/analysis_<swing_id>.json.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const die = (msg, code = 1) => {
  console.error(`error: ${msg}`);
  process.exit(code);
};

// ---------- 1) CLI arg ----------
const cliArgs = process.argv.slice(2);
const DEBUG = cliArgs.includes('--debug');
const swingId = cliArgs.find((a) => a && !a.startsWith('--'));
if (!swingId) {
  die('swing_id is required.\n  usage: node scripts/analyzeMaster.mjs [--debug] <swing_id>');
}

// ---------- 2) Load .env ----------
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
if (!existsSync(envPath)) die(`.env not found at ${envPath}`);
const env = {};
for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  const key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  env[key] = val;
}

const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  die('EXPO_PUBLIC_SUPABASE_URL missing, or no key found (need SUPABASE_SERVICE_ROLE_KEY or EXPO_PUBLIC_SUPABASE_ANON_KEY) in .env.');
}

// ---------- 3) Fetch swing ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await supabase
  .from('swings')
  .select('id, motion_frames, phases, created_at, swing_debug')
  .eq('id', swingId)
  .maybeSingle();

if (error) die(`supabase query failed: ${error.message}`);
if (!data) die(`swing ${swingId} not found.`);
const frames = data.motion_frames;
if (!frames || !Array.isArray(frames) || frames.length === 0) {
  die(`motion_frames is null or empty for swing ${swingId}.`);
}
const phasesRaw = Array.isArray(data.phases) ? data.phases : [];
const capturedAt = data.created_at ?? null;
const swingDebug = (data.swing_debug && typeof data.swing_debug === 'object') ? data.swing_debug : {};
const isLeftHanded = swingDebug.handedness === 'left';

// ---------- 4) Math helpers ----------
const CONF_MIN = 0.5;
const conf = (j) => (j?.confidence ?? 0);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function angleAtB(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 === 0 || m2 === 0) return null;
  let cos = (v1x * v2x + v1y * v2y) / (m1 * m2);
  if (cos > 1) cos = 1; else if (cos < -1) cos = -1;
  return (Math.acos(cos) * 180) / Math.PI;
}

function spineAngleFor(frame) {
  const j = frame?.joints ?? {};
  const need = ['leftHip', 'rightHip', 'leftShoulder', 'rightShoulder'];
  for (const n of need) if (!j[n] || conf(j[n]) < CONF_MIN) return null;
  const hipMid = mid(j.leftHip, j.rightHip);
  const shoulderMid = mid(j.leftShoulder, j.rightShoulder);
  return (Math.atan2(Math.abs(shoulderMid.x - hipMid.x), Math.abs(hipMid.y - shoulderMid.y)) * 180) / Math.PI;
}

function hasJoints(frame, names, minConf = CONF_MIN) {
  const j = frame?.joints;
  if (!j) return false;
  for (const n of names) {
    if (!j[n]) return false;
    if (conf(j[n]) < minConf) return false;
  }
  return true;
}

function classifyReliability(skipped, total) {
  if (total === 0) return 'LOW';
  if (skipped === 0) return 'HIGH';
  if (skipped / total < 0.2) return 'MED';
  return 'LOW';
}

// ---------- 5) Phase index resolver ----------
function buildPhaseIndex(phasesArr, frameCount) {
  const out = {
    address: null, takeaway: null, top: null,
    downswing: null, impact: null, followThrough: null,
  };
  const map = {
    address: 'address', takeaway: 'takeaway', top: 'top',
    downswing: 'downswing', impact: 'impact', follow_through: 'followThrough',
  };
  for (const entry of phasesArr) {
    if (!entry || typeof entry.phase !== 'string') continue;
    const key = map[entry.phase];
    if (!key) continue;
    const idx = entry.index;
    if (typeof idx !== 'number' || idx < 0 || idx >= frameCount) continue;
    out[key] = idx;
  }
  return out;
}

function fallbackAddressIdx(frames, requiredJoints) {
  for (let i = 0; i < frames.length; i++) {
    if (hasJoints(frames[i], requiredJoints)) return i;
  }
  return null;
}

// ---------- 6) Velocity precompute ----------
function buildAugmentedFrame(frame) {
  // Returns a virtual joints map that adds hipMid + shoulderMid if both sides usable.
  const j = frame?.joints ?? {};
  const aug = {};
  for (const k of Object.keys(j)) aug[k] = j[k];
  if (j.leftHip && j.rightHip && conf(j.leftHip) >= CONF_MIN && conf(j.rightHip) >= CONF_MIN) {
    const m = mid(j.leftHip, j.rightHip);
    aug.hipMid = { x: m.x, y: m.y, confidence: Math.min(conf(j.leftHip), conf(j.rightHip)) };
  }
  if (j.leftShoulder && j.rightShoulder && conf(j.leftShoulder) >= CONF_MIN && conf(j.rightShoulder) >= CONF_MIN) {
    const m = mid(j.leftShoulder, j.rightShoulder);
    aug.shoulderMid = { x: m.x, y: m.y, confidence: Math.min(conf(j.leftShoulder), conf(j.rightShoulder)) };
  }
  return aug;
}

function computeVelocities(frames, jointNames) {
  const aug = frames.map(buildAugmentedFrame);
  const out = new Map();
  for (const name of jointNames) {
    const arr = new Array(frames.length).fill(null);
    for (let i = 1; i < frames.length - 1; i++) {
      const jPrev = aug[i - 1]?.[name];
      const jNext = aug[i + 1]?.[name];
      const jCur = aug[i]?.[name];
      if (!jPrev || !jNext || !jCur) continue;
      if (conf(jPrev) < CONF_MIN || conf(jNext) < CONF_MIN || conf(jCur) < CONF_MIN) continue;
      const dt = (frames[i + 1]?.timestampMs - frames[i - 1]?.timestampMs);
      if (!Number.isFinite(dt) || dt <= 0) continue;
      const vx = (jNext.x - jPrev.x) / dt;
      const vy = (jNext.y - jPrev.y) / dt;
      arr[i] = { vx, vy, speed: Math.hypot(vx, vy) };
    }
    out.set(name, arr);
  }
  return out;
}

// ---------- 7) Metric functions ----------

function computeSpineAngle(frames, addressIdx) {
  const total = frames.length;
  let skipped = 0;
  const curve = frames.map((f, i) => {
    const a = spineAngleFor(f);
    if (a == null) { skipped++; return { frameIndex: i, angle: null }; }
    return { frameIndex: i, angle: a };
  });
  const addressAngle = addressIdx != null ? curve[addressIdx]?.angle ?? null : null;
  let minAngle = null, minFrame = null;
  for (const c of curve) {
    if (c.angle == null) continue;
    if (minAngle == null || c.angle < minAngle) { minAngle = c.angle; minFrame = c.frameIndex; }
  }
  let maxDrift = 0;
  if (addressAngle != null) {
    for (const c of curve) {
      if (c.angle == null) continue;
      const drift = addressAngle - c.angle;
      if (drift > maxDrift) { maxDrift = drift; }
    }
  }
  let driftOnsetFrame = null;
  if (addressAngle != null && addressIdx != null) {
    for (const c of curve) {
      if (c.frameIndex <= addressIdx) continue;
      if (c.angle == null) continue;
      if ((addressAngle - c.angle) > 2.0) {
        driftOnsetFrame = c.frameIndex;
        break;
      }
    }
  }
  const stabilityWindow = addressAngle == null ? 0
    : curve.filter((c) => c.angle != null && Math.abs(c.angle - addressAngle) <= 5).length;
  const fault = addressAngle != null ? maxDrift > 8 : false;
  return {
    curve,
    features: addressAngle == null
      ? { addressAngle: null, minAngle, minFrame, maxDrift: null, driftOnsetFrame: null, stabilityWindow: 0 }
      : { addressAngle, minAngle, minFrame, maxDrift, driftOnsetFrame, stabilityWindow },
    reliability: classifyReliability(skipped, total),
    fault,
  };
}

function computeHeadDrift(frames, addressIdx) {
  const total = frames.length;
  let skipped = 0;
  const need = ['nose'];
  const addressNose = addressIdx != null && hasJoints(frames[addressIdx], need)
    ? frames[addressIdx].joints.nose : null;
  const curve = frames.map((f, i) => {
    if (!hasJoints(f, need) || !addressNose) { skipped++; return { frameIndex: i, delta: null }; }
    return { frameIndex: i, delta: f.joints.nose.x - addressNose.x };
  });
  let maxDrift = null, maxDriftFrame = null;
  for (const c of curve) {
    if (c.delta == null) continue;
    if (maxDrift == null || Math.abs(c.delta) > Math.abs(maxDrift)) {
      maxDrift = c.delta; maxDriftFrame = c.frameIndex;
    }
  }
  const fault = maxDrift != null ? Math.abs(maxDrift) > 0.03 : false;
  return {
    curve,
    features: { maxDrift, maxDriftFrame },
    reliability: classifyReliability(skipped, total),
    fault,
  };
}

function computeWeightTransfer(frames, addressIdx, impactIdx) {
  const total = frames.length;
  let skipped = 0;
  const need = ['leftHip', 'rightHip'];
  const addressHipMidX = addressIdx != null && hasJoints(frames[addressIdx], need)
    ? mid(frames[addressIdx].joints.leftHip, frames[addressIdx].joints.rightHip).x : null;
  const curve = frames.map((f, i) => {
    if (!hasJoints(f, need) || addressHipMidX == null) { skipped++; return { frameIndex: i, delta: null }; }
    const hm = mid(f.joints.leftHip, f.joints.rightHip);
    return { frameIndex: i, delta: hm.x - addressHipMidX };
  });
  let directionAtImpact = null, magnitudeAtImpact = null, fault = false;
  if (impactIdx != null && curve[impactIdx]?.delta != null) {
    const d = curve[impactIdx].delta;
    magnitudeAtImpact = Math.abs(d);
    directionAtImpact = d > 0 ? 'positive' : (d < 0 ? 'negative' : 'zero');
    if (addressHipMidX != null) {
      const impactHipMidX = addressHipMidX + d;
      fault = impactHipMidX > addressHipMidX;
    }
  }
  return {
    curve,
    features: { directionAtImpact, magnitudeAtImpact },
    reliability: classifyReliability(skipped, total),
    fault,
  };
}

function computeFinishBalance(frames, followThroughIdx) {
  if (followThroughIdx == null) {
    return { features: { shoulderHipOffset: null, hipAnkleOffset: null }, reliability: 'LOW', fault: false };
  }
  const f = frames[followThroughIdx];
  const need = ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip', 'leftAnkle', 'rightAnkle'];
  if (!hasJoints(f, need)) {
    return { features: { shoulderHipOffset: null, hipAnkleOffset: null }, reliability: 'LOW', fault: false };
  }
  const shoulderMid = mid(f.joints.leftShoulder, f.joints.rightShoulder);
  const hipMid = mid(f.joints.leftHip, f.joints.rightHip);
  const ankleMid = mid(f.joints.leftAnkle, f.joints.rightAnkle);
  const shoulderHipOffset = Math.abs(shoulderMid.x - hipMid.x);
  const hipAnkleOffset = Math.abs(hipMid.x - ankleMid.x);
  return {
    features: { shoulderHipOffset, hipAnkleOffset },
    reliability: 'HIGH',
    fault: shoulderHipOffset > 0.05 || hipAnkleOffset > 0.05,
  };
}

function computeFootPosition(frames, addressIdx) {
  if (addressIdx == null) {
    return { features: { stanceWidth: null, leftFootFlare: null, rightFootFlare: null }, reliability: 'LOW' };
  }
  const f = frames[addressIdx];
  const need = ['leftAnkle', 'rightAnkle', 'leftHeel', 'rightHeel'];
  if (!hasJoints(f, need)) {
    return { features: { stanceWidth: null, leftFootFlare: null, rightFootFlare: null }, reliability: 'LOW' };
  }
  const stanceWidth = dist2d(f.joints.leftAnkle, f.joints.rightAnkle);
  // Flare = angle of heel→ankle vector from vertical (degrees).
  const flareFrom = (heel, ankle) => {
    const dx = ankle.x - heel.x;
    const dy = ankle.y - heel.y;
    if (dx === 0 && dy === 0) return null;
    return (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI;
  };
  return {
    features: {
      stanceWidth,
      leftFootFlare: flareFrom(f.joints.leftHeel, f.joints.leftAnkle),
      rightFootFlare: flareFrom(f.joints.rightHeel, f.joints.rightAnkle),
    },
    reliability: 'HIGH',
  };
}

function computeKneeFlex(frames, addressIdx, side) {
  const hipName = side === 'left' ? 'leftHip' : 'rightHip';
  const kneeName = side === 'left' ? 'leftKnee' : 'rightKnee';
  const ankleName = side === 'left' ? 'leftAnkle' : 'rightAnkle';
  const need = [hipName, kneeName, ankleName];
  const total = frames.length;
  let skipped = 0;
  const curve = frames.map((f, i) => {
    if (!hasJoints(f, need)) { skipped++; return { frameIndex: i, angle: null }; }
    const a = angleAtB(f.joints[hipName], f.joints[kneeName], f.joints[ankleName]);
    if (a == null) { skipped++; return { frameIndex: i, angle: null }; }
    return { frameIndex: i, angle: a };
  });
  const addressAngle = addressIdx != null ? curve[addressIdx]?.angle ?? null : null;
  let minAngle = null, minFrame = null;
  for (const c of curve) {
    if (c.angle == null) continue;
    if (minAngle == null || c.angle < minAngle) { minAngle = c.angle; minFrame = c.frameIndex; }
  }
  const maxFlex = (addressAngle != null && minAngle != null) ? (addressAngle - minAngle) : null;
  return {
    curve,
    features: { addressAngle, minAngle, minFrame, maxFlex, note: 'DTL view — lateral movement not visible' },
    reliability: classifyReliability(skipped, total),
  };
}

function computeHipShoulderSep(frames, topIdx, impactIdx) {
  const total = frames.length;
  let skipped = 0;
  const need = ['leftHip', 'rightHip', 'leftShoulder', 'rightShoulder'];
  const curve = frames.map((f, i) => {
    if (!hasJoints(f, need)) { skipped++; return { frameIndex: i, separation: null }; }
    const hipAngle = (Math.atan2(f.joints.rightHip.x - f.joints.leftHip.x, f.joints.rightHip.y - f.joints.leftHip.y) * 180) / Math.PI;
    const shoulderAngle = (Math.atan2(f.joints.rightShoulder.x - f.joints.leftShoulder.x, f.joints.rightShoulder.y - f.joints.leftShoulder.y) * 180) / Math.PI;
    return { frameIndex: i, separation: shoulderAngle - hipAngle };
  });
  let maxSeparation = null, maxSeparationFrame = null;
  for (const c of curve) {
    if (c.separation == null) continue;
    if (maxSeparation == null || Math.abs(c.separation) > Math.abs(maxSeparation)) {
      maxSeparation = c.separation; maxSeparationFrame = c.frameIndex;
    }
  }
  const separationAtTop = topIdx != null ? curve[topIdx]?.separation ?? null : null;
  const separationAtImpact = impactIdx != null ? curve[impactIdx]?.separation ?? null : null;
  return {
    curve,
    features: { maxSeparation, maxSeparationFrame, separationAtTop, separationAtImpact },
    reliability: classifyReliability(skipped, total),
    fault: false,
  };
}

function computeTempo(phasesArr) {
  const byPhase = {};
  for (const e of phasesArr) {
    if (e && typeof e.phase === 'string' && typeof e.timestamp === 'number') {
      byPhase[e.phase] = e.timestamp;
    }
  }
  const addressTs = byPhase.address;
  const topTs = byPhase.top;
  const impactTs = byPhase.impact;
  const backswingMs = (addressTs != null && topTs != null) ? (topTs - addressTs) : null;
  const downswingMs = (topTs != null && impactTs != null) ? (impactTs - topTs) : null;
  const tempoRatio = (backswingMs != null && downswingMs != null && downswingMs > 0)
    ? backswingMs / downswingMs : null;
  const reliability = (backswingMs != null && downswingMs != null) ? 'HIGH'
    : (backswingMs != null || downswingMs != null) ? 'MED' : 'LOW';
  const fault = tempoRatio != null ? (tempoRatio < 2.5 || tempoRatio > 5.0) : false;
  return {
    features: { backswingMs, downswingMs, tempoRatio },
    reliability,
    fault,
  };
}

function computeVelocityFeatures(velocityMap, impactIdx) {
  const joints = {};
  let totalSamples = 0, skipped = 0;
  for (const [name, arr] of velocityMap.entries()) {
    if (name === 'hipMid' || name === 'shoulderMid') continue;
    let peakSpeed = null, peakSpeedFrame = null;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      totalSamples++;
      if (!v) { skipped++; continue; }
      if (peakSpeed == null || v.speed > peakSpeed) { peakSpeed = v.speed; peakSpeedFrame = i; }
    }
    const speedAtImpact = (impactIdx != null && arr[impactIdx]) ? arr[impactIdx].speed : null;
    joints[name] = { peakSpeed, peakSpeedFrame, speedAtImpact };
  }
  return { joints, reliability: classifyReliability(skipped, totalSamples) };
}

function peakFrameInRange(arr, lo, hi) {
  let peak = null, peakIdx = null;
  for (let i = lo; i <= hi; i++) {
    const v = arr[i];
    if (!v) continue;
    if (peak == null || v.speed > peak) { peak = v.speed; peakIdx = i; }
  }
  return peakIdx;
}

function computeKinematicSequence(velocityMap, topIdx, impactIdx) {
  if (topIdx == null || impactIdx == null || impactIdx <= topIdx) {
    return {
      features: { hipPeakFrame: null, shoulderPeakFrame: null, wristPeakFrame: null, correctSequence: null },
      reliability: 'LOW', fault: false,
    };
  }
  const hipArr = velocityMap.get('hipMid') ?? [];
  const shoulderArr = velocityMap.get('shoulderMid') ?? [];
  const wristArr = velocityMap.get('leftWrist') ?? [];
  // Hip and shoulder peak in follow-through; wrist peaks at/near impact.
  const lastFrame = frames.length - 1;
  const hipPeakFrame = peakFrameInRange(
    hipArr, topIdx, Math.min(lastFrame, impactIdx + 10)
  );
  const shoulderPeakFrame = peakFrameInRange(
    shoulderArr, topIdx, Math.min(lastFrame, impactIdx + 10)
  );
  const wristPeakFrame = peakFrameInRange(
    wristArr, topIdx, Math.min(lastFrame, impactIdx + 3)
  );
  const haveAll = hipPeakFrame != null && shoulderPeakFrame != null && wristPeakFrame != null;
  const correctSequence = haveAll
    ? hipPeakFrame < shoulderPeakFrame && shoulderPeakFrame < wristPeakFrame
    : null;
  const reliability = haveAll ? 'HIGH' : 'LOW';
  const fault = correctSequence === false;
  return {
    features: { hipPeakFrame, shoulderPeakFrame, wristPeakFrame, correctSequence },
    reliability, fault,
  };
}

function computeCasting(velocityMap, topIdx, impactIdx) {
  if (topIdx == null || impactIdx == null || impactIdx <= topIdx) {
    return { features: { wristPeakFrame: null, impactFrame: impactIdx }, reliability: 'LOW', fault: false };
  }
  const wristArr = velocityMap.get('leftWrist') ?? [];
  const wristPeakFrame = peakFrameInRange(wristArr, topIdx, impactIdx);
  const fault = wristPeakFrame != null ? wristPeakFrame < (impactIdx - 3) : false;
  return {
    features: { wristPeakFrame, impactFrame: impactIdx },
    reliability: wristPeakFrame != null ? 'HIGH' : 'LOW',
    fault,
  };
}

function trailKneeAngleFor(frame, isLeft) {
  const hipName = isLeft ? 'leftHip' : 'rightHip';
  const kneeName = isLeft ? 'leftKnee' : 'rightKnee';
  const ankleName = isLeft ? 'leftAnkle' : 'rightAnkle';
  if (!hasJoints(frame, [hipName, kneeName, ankleName])) return null;
  return angleAtB(frame.joints[hipName], frame.joints[kneeName], frame.joints[ankleName]);
}

function noseXFor(frame) {
  if (!hasJoints(frame, ['nose'])) return null;
  return frame.joints.nose.x;
}

function allSameSign(values) {
  let sign = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v) || v === 0) return false;
    const s = v > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return sign !== 0;
}

function computeSwingStartDetection(frames, topIdx, addressIdxFromPhases, isLeft) {
  const nullResult = {
    trueAddressFrame: null,
    trueAddressSpine: null,
    trueSwingStartFrame: null,
    framesOff: null,
    reliability: 'LOW',
    correctedAddressAngle: null,
    correctedMaxDrift: null,
    correctedDriftOnsetFrame: null,
    correctedFault: false,
    signals: { spineSignalFrame: null, headSignalFrame: null, kneeSignalFrame: null },
  };
  if (topIdx == null) return nullResult;

  // Step 1: scan backward from topIdx-1 for the latest stable 8-frame window.
  let trueAddressFrame = null;
  let trueAddressSpine = null;
  let reliability = 'HIGH';

  for (let E = Math.max(7, topIdx - 20); E >= 7; E--) {
    const lo = E - 7;
    let abort = false;

    const spineValues = new Array(8);
    for (let k = 0; k < 8; k++) {
      const v = spineAngleFor(frames[lo + k]);
      if (v == null) { abort = true; break; }
      spineValues[k] = v;
    }
    if (abort) continue;

    const noseStartX = noseXFor(frames[lo]);
    if (noseStartX == null) continue;
    const headValues = new Array(8);
    for (let k = 0; k < 8; k++) {
      const nx = noseXFor(frames[lo + k]);
      if (nx == null) { abort = true; break; }
      headValues[k] = nx - noseStartX;
    }
    if (abort) continue;

    const kneeValues = new Array(8);
    for (let k = 0; k < 8; k++) {
      const a = trailKneeAngleFor(frames[lo + k], isLeft);
      if (a == null) { abort = true; break; }
      kneeValues[k] = a;
    }
    if (abort) continue;

    let sMin = spineValues[0], sMax = spineValues[0];
    let kMin = kneeValues[0], kMax = kneeValues[0];
    let headStable = true;
    for (let k = 0; k < 8; k++) {
      if (spineValues[k] < sMin) sMin = spineValues[k];
      if (spineValues[k] > sMax) sMax = spineValues[k];
      if (kneeValues[k] < kMin) kMin = kneeValues[k];
      if (kneeValues[k] > kMax) kMax = kneeValues[k];
      if (Math.abs(headValues[k]) >= 0.006) headStable = false;
    }
    const spineRange = sMax - sMin;
    const kneeRange = kMax - kMin;

    if (spineRange < 1.5 && headStable && kneeRange < 2.0) {
      trueAddressFrame = E;
      trueAddressSpine = spineValues[7];
      break;
    }
  }

  if (trueAddressFrame == null) {
    reliability = 'LOW';
    if (addressIdxFromPhases != null && addressIdxFromPhases >= 0 && addressIdxFromPhases < frames.length) {
      trueAddressFrame = addressIdxFromPhases;
      trueAddressSpine = spineAngleFor(frames[addressIdxFromPhases]);
    }
  }

  // Step 2: scan forward for 2-of-3 consensus.
  let trueSwingStartFrame = null;
  let spineSignalFrame = null;
  let headSignalFrame = null;
  let kneeSignalFrame = null;

  if (trueAddressFrame != null && trueAddressSpine != null) {
    const noseAtAddress = noseXFor(frames[trueAddressFrame]);
    const kneeAtAddress = trailKneeAngleFor(frames[trueAddressFrame], isLeft);

    const startF = trueAddressFrame + 1;
    const endF = topIdx - 2; // need F+2 <= topIdx

    for (let F = startF; F <= endF; F++) {
      // Spine signal
      const sF = spineAngleFor(frames[F]);
      const sF1 = spineAngleFor(frames[F + 1]);
      const sF2 = spineAngleFor(frames[F + 2]);
      let spineSignal = false;
      if (sF != null && sF1 != null && sF2 != null) {
        const dF = sF - trueAddressSpine;
        const dF1 = sF1 - trueAddressSpine;
        const dF2 = sF2 - trueAddressSpine;
        if (allSameSign([dF, dF1, dF2]) && Math.abs(dF) > 1.0) spineSignal = true;
      }

      // Head signal
      let headSignal = false;
      if (noseAtAddress != null) {
        const nF = noseXFor(frames[F]);
        const nF1 = noseXFor(frames[F + 1]);
        const nF2 = noseXFor(frames[F + 2]);
        if (nF != null && nF1 != null && nF2 != null) {
          const dH = nF - noseAtAddress;
          const dH1 = nF1 - noseAtAddress;
          const dH2 = nF2 - noseAtAddress;
          if (allSameSign([dH, dH1, dH2])) headSignal = true;
        }
      }

      // Knee signal
      let kneeSignal = false;
      if (kneeAtAddress != null) {
        const kF = trailKneeAngleFor(frames[F], isLeft);
        const kF1 = trailKneeAngleFor(frames[F + 1], isLeft);
        const kF2 = trailKneeAngleFor(frames[F + 2], isLeft);
        if (kF != null && kF1 != null && kF2 != null) {
          const dK = kF - kneeAtAddress;
          const dK1 = kF1 - kneeAtAddress;
          const dK2 = kF2 - kneeAtAddress;
          if (allSameSign([dK, dK1, dK2]) && Math.abs(dK) > 1.5) kneeSignal = true;
        }
      }

      if (spineSignal && spineSignalFrame == null) spineSignalFrame = F;
      if (headSignal && headSignalFrame == null) headSignalFrame = F;
      if (kneeSignal && kneeSignalFrame == null) kneeSignalFrame = F;

      const votes = (spineSignal ? 1 : 0) + (headSignal ? 1 : 0) + (kneeSignal ? 1 : 0);
      if (votes >= 2) {
        trueSwingStartFrame = F;
        break;
      }
    }

    if (trueSwingStartFrame == null) {
      trueSwingStartFrame = trueAddressFrame + 1;
    }
  }

  // Step 3: corrected metrics.
  const correctedAddressAngle = trueAddressSpine;
  const correctedDriftOnsetFrame = trueSwingStartFrame;
  let correctedMaxDrift = null;
  if (
    correctedAddressAngle != null &&
    trueSwingStartFrame != null &&
    topIdx != null &&
    trueSwingStartFrame <= topIdx
  ) {
    let m = null;
    for (let F = trueSwingStartFrame; F <= topIdx; F++) {
      const sv = spineAngleFor(frames[F]);
      if (sv == null) continue;
      const d = Math.abs(sv - correctedAddressAngle);
      if (m == null || d > m) m = d;
    }
    correctedMaxDrift = m;
  }
  const correctedFault = correctedMaxDrift != null && correctedMaxDrift > 8.0;

  const framesOff = (addressIdxFromPhases != null && trueAddressFrame != null)
    ? addressIdxFromPhases - trueAddressFrame
    : null;

  return {
    trueAddressFrame,
    trueAddressSpine,
    trueSwingStartFrame,
    framesOff,
    reliability,
    correctedAddressAngle,
    correctedMaxDrift,
    correctedDriftOnsetFrame,
    correctedFault,
    signals: { spineSignalFrame, headSignalFrame, kneeSignalFrame },
  };
}

// ---------- 8) Main ----------
const phaseIndex = buildPhaseIndex(phasesRaw, frames.length);

let addressIdx = phaseIndex.address;
if (addressIdx == null) {
  addressIdx = fallbackAddressIdx(frames, ['leftHip', 'rightHip', 'leftShoulder', 'rightShoulder']);
}

const VELOCITY_JOINTS = [
  'leftWrist', 'rightWrist', 'leftHip', 'rightHip',
  'leftShoulder', 'rightShoulder', 'hipMid', 'shoulderMid',
];
const velocityMap = computeVelocities(frames, VELOCITY_JOINTS);

const metrics = {
  spineAngle: computeSpineAngle(frames, addressIdx),
  headDrift: computeHeadDrift(frames, addressIdx),
  weightTransfer: computeWeightTransfer(frames, addressIdx, phaseIndex.impact),
  finishBalance: computeFinishBalance(frames, phaseIndex.followThrough),
  footPosition: computeFootPosition(frames, addressIdx),
  kneeFlexLeft: computeKneeFlex(frames, addressIdx, 'left'),
  kneeFlexRight: computeKneeFlex(frames, addressIdx, 'right'),
  hipShoulderSep: computeHipShoulderSep(frames, phaseIndex.top, phaseIndex.impact),
  tempo: computeTempo(phasesRaw),
  velocity: computeVelocityFeatures(velocityMap, phaseIndex.impact),
  kinematicSequence: computeKinematicSequence(velocityMap, phaseIndex.top, phaseIndex.impact),
  casting: computeCasting(velocityMap, phaseIndex.top, phaseIndex.impact),
  swingStartDetection: computeSwingStartDetection(frames, phaseIndex.top, phaseIndex.address, isLeftHanded),
};

const ssd = metrics.swingStartDetection;
let corrected;
if (ssd.reliability === 'HIGH' && ssd.trueAddressFrame != null) {
  const tAddr = ssd.trueAddressFrame;
  const spineRecomputed   = computeSpineAngle(frames, tAddr);
  const headRecomputed    = computeHeadDrift(frames, tAddr);
  const weightRecomputed  = computeWeightTransfer(frames, tAddr, phaseIndex.impact);
  const footRecomputed    = computeFootPosition(frames, tAddr);
  const kneeLRecomputed   = computeKneeFlex(frames, tAddr, 'left');
  const kneeRRecomputed   = computeKneeFlex(frames, tAddr, 'right');
  corrected = {
    reliability: 'HIGH',
    addressFrame: tAddr,
    spineAngle: {
      addressAngle:    spineRecomputed.features.addressAngle,
      maxDrift:        spineRecomputed.features.maxDrift,
      driftOnsetFrame: spineRecomputed.features.driftOnsetFrame,
      fault:           spineRecomputed.fault,
    },
    headDrift: {
      maxDrift:      headRecomputed.features.maxDrift,
      faultDetected: headRecomputed.fault,
    },
    weightTransfer: {
      magnitudeAtImpact: weightRecomputed.features.magnitudeAtImpact,
      fault:             weightRecomputed.fault,
    },
    footPosition: {
      stanceWidth:    footRecomputed.features.stanceWidth,
      leftFootFlare:  footRecomputed.features.leftFootFlare,
      rightFootFlare: footRecomputed.features.rightFootFlare,
    },
    kneeFlexLeft:  { addressAngle: kneeLRecomputed.features.addressAngle },
    kneeFlexRight: { addressAngle: kneeRRecomputed.features.addressAngle },
  };
} else {
  corrected = { reliability: null };
}

let debug;
if (DEBUG) {
  const topIdx = phaseIndex.top;
  const impactIdx = phaseIndex.impact;
  if (topIdx == null || impactIdx == null) {
    debug = { velocityCurves: null };
  } else {
    const lo = topIdx;
    const hi = Math.min(frames.length - 1, impactIdx + 5);
    const debugCurveFor = (name) => {
      const arr = velocityMap.get(name) ?? [];
      const out = [];
      for (let i = lo; i <= hi; i++) {
        const v = arr[i];
        out.push({ frameIndex: i, speed: v ? v.speed : null });
      }
      return out;
    };
    debug = {
      velocityCurves: {
        hipMid: debugCurveFor('hipMid'),
        shoulderMid: debugCurveFor('shoulderMid'),
        leftWrist: debugCurveFor('leftWrist'),
      },
    };
  }
}

const output = {
  swingId,
  capturedAt,
  frameCount: frames.length,
  phases: phaseIndex,
  metrics,
  corrected,
  motionFrames: frames,
  ...(DEBUG ? { debug } : {}),
};

// ---------- 9) Console summary ----------
const fmtNum = (v, digits = 4) => (v == null ? null : Number(v.toFixed(digits)));

console.log(`\nMaster swing analysis for ${swingId}`);
console.log(`Captured at : ${capturedAt ?? 'n/a'}`);
console.log(`Frame count : ${frames.length}`);
console.log(`Phases idx  : ${JSON.stringify(phaseIndex)}`);
console.log('');

const summaryRows = [
  { metric: 'spineAngle', reliability: metrics.spineAngle.reliability, key: 'maxDrift', value: fmtNum(metrics.spineAngle.features.maxDrift, 2), fault: metrics.spineAngle.fault },
  { metric: 'headDrift', reliability: metrics.headDrift.reliability, key: 'maxDrift', value: fmtNum(metrics.headDrift.features.maxDrift, 4), fault: metrics.headDrift.fault },
  { metric: 'weightTransfer', reliability: metrics.weightTransfer.reliability, key: 'magnitudeAtImpact', value: fmtNum(metrics.weightTransfer.features.magnitudeAtImpact, 4), fault: metrics.weightTransfer.fault },
  { metric: 'finishBalance', reliability: metrics.finishBalance.reliability, key: 'shoulderHipOffset', value: fmtNum(metrics.finishBalance.features.shoulderHipOffset, 4), fault: metrics.finishBalance.fault },
  { metric: 'footPosition', reliability: metrics.footPosition.reliability, key: 'stanceWidth', value: fmtNum(metrics.footPosition.features.stanceWidth, 4), fault: '' },
  { metric: 'kneeFlexLeft', reliability: metrics.kneeFlexLeft.reliability, key: 'maxFlex', value: fmtNum(metrics.kneeFlexLeft.features.maxFlex, 2), fault: '' },
  { metric: 'kneeFlexRight', reliability: metrics.kneeFlexRight.reliability, key: 'maxFlex', value: fmtNum(metrics.kneeFlexRight.features.maxFlex, 2), fault: '' },
  { metric: 'hipShoulderSep', reliability: metrics.hipShoulderSep.reliability, key: 'maxSeparation', value: fmtNum(metrics.hipShoulderSep.features.maxSeparation, 2), fault: metrics.hipShoulderSep.fault },
  { metric: 'tempo', reliability: metrics.tempo.reliability, key: 'tempoRatio', value: fmtNum(metrics.tempo.features.tempoRatio, 2), fault: metrics.tempo.fault },
  { metric: 'velocity', reliability: metrics.velocity.reliability, key: 'peakWristSpeed', value: fmtNum(metrics.velocity.joints.leftWrist?.peakSpeed, 5), fault: '' },
  { metric: 'kinematicSequence', reliability: metrics.kinematicSequence.reliability, key: 'correctSequence', value: metrics.kinematicSequence.features.correctSequence, fault: metrics.kinematicSequence.fault },
  { metric: 'casting', reliability: metrics.casting.reliability, key: 'wristPeakFrame', value: metrics.casting.features.wristPeakFrame, fault: metrics.casting.fault },
  { metric: 'swingStartDetection', reliability: metrics.swingStartDetection.reliability, key: 'framesOff', value: metrics.swingStartDetection.framesOff, fault: metrics.swingStartDetection.correctedFault },
];
console.table(summaryRows);

// ---------- 10) Write JSON ----------
const outPath = join(homedir(), 'Desktop', `analysis_${swingId}.json`);
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`\nWrote: ${outPath}`);
