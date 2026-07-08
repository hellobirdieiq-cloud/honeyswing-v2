#!/usr/bin/env node
// One-off probe: does motion_frames[].joints carry a real z value?
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
if (!existsSync(envPath)) {
  console.error(`error: .env not found at ${envPath}`);
  process.exit(1);
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
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const URL = env.EXPO_PUBLIC_SUPABASE_URL;
if (!KEY || !URL) {
  console.error('error: SUPABASE_SERVICE_ROLE_KEY / EXPO_PUBLIC_SUPABASE_URL missing in .env');
  process.exit(1);
}

const supabase = createClient(
  URL,
  KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const SWING_ID = '77b49def-08a1-4c28-afb9-fd6e873b6823';
const { data, error } = await supabase
  .from('swings')
  .select('motion_frames')
  .eq('id', SWING_ID)
  .maybeSingle();
if (error) {
  console.error(`supabase: ${error.message}`);
  process.exit(1);
}
if (!data?.motion_frames) {
  console.error('no motion_frames');
  process.exit(1);
}

const frame = data.motion_frames[51];
const probes = ['leftHip', 'rightHip', 'leftShoulder'];
const out = {};
for (const name of probes) out[name] = frame?.joints?.[name];

console.log('Frame 51 joints (full JSON):');
console.log(JSON.stringify(out, null, 2));

console.log('\nZ-value verdict:');
for (const name of probes) {
  const j = out[name];
  const z = j?.z;
  let verdict;
  if (z === undefined) verdict = 'MISSING (key not present)';
  else if (z === null) verdict = 'NULL';
  else if (z === 0) verdict = 'ZERO (literal 0)';
  else if (typeof z === 'number') verdict = `REAL NUMBER: ${z}`;
  else verdict = `UNEXPECTED TYPE: ${typeof z}`;
  console.log(`  ${name}: ${verdict}`);
}
