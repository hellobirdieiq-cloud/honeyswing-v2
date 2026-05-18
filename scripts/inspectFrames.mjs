#!/usr/bin/env node
// Read-only per-frame dump for one swing.
// Usage: node scripts/inspectFrames.mjs <swing_id>
// Reads Supabase creds from .env (EXPO_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY or EXPO_PUBLIC_SUPABASE_ANON_KEY).
// Pulls swings.motion_frames (same source as analyzeMaster.mjs) before any pipeline summarization,
// then writes one JSONL record per raw frame to ~/Desktop/frames_<swing_id>.json.
// No DB writes. No filtering. No transformation of joint data.

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
const swingId = process.argv.slice(2).find((a) => a && !a.startsWith('--'));
if (!swingId) {
  die('swing_id is required.\n  usage: node scripts/inspectFrames.mjs <swing_id>');
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
  .select('id, motion_frames, created_at')
  .eq('id', swingId)
  .maybeSingle();

if (error) die(`supabase query failed: ${error.message}`);
if (!data) die(`swing ${swingId} not found.`);
const frames = data.motion_frames;
if (!frames || !Array.isArray(frames) || frames.length === 0) {
  die(`motion_frames is null or empty for swing ${swingId}.`);
}

// ---------- 4) Per-frame dump ----------
// Discover every per-frame top-level field and every per-joint field across the entire sequence,
// so the report tells the truth about what is actually present (not just what the type declares).
const frameTopKeys = new Set();
const jointFieldKeys = new Set();
const jointNamesSeen = new Set();
let framesWithAnyZ = 0;

const lines = [];
for (let i = 0; i < frames.length; i++) {
  const f = frames[i] ?? {};
  for (const k of Object.keys(f)) frameTopKeys.add(k);

  const jointsObj = (f.joints && typeof f.joints === 'object') ? f.joints : {};
  const jointsOut = {};
  let frameHasZ = false;

  for (const [name, j] of Object.entries(jointsObj)) {
    jointNamesSeen.add(name);
    if (j && typeof j === 'object') {
      for (const k of Object.keys(j)) jointFieldKeys.add(k);
      jointsOut[name] = {
        x: j.x ?? null,
        y: j.y ?? null,
        z: (typeof j.z === 'number') ? j.z : null,
        confidence: (typeof j.confidence === 'number') ? j.confidence : null,
      };
      if (typeof j.z === 'number' && Number.isFinite(j.z) && j.z !== 0) frameHasZ = true;
    } else {
      jointsOut[name] = null;
    }
  }
  if (frameHasZ) framesWithAnyZ++;

  // Preserve ALL top-level frame fields (timestampMs, frameWidth, frameHeight, anything else),
  // then attach our normalized joints map.
  const record = {
    frame_index: i,
    ...f,
    joints: jointsOut,
  };
  lines.push(JSON.stringify(record));
}

// ---------- 5) Write output ----------
const outPath = join(homedir(), 'Desktop', `frames_${swingId}.json`);
writeFileSync(outPath, lines.join('\n') + '\n');

// ---------- 6) Console report ----------
console.log(`\nInspected swing ${swingId}`);
console.log(`Captured at        : ${data.created_at ?? 'n/a'}`);
console.log(`Frame count        : ${frames.length}`);
console.log(`Frames with any z  : ${framesWithAnyZ} / ${frames.length}`);
console.log(`Per-frame fields   : ${[...frameTopKeys].sort().join(', ')}`);
console.log(`Per-joint fields   : ${[...jointFieldKeys].sort().join(', ')}`);
console.log(`Distinct joints    : ${jointNamesSeen.size}`);
console.log(`Wrote: ${outPath}`);
