#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const swingId = process.argv[2];
if (!swingId) { console.error('usage: node scripts/dumpMotionFrames.mjs <swing_id>'); process.exit(1); }

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
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('missing Supabase creds in .env'); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const { data, error } = await supabase.from('swings').select('id, motion_frames').eq('id', swingId).maybeSingle();
if (error || !data) { console.error('fetch error:', error?.message ?? 'not found'); process.exit(1); }
if (!data.motion_frames?.length) { console.error('no motion_frames for this swing'); process.exit(1); }

const out = join(homedir(), 'Desktop', `motion_${swingId}.json`);
writeFileSync(out, JSON.stringify(data.motion_frames, null, 2));
console.log(`Wrote ${data.motion_frames.length} frames → ${out}`);
