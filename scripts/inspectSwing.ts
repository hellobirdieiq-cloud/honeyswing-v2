/**
 * inspectSwing.ts — Fetches a swing's motion_frames from Supabase, prints a
 * quick sanity report (gravity vector + sampled wrist velocities), and writes
 * the full motion sequence to ~/Desktop/analysis_{id}.json for the skeleton
 * viewer.
 *
 * Usage:
 *   npx --yes tsx scripts/inspectSwing.ts            # most recent gravity-vector swing
 *   npx --yes tsx scripts/inspectSwing.ts <swingId>  # specific swing
 *
 * Env: EXPO_PUBLIC_SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY or
 * EXPO_PUBLIC_SUPABASE_ANON_KEY (read from .env at repo root, same as
 * scripts/validate-phase-rules.ts).
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame } from "../packages/pose/PoseTypes";

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/validate-phase-rules.ts)
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
// Helpers
// ---------------------------------------------------------------------------

type GravityVector = { x: number; y: number; z: number } | null;

interface SwingRow {
  id: string;
  created_at: string;
  gravity_vector: GravityVector;
  frame_count: number | null;
  motion_frames: PoseFrame[] | null;
}

function fmt(v: number | undefined | null): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  return v.toFixed(4);
}

function printJointVelocity(frame: PoseFrame, jointName: "leftWrist" | "rightWrist"): {
  hasAny: boolean;
} {
  const j = frame.joints[jointName];
  if (!j) {
    console.log(`    ${jointName}: <missing>`);
    return { hasAny: false };
  }
  const hasAny = j.vx !== undefined || j.vy !== undefined || j.vz !== undefined;
  console.log(`    ${jointName}: vx=${fmt(j.vx)} vy=${fmt(j.vy)} vz=${fmt(j.vz)}`);
  return { hasAny };
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
      "[inspectSwing] Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/EXPO_PUBLIC_SUPABASE_ANON_KEY in .env",
    );
    process.exit(1);
  }

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const argId = process.argv[2];
  let row: SwingRow;

  if (argId) {
    const { data, error } = await sb
      .from("swings")
      .select("id, created_at, gravity_vector, frame_count, motion_frames")
      .eq("id", argId)
      .maybeSingle();
    if (error) {
      console.error("Supabase query error:", error.message);
      process.exit(1);
    }
    if (!data) {
      console.error(`No swing found with id=${argId}`);
      process.exit(1);
    }
    row = data as unknown as SwingRow;
  } else {
    const { data, error } = await sb
      .from("swings")
      .select("id, created_at, gravity_vector, frame_count, motion_frames")
      .not("gravity_vector", "is", null)
      .order("created_at", { ascending: false })
      .limit(3);
    if (error) {
      console.error("Supabase query error:", error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) {
      console.error("No swings found with gravity_vector populated.");
      process.exit(1);
    }
    row = data[0] as unknown as SwingRow;
    console.log(`(no swing id given — using most recent of ${data.length} gravity-vector swings)`);
  }

  // --- 1. Header
  console.log("");
  console.log(`Swing ID:    ${row.id}`);
  console.log(`Created at:  ${row.created_at}`);
  console.log(`Frame count: ${row.frame_count ?? "<null>"}`);

  // --- 2. Gravity vector
  const gv = row.gravity_vector;
  if (gv && typeof gv === "object") {
    console.log(
      `Gravity:     x=${fmt(gv.x)} y=${fmt(gv.y)} z=${fmt(gv.z)}`,
    );
  } else {
    console.log("Gravity:     <null>");
  }

  // --- 3. Velocity sample
  const frames = row.motion_frames;
  if (!frames || !Array.isArray(frames) || frames.length === 0) {
    console.error("\nmotion_frames is empty or missing — nothing to inspect.");
    process.exit(1);
  }

  const desired = [10, 50, 100];
  const lastIdx = frames.length - 1;
  const sampleIndices = desired.map((i) => Math.min(i, lastIdx));
  // De-dupe in case frames.length < 11
  const uniqueIndices = Array.from(new Set(sampleIndices));

  console.log("\nVelocity sample (leftWrist / rightWrist):");
  let anyVelocity = false;
  for (const idx of uniqueIndices) {
    console.log(`  frame ${idx}:`);
    const f = frames[idx];
    if (!f || !f.joints) {
      console.log("    <frame missing>");
      continue;
    }
    const l = printJointVelocity(f, "leftWrist");
    const r = printJointVelocity(f, "rightWrist");
    if (l.hasAny || r.hasAny) anyVelocity = true;
  }

  if (anyVelocity) {
    console.log("\n✅ velocity populated");
  } else {
    console.log("\n⚠️ velocity fields missing");
  }

  // --- 4. Write analysis file
  const outPath = join(homedir(), "Desktop", `analysis_${row.id}.json`);
  const payload = {
    swingId: row.id,
    createdAt: row.created_at,
    motionFrames: frames,
    phases: null,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
