/**
 * sweepSwingGates.ts — read-only aggregate sweep of phase-detection fallback gates.
 *
 * The aggregate counterpart to scripts/diagnoseSwingPhases.ts (which deep-dives ONE
 * swing). This re-runs the CURRENT analysis pipeline over a population of persisted
 * swings and tallies how often each phaseDetection `fallback_gate` fires vs. clean
 * success — so you can see whether detector changes help/hurt across real data, not
 * just the one default swing.
 *
 * Population: swings filtered to face-on camera angle AND right-handed. Camera angle
 * and handedness are NOT top-level columns — they live inside the `swing_debug` JSONB
 * column (swing_debug.camera_angle = "face_on", swing_debug.handedness = "right",
 * written by lib/persistSwing.ts). We filter on those JSONB paths.
 *
 * Each swing is analyzed exactly as diagnoseSwingPhases.ts:273 obtains its RESULT:
 * analyzePoseSequence(rawSequence, isLeftHanded=false). The pipeline runs
 * vetoAndInterpolateKeypoints + toCanonicalSequence internally (analysisPipeline.ts:
 * 527-528), so this is the authoritative measured path — we do not re-run those
 * helpers ourselves.
 *
 * Read-only: one SELECT, no DB writes, no detector edits, no file output.
 *
 * Usage:
 *   npx --yes tsx scripts/sweepSwingGates.ts            # up to 100 swings
 *   npx --yes tsx scripts/sweepSwingGates.ts --limit 25
 *
 * Env: EXPO_PUBLIC_SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY or
 * EXPO_PUBLIC_SUPABASE_ANON_KEY (read from .env at repo root, same loader as
 * scripts/diagnoseSwingPhases.ts).
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import { analyzePoseSequence } from "../packages/domain/swing/analysisPipeline";

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/diagnoseSwingPhases.ts:57-83)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const ENV_PATH = join(REPO_ROOT, ".env");

function loadEnv(): Record<string, string> {
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseLimit(argv: string[], fallback: number): number {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    } else if (a.startsWith("--limit=")) {
      const n = Number(a.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SwingRow {
  id: string;
  created_at: string;
  frame_count: number | null;
  motion_frames: PoseFrame[] | null;
  swing_debug: Record<string, unknown> | null;
}

interface PerSwing {
  swingId: string;
  cameraAngle: string | null; // stored selection criterion
  handedness: string | null; // stored selection criterion
  frameCount: number | null;
  fallbackGate: string | null; // re-run result
  phasesLength: number; // re-run result
  bucket: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error(
      "[sweepSwingGates] Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/EXPO_PUBLIC_SUPABASE_ANON_KEY in .env",
    );
    process.exit(1);
  }

  const limit = parseLimit(process.argv.slice(2), 100);
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Filter on JSONB paths inside swing_debug (NOT top-level columns).
  const { data, error } = await sb
    .from("swings")
    .select("id, created_at, frame_count, motion_frames, swing_debug")
    .eq("swing_debug->>camera_angle", "face_on")
    .eq("swing_debug->>handedness", "right")
    .limit(limit);
  if (error) {
    console.error("Supabase query error:", error.message);
    process.exit(1);
  }

  const rows = (data ?? []) as unknown as SwingRow[];
  const rowsReturned = rows.length;

  const analyzed: PerSwing[] = [];
  const loadFailures: string[] = [];
  const errored: string[] = [];

  for (const row of rows) {
    const rawFrames = row.motion_frames;
    if (!rawFrames || !Array.isArray(rawFrames) || rawFrames.length === 0) {
      loadFailures.push(row.id);
      continue;
    }

    const storedCameraAngle =
      typeof row.swing_debug?.camera_angle === "string"
        ? (row.swing_debug.camera_angle as string)
        : null;
    const storedHandedness =
      typeof row.swing_debug?.handedness === "string"
        ? (row.swing_debug.handedness as string)
        : null;

    // RH golfer → isLeftHanded=false (matches the handedness filter).
    const isLeftHanded = false;
    const sequence: PoseSequence = {
      frames: rawFrames,
      source: "rtmw-l-2d-v1",
      metadata: {},
    };

    let fallbackGate: string | null;
    let phasesLength: number;
    try {
      // Pipeline pre-clean only: analyzePoseSequence runs veto+canonical internally.
      const result = analyzePoseSequence(sequence, isLeftHanded);
      fallbackGate = result.swing_debug?.fallback_gate ?? null;
      phasesLength = (result.phases ?? []).length;
    } catch (err) {
      console.error(`  ! analyze failed for ${row.id}:`, err instanceof Error ? err.message : err);
      errored.push(row.id);
      continue;
    }

    // Bucket precedence: a fired gate wins; else success if phases produced.
    let bucket: string;
    if (fallbackGate != null) bucket = fallbackGate;
    else if (phasesLength > 0) bucket = "success";
    else bucket = "no_gate_empty_phases";

    analyzed.push({
      swingId: row.id,
      cameraAngle: storedCameraAngle,
      handedness: storedHandedness,
      frameCount: row.frame_count,
      fallbackGate,
      phasesLength,
      bucket,
    });
  }

  // --- Tally buckets.
  const counts = new Map<string, number>();
  for (const s of analyzed) counts.set(s.bucket, (counts.get(s.bucket) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const denom = analyzed.length;

  // --- Report.
  console.log("");
  console.log("=== sweepSwingGates ===");
  console.log(`Filter:        swing_debug.camera_angle = "face_on" AND swing_debug.handedness = "right"`);
  console.log(`--limit:       ${limit}`);
  console.log(`N (returned):  ${rowsReturned}`);
  console.log(`N (analyzed):  ${denom}`);
  console.log("");

  const pad = (s: string, w: number) => s.padEnd(w);
  const padl = (s: string, w: number) => s.padStart(w);
  const BUCKET_W = Math.max(6, ...sorted.map(([b]) => b.length));
  console.log(`${pad("bucket", BUCKET_W)}  ${padl("count", 6)}  ${padl("% of N", 8)}`);
  console.log(`${"-".repeat(BUCKET_W)}  ${"-".repeat(6)}  ${"-".repeat(8)}`);
  for (const [bucket, count] of sorted) {
    const pct = denom > 0 ? ((count / denom) * 100).toFixed(1) : "0.0";
    console.log(`${pad(bucket, BUCKET_W)}  ${padl(String(count), 6)}  ${padl(pct + "%", 8)}`);
  }
  console.log(`${"-".repeat(BUCKET_W)}  ${"-".repeat(6)}  ${"-".repeat(8)}`);
  console.log(`${pad("TOTAL", BUCKET_W)}  ${padl(String(denom), 6)}  ${padl("100.0%", 8)}`);
  console.log("");

  // --- ID dump for the impact_search_bounds bucket only (one per line).
  const impactSearchBoundsIds = analyzed
    .filter((s) => s.bucket === "impact_search_bounds")
    .map((s) => s.swingId);
  console.log(`impact_search_bounds swingIds (${impactSearchBoundsIds.length}):`);
  for (const id of impactSearchBoundsIds) console.log(id);
  console.log("");

  // --- Failures, reported against rows returned (the true denominator).
  console.log(`load failures: ${loadFailures.length}, errors: ${errored.length} (of ${rowsReturned} rows returned)`);
  if (loadFailures.length > 0) console.log(`  load-failed swingIds: ${loadFailures.join(", ")}`);
  if (errored.length > 0) console.log(`  errored swingIds:     ${errored.join(", ")}`);
  console.log("");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
