/**
 * snapshotFaceOnBuckets.ts — READ-ONLY per-swing (id -> bucket) snapshot for the
 * face_on/RH population, for before/after success-membership diffing around a
 * detector change. Same JSONB filter + analyzePoseSequence path as sweepSwingGates.ts;
 * prints one `id<TAB>bucket` line per swing (sorted by id for stable diffs).
 *
 * Usage: npx --yes tsx scripts/snapshotFaceOnBuckets.ts > /tmp/buckets_before.tsv
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import { analyzePoseSequence } from "../packages/domain/swing/analysisPipeline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENV_PATH = join(resolve(__dirname, ".."), ".env");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  let text = "";
  try {
    text = readFileSync(ENV_PATH, "utf8");
  } catch {
    return env;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[k] === undefined) env[k] = v;
  }
  return env;
}

interface SwingRow {
  id: string;
  motion_frames: PoseFrame[] | null;
}

function bucketOf(gate: string | null, phasesLength: number): string {
  if (gate != null) return gate;
  if (phasesLength > 0) return "success";
  return "no_gate_empty_phases";
}

async function main() {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("Missing supabase env");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await sb
    .from("swings")
    .select("id, motion_frames, swing_debug")
    .eq("swing_debug->>camera_angle", "face_on")
    .eq("swing_debug->>handedness", "right")
    .limit(100);
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  const rows = (data ?? []) as unknown as SwingRow[];

  const lines: string[] = [];
  for (const row of rows) {
    if (!row.motion_frames?.length) {
      lines.push(`${row.id}\tLOAD_FAIL`);
      continue;
    }
    const sequence: PoseSequence = { frames: row.motion_frames, source: "rtmw-l-2d-v1", metadata: {} };
    try {
      const result = analyzePoseSequence(sequence, false);
      const gate = (result.swing_debug?.fallback_gate as string | null) ?? null;
      const phases = (result.phases ?? []).length;
      lines.push(`${row.id}\t${bucketOf(gate, phases)}`);
    } catch (err) {
      lines.push(`${row.id}\tERROR:${err instanceof Error ? err.message : String(err)}`);
    }
  }
  lines.sort();
  for (const l of lines) console.log(l);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
