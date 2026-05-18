#!/usr/bin/env node
// Read-only spine-angle analysis for one swing.
// Usage: node scripts/analyzeSpine.mjs <swing_id>
// Reads Supabase creds from .env (EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY).
// Does not write to the database. Output goes to stdout + ~/Desktop/spine_<id>.json.

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
const swingId = process.argv[2];
if (!swingId) {
  die('swing_id is required.\n  usage: node scripts/analyzeSpine.mjs <swing_id>');
}

// ---------- 2) Load .env (manual parse — no dotenv dep needed) ----------
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
if (!existsSync(envPath)) {
  die(`.env not found at ${envPath}`);
}
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
// Prefer service-role key when present (broader read access); fall back to anon key.
const SUPABASE_ANON_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  die('EXPO_PUBLIC_SUPABASE_URL missing, or no key found (need SUPABASE_SERVICE_ROLE_KEY or EXPO_PUBLIC_SUPABASE_ANON_KEY) in .env. Add the missing values, then re-run.');
}

// ---------- 3) Fetch the swing ----------
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data, error } = await supabase
  .from('swings')
  .select('motion_frames')
  .eq('id', swingId)
  .maybeSingle();

if (error) die(`supabase query failed: ${error.message}`);
if (!data) die(`swing ${swingId} not found.`);
const frames = data.motion_frames;
if (!frames || !Array.isArray(frames) || frames.length === 0) {
  die(`motion_frames is null or empty for swing ${swingId}.`);
}

// ---------- 4) Per-frame spine angle ----------
const REQUIRED_JOINTS = ['leftHip', 'rightHip', 'leftShoulder', 'rightShoulder'];
const CONF_MIN = 0.5;

function spineAngleForFrame(frame) {
  const j = frame?.joints ?? {};
  const conf = (jn) => (j[jn]?.confidence ?? 0);

  const minConf = Math.min(...REQUIRED_JOINTS.map(conf));
  if (REQUIRED_JOINTS.some((jn) => !j[jn]) || minConf < CONF_MIN) {
    return { angle: null, confidence: minConf, skipped: true };
  }

  const hipMid = {
    x: (j.leftHip.x + j.rightHip.x) / 2,
    y: (j.leftHip.y + j.rightHip.y) / 2,
  };
  const shoulderMid = {
    x: (j.leftShoulder.x + j.rightShoulder.x) / 2,
    y: (j.leftShoulder.y + j.rightShoulder.y) / 2,
  };
  const angle =
    (Math.atan2(
      Math.abs(shoulderMid.x - hipMid.x),
      Math.abs(hipMid.y - shoulderMid.y),
    ) *
      180) /
    Math.PI;
  return { angle, confidence: minConf, skipped: false };
}

const curve = frames.map((f, frameIndex) => {
  const r = spineAngleForFrame(f);
  return {
    frameIndex,
    angle: r.angle,
    confidence: Number(r.confidence.toFixed(4)),
    skipped: r.skipped,
  };
});

// ---------- 5) Feature extraction ----------
const framesSkipped = curve.filter((c) => c.skipped).length;

// addressAngle: spine angle at frame index 0. If frame 0 is skipped, fall back to first usable.
const firstUsable = curve.find((c) => !c.skipped);
const frame0Entry = curve[0];
const addressAngle =
  frame0Entry && !frame0Entry.skipped ? frame0Entry.angle : (firstUsable?.angle ?? null);
const addressFrameUsed = frame0Entry && !frame0Entry.skipped ? 0 : firstUsable?.frameIndex ?? null;

let minAngle = null;
let minFrame = null;
for (const c of curve) {
  if (c.skipped || c.angle == null) continue;
  if (minAngle == null || c.angle < minAngle) {
    minAngle = c.angle;
    minFrame = c.frameIndex;
  }
}

let maxDrift = 0;
let driftOnsetFrame = null;
if (addressAngle != null) {
  for (const c of curve) {
    if (c.skipped || c.angle == null) continue;
    const drift = addressAngle - c.angle; // positive = lost spine angle (more upright than setup)
    if (drift > maxDrift) {
      maxDrift = drift;
      driftOnsetFrame = c.frameIndex;
    }
  }
}
const faultDetected = maxDrift > 8;

const stabilityWindow =
  addressAngle == null
    ? 0
    : curve.filter(
        (c) => !c.skipped && c.angle != null && Math.abs(c.angle - addressAngle) <= 5,
      ).length;

// ---------- 6) Console output ----------
console.log(`\nSpine analysis for swing ${swingId}`);
console.log(`Total frames: ${curve.length}   Skipped (low confidence): ${framesSkipped}\n`);

const head = ['frame', 'spineAngle', 'minConf', 'flag'];
const rows = curve.map((c) => [
  String(c.frameIndex),
  c.skipped ? '—' : c.angle.toFixed(2) + '°',
  c.confidence.toFixed(3),
  c.skipped ? 'SKIPPED' : '',
]);
const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const fmtRow = (r) => '  ' + r.map((v, i) => v.padEnd(widths[i])).join('  ');
console.log(fmtRow(head));
console.log('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(fmtRow(r));

console.log('\nFeature summary:');
const fmt = (v, suffix = '') =>
  v == null ? 'n/a' : (typeof v === 'number' ? v.toFixed(2) : String(v)) + suffix;
console.log(`  addressAngle      : ${fmt(addressAngle, '°')}${addressFrameUsed !== 0 && addressFrameUsed != null ? `  (frame 0 skipped; using frame ${addressFrameUsed})` : ''}`);
console.log(`  minAngle          : ${fmt(minAngle, '°')}    (frame ${minFrame ?? 'n/a'})`);
console.log(`  maxDrift          : ${fmt(maxDrift, '°')}    (onset frame ${driftOnsetFrame ?? 'n/a'})`);
console.log(`  faultDetected     : ${faultDetected}    (threshold > 8°)`);
console.log(`  framesSkipped     : ${framesSkipped}`);
console.log(`  stabilityWindow   : ${stabilityWindow}    (frames within 5° of address)`);

// ---------- 7) JSON file ----------
const outPath = join(homedir(), 'Desktop', `spine_${swingId}.json`);
const payload = {
  swingId,
  frameCount: curve.length,
  framesSkipped,
  curve,
  features: {
    addressAngle,
    minAngle,
    minFrame,
    maxDrift,
    driftOnsetFrame,
    faultDetected,
    stabilityWindow,
  },
};
writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`\nWrote: ${outPath}`);
