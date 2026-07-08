#!/usr/bin/env node
// One-off probe: what columns does the anon role see on `swings` (RLS check)?
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
const URL = env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!URL || !ANON_KEY) {
  console.error('error: EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY missing in .env');
  process.exit(1);
}

const s = createClient(URL, ANON_KEY);
const { data, error } = await s.from('swings').select('*').limit(1);
if (error) console.log('error:', error.message);
else if (!data || !data.length) console.log('no rows - RLS blocking anon');
else console.log('columns:', Object.keys(data[0]));
