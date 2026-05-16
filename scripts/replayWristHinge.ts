/**
 * replayWristHinge.ts — Fetches motion_frames from Supabase, runs the full
 * analyzePoseSequence pipeline, and prints the three new face-to-path debug
 * fields. Use this output to calibrate the placeholder thresholds in
 * packages/domain/swing/wristHinge.ts and syntheticClubheadPath.ts.
 *
 * Usage:
 *   npx --yes tsx scripts/replayWristHinge.ts                  # most recent N swings (default 20)
 *   npx --yes tsx scripts/replayWristHinge.ts <swingId>        # one specific swing
 *   npx --yes tsx scripts/replayWristHinge.ts --limit 30       # most recent 30 swings
 *
 * Env: EXPO_PUBLIC_SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY or
 * EXPO_PUBLIC_SUPABASE_ANON_KEY (read from .env at repo root, same as
 * scripts/inspectSwing.ts).
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import { analyzePoseSequence } from "../packages/domain/swing/analysisPipeline";

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/inspectSwing.ts)
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
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { swingId?: string; limit: number } {
  let swingId: string | undefined;
  let limit = 20;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit" && i + 1 < argv.length) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) limit = n;
      continue;
    }
    if (!a.startsWith("--")) swingId = a;
  }
  return { swingId, limit };
}

// ---------------------------------------------------------------------------
// Histogram helper
// ---------------------------------------------------------------------------

function histogram(values: number[], edges: number[]): number[] {
  const counts = new Array<number>(edges.length + 1).fill(0);
  for (const v of values) {
    let placed = false;
    for (let i = 0; i < edges.length; i++) {
      if (v < edges[i]) { counts[i]++; placed = true; break; }
    }
    if (!placed) counts[edges.length]++;
  }
  return counts;
}

function fmtBuckets(counts: number[], edges: number[]): string {
  const labels: string[] = [];
  labels.push(`<${edges[0]}: ${counts[0]}`);
  for (let i = 0; i < edges.length - 1; i++) {
    labels.push(`[${edges[i]},${edges[i + 1]}): ${counts[i + 1]}`);
  }
  labels.push(`≥${edges[edges.length - 1]}: ${counts[counts.length - 1]}`);
  return labels.join("  |  ");
}

// ---------------------------------------------------------------------------
// Row + result types
// ---------------------------------------------------------------------------

interface SwingRow {
  id: string;
  created_at: string;
  frame_count: number | null;
  motion_frames: PoseFrame[] | null;
  is_left_handed: boolean | null;
}

function fmt(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
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
      "[replayWristHinge] Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/EXPO_PUBLIC_SUPABASE_ANON_KEY in .env",
    );
    process.exit(1);
  }

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { swingId, limit } = parseArgs(process.argv);

  const select = "id, created_at, frame_count, motion_frames, is_left_handed";
  let rows: SwingRow[];

  if (swingId) {
    const { data, error } = await sb
      .from("swings")
      .select(select)
      .eq("id", swingId)
      .maybeSingle();
    if (error) { console.error("Supabase query error:", error.message); process.exit(1); }
    if (!data) { console.error(`No swing found with id=${swingId}`); process.exit(1); }
    rows = [data as unknown as SwingRow];
  } else {
    const { data, error } = await sb
      .from("swings")
      .select(select)
      .not("motion_frames", "is", null)
      .gte("frame_count", 100)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) { console.error("Supabase query error:", error.message); process.exit(1); }
    if (!data || data.length === 0) { console.error("No swings found."); process.exit(1); }
    rows = data as unknown as SwingRow[];
    console.log(`(no swing id given — replaying ${rows.length} most recent swings with motion_frames)`);
  }

  console.log("");
  console.log(
    "id".padEnd(38) +
      "  " + "face".padEnd(8) +
      "  " + "hinge°".padStart(7) +
      "  " + "Δtrans°".padStart(8) +
      "  " + "path".padEnd(10) +
      "  " + "pathAngle°".padStart(10) +
      "  " + "ballFlight",
  );
  console.log("─".repeat(110));

  const hingeAtImpactSamples: number[] = [];
  const deltaTransitionSamples: number[] = [];
  const pathAngleSamples: number[] = [];
  let withRead = 0;
  let skipped = 0;

  for (const row of rows) {
    const frames = row.motion_frames;
    if (!frames || !Array.isArray(frames) || frames.length === 0) {
      console.log(`${row.id}  <no motion_frames>`);
      skipped++;
      continue;
    }
    const sequence: PoseSequence = { frames, source: "replay" };
    const result = analyzePoseSequence(sequence, row.is_left_handed ?? false);
    const hinge = result.swing_debug?.lead_wrist_hinge ?? null;
    const path = result.swing_debug?.synthetic_clubhead_path ?? null;
    const ftp = result.swing_debug?.face_to_path ?? null;

    if (!hinge || !path || !ftp) {
      console.log(`${row.id}  <gated — hinge=${!!hinge} path=${!!path} ftp=${!!ftp}>`);
      skipped++;
      continue;
    }

    withRead++;
    hingeAtImpactSamples.push(hinge.hingeAtImpactDeg);
    deltaTransitionSamples.push(hinge.deltaTransitionDeg);
    pathAngleSamples.push(path.pathAngleAtImpactDeg);

    console.log(
      row.id.padEnd(38) +
        "  " + ftp.faceCategory.padEnd(8) +
        "  " + fmt(hinge.hingeAtImpactDeg).padStart(7) +
        "  " + fmt(hinge.deltaTransitionDeg).padStart(8) +
        "  " + ftp.pathCategory.padEnd(10) +
        "  " + fmt(path.pathAngleAtImpactDeg).padStart(10) +
        "  " + ftp.ballFlightLabel,
    );
  }

  console.log("─".repeat(110));
  console.log(`Replayed: ${rows.length}    With face-to-path read: ${withRead}    Skipped: ${skipped}`);

  if (withRead > 0) {
    console.log("\nHistograms (use these to set threshold cuts):");
    const hingeEdges = [-30, -15, -10, -5, 0, 5, 10, 15, 30];
    const pathEdges = [-25, -15, -8, -3, 0, 3, 8, 15, 25];
    console.log(`  hingeAtImpactDeg     ${fmtBuckets(histogram(hingeAtImpactSamples, hingeEdges), hingeEdges)}`);
    console.log(`  deltaTransitionDeg   ${fmtBuckets(histogram(deltaTransitionSamples, hingeEdges), hingeEdges)}`);
    console.log(`  pathAngleAtImpactDeg ${fmtBuckets(histogram(pathAngleSamples, pathEdges), pathEdges)}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
