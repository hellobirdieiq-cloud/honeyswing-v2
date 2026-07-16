/**
 * replayCommon.ts — shared preamble for replay/validation scripts (T9-71).
 *
 * Extracted verbatim from the proven pattern in scripts/replayCorpusDigest.ts
 * so scripts stop re-implementing the .env loader and Supabase client factory
 * (≥10 scripts carried private copies as of 2026-07-16).
 *
 * Scripts-only module: nothing under app/, lib/, or packages/ may import this.
 * The corpus-digest gate tool deliberately keeps its own copy of everything —
 * the gate must stay stable independent of scaffold churn.
 *
 * The domain's real trail builder is re-exported here for scripts that used to
 * hand-rebuild it (buildTrailPoints is the production implementation from
 * analysisPipeline — canonical LEAD = right*, TRAIL = left*).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export { buildTrailPoints } from "../../packages/domain/swing/analysisPipeline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..");
const ENV_PATH = join(REPO_ROOT, ".env");

/** Merge repo .env over process.env (process.env wins), tolerating a missing file. */
export function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  let text = "";
  try {
    text = readFileSync(ENV_PATH, "utf8");
  } catch {
    return env;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
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

/**
 * Supabase client from env (service-role preferred; anon fallback is
 * RLS-scoped and will see fewer rows). Exits 1 with a message when the URL or
 * both keys are missing — replay scripts are useless without a client.
 */
export function makeClient(env: Record<string, string> = loadEnv()): SupabaseClient {
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error(
      "[replayCommon] Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/EXPO_PUBLIC_SUPABASE_ANON_KEY (.env auto-loaded)",
    );
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
