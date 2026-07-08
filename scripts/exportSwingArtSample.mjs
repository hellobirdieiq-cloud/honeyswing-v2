#!/usr/bin/env node
// DEV-ONLY one-shot — requires SUPABASE_SERVICE_ROLE_KEY in .env (anon key is
// RLS-blocked and returns no row). Never ships; tracked for reproducibility of
// how Swing Art V2's visual constants were derived (playground vs 37022ba).
//
// Export ONE swing's Swing-Art render inputs to ~/Desktop/swing_art_sample.json.
//
// Saves ONLY the fields components/SwingArtCard.tsx actually consumes, so a
// standalone HTML playground can replicate the neon trace against real data:
//   - per frame: timestampMs, leftWrist/rightWrist {x,y,confidence,vx?,vy?},
//     and the 8 ghost-skeleton joints {x,y,confidence}
//   - phases:  [{phase, index, timestamp}]  (drives the impact accent)
//   - meta:    frameWidth/height, fps, handedness, camera angle
//
// Coordinates are normalized 0-1 (PoseTypes.NormalizedJoint). This script does
// NO smoothing / trimming / scaling — the playground owns all tuning knobs
// (smoothTrail window/passes, trimDeceleration threshold, Catmull-Rom, glow).
//
// NOTE: motion_frames are exported RAW, exactly as stored. The app applies a
// read-time correctLowerBodyIdentity() that can relabel hips/knees/ankles; it
// does NOT touch wrists, so the hero neon trace is identical. Ghost legs in the
// playground may differ slightly from the app until that correction is ported.
//
// usage: node scripts/exportSwingArtSample.mjs [swing_id]
//   (defaults to the 460-frame face-on reference swing)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_SWING_ID = '9834641d-04e9-4905-87fb-7270a2c5e54f';
const swingId = process.argv[2] || DEFAULT_SWING_ID;

// Joints the renderer reads (SwingArtCard.tsx:110-119, :140).
const WRIST_JOINTS = ['leftWrist', 'rightWrist'];
const GHOST_JOINTS = [
  'leftShoulder', 'rightShoulder',
  'leftElbow', 'rightElbow',
  'leftHip', 'rightHip',
  'leftKnee', 'rightKnee',
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
if (!existsSync(envPath)) { console.error('.env not found'); process.exit(1); }

const env = {};
for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  let val = line.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
  env[line.slice(0, eq).trim()] = val;
}

const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
// Service role bypasses RLS (swings SELECT is scoped to the owning Clerk user).
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('missing Supabase creds in .env'); process.exit(1); }
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('WARNING: no SUPABASE_SERVICE_ROLE_KEY — anon key is RLS-blocked and will return no row.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const { data, error } = await supabase
  .from('swings')
  .select('id, motion_frames, phases, fps_actual, duration_ms, frame_count, swing_debug')
  .eq('id', swingId)
  .maybeSingle();

if (error || !data) { console.error('fetch error:', error?.message ?? 'not found'); process.exit(1); }
const frames = data.motion_frames;
if (!Array.isArray(frames) || frames.length === 0) { console.error('no motion_frames for this swing'); process.exit(1); }

const round = (n, p) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(p)) : undefined);

// wrist: keep x,y,confidence,vx,vy (velocity present after enrichFramesWithVelocity)
function reduceWrist(j) {
  if (!j || typeof j.x !== 'number' || typeof j.y !== 'number') return null;
  const o = { x: round(j.x, 5), y: round(j.y, 5) };
  if (typeof j.confidence === 'number') o.confidence = round(j.confidence, 3);
  if (typeof j.vx === 'number') o.vx = round(j.vx, 6);
  if (typeof j.vy === 'number') o.vy = round(j.vy, 6);
  return o;
}
// ghost: x,y,confidence only (SwingArtCard draws ghost lines, no velocity used)
function reduceGhost(j) {
  if (!j || typeof j.x !== 'number' || typeof j.y !== 'number') return null;
  const o = { x: round(j.x, 5), y: round(j.y, 5) };
  if (typeof j.confidence === 'number') o.confidence = round(j.confidence, 3);
  return o;
}

const outFrames = frames.map((f) => {
  const joints = f.joints ?? {};
  const frame = { timestampMs: f.timestampMs };
  for (const name of WRIST_JOINTS) frame[name] = reduceWrist(joints[name]);
  for (const name of GHOST_JOINTS) frame[name] = reduceGhost(joints[name]);
  return frame;
});

const phasesRaw = Array.isArray(data.phases) ? data.phases : [];
const phases = phasesRaw.map((p) => ({ phase: p.phase, index: p.index, timestamp: p.timestamp }));

const sample = {
  swingId: data.id,
  meta: {
    frameWidth: frames[0]?.frameWidth ?? null,
    frameHeight: frames[0]?.frameHeight ?? null,
    fps_actual: data.fps_actual ?? null,
    durationMs: data.duration_ms ?? null,
    frameCount: data.frame_count ?? frames.length,
    handedness: data.swing_debug?.handedness ?? null,
    camera_angle: data.swing_debug?.camera_angle ?? null,
    coordinateSpace: 'normalized_0_1',
    note: 'RAW motion_frames as stored; app applies read-time correctLowerBodyIdentity to legs only (wrists unaffected).',
  },
  phases,
  frames: outFrames,
};

const out = join(homedir(), 'Desktop', 'swing_art_sample.json');
writeFileSync(out, JSON.stringify(sample));

// ── Summary ──────────────────────────────────────────────────────────
const bothWrist = outFrames.filter((f) => f.leftWrist && f.rightWrist).length;
const impact = phases.find((p) => p.phase === 'impact');
console.log(`Wrote ${outFrames.length} frames → ${out}`);
console.log(`  both-wrist frames : ${bothWrist} / ${outFrames.length}`);
console.log(`  phases            : ${phases.map((p) => `${p.phase}@${p.index}`).join(', ') || '(none)'}`);
console.log(`  impact            : ${impact ? `index ${impact.index}, t=${impact.timestamp}ms` : '(none)'}`);
console.log(`  handedness/angle  : ${sample.meta.handedness} / ${sample.meta.camera_angle}`);
console.log(`  frame[0].timestampMs=${outFrames[0].timestampMs}  frame[last]=${outFrames[outFrames.length - 1].timestampMs}`);
