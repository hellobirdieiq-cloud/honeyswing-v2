/**
 * identity-validate.ts — End-to-end acceptance tests for the Layer-0
 * lower-body identity-correction pass against four real swings. Synthetic
 * unit tests live in packages/domain/swing/lowerBodyIdentity.test.ts.
 *
 * Usage:
 *   npx --yes tsx scripts/identity-validate.ts
 *
 * Env: EXPO_PUBLIC_SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY or
 * EXPO_PUBLIC_SUPABASE_ANON_KEY (read from .env at repo root, same loader as
 * scripts/veto-validate.ts).
 *
 * Swing IDs (project xutbbirehugrrbkauhnl; all right-handed):
 *   CLEAN     5827e8bd-ff8e-4390-bb08-badf1957ba1a  (270 frames, clean tracking)
 *   SWAP_F72  f72e056b-bbc7-4f65-9765-9e5b01dd8e0d  (L/R exchanges at f60, f115-124)
 *   SWAP_3C5  3c5f2ce2-97ae-4f33-b0f0-e96770cf502e  (worst offender; 60-frame run f154-213)
 *   SWAP_729  729e41bc-e137-4965-96b5-35b4a33bbc39  (exchanges f98-102 + one-leg collapse f35-58)
 *
 * Acceptance:
 *   #1 crossing counts: raw f72e056b = 11 → corrected 0; 3c5f2ce2 ~70 → 0;
 *      729e41bc > 0 → 0. "Crossing" = decision-grade vote ≠ s0 (the frames
 *      the state machine acts on).
 *   #2 729e41bc one-leg collapse f35-58 preserved byte-identical (it is the
 *      veto's job, not identity's).
 *   #3 clean swing: 0 frames modified.
 *   #4 idempotency: second application deep-equals the first, swaps nothing.
 *   #5 pipeline smoke: analyzePoseSequence carries keypoint_identity debug
 *      (top level of swing_debug, sibling of keypoint_veto — swing_debug IS
 *      the FrameSelectionDebug object, analysisPipeline.ts:104).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../lib/database.types";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import { analyzePoseSequence } from "../packages/domain/swing/analysisPipeline";
import {
  correctLowerBodyIdentity,
  countIdentityCrossings,
} from "../packages/domain/swing/lowerBodyIdentity";

const CLEAN_ID = "5827e8bd-ff8e-4390-bb08-badf1957ba1a";
const SWAP_F72_ID = "f72e056b-bbc7-4f65-9765-9e5b01dd8e0d";
const SWAP_3C5_ID = "3c5f2ce2-97ae-4f33-b0f0-e96770cf502e";
const SWAP_729_ID = "729e41bc-e137-4965-96b5-35b4a33bbc39";

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/veto-validate.ts)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const ENV_PATH = join(REPO_ROOT, ".env");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  let text = "";
  try { text = readFileSync(ENV_PATH, "utf8"); } catch { return env; }
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
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function group(name: string): void { console.log(`\n── ${name} ──`); }
function assert(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}`); failed++; }
}
function info(label: string): void { console.log(`  ℹ️  ${label}`); }

function toSequence(frames: PoseFrame[]): PoseSequence {
  return { frames, source: "rtmw-l-2d-v1", metadata: { fps: 60 } };
}

async function loadFrames(
  sb: SupabaseClient<Database>,
  id: string,
): Promise<PoseFrame[]> {
  const { data, error } = await sb
    .from("swings")
    .select("id, motion_frames")
    .eq("id", id)
    .maybeSingle();
  if (error) { console.error("Supabase error:", error.message); process.exit(1); }
  if (!data) { console.error(`No swing found with id=${id}`); process.exit(1); }
  const frames = (data as { motion_frames: PoseFrame[] | null }).motion_frames;
  if (!frames || !Array.isArray(frames) || frames.length === 0) {
    console.error(`motion_frames empty for ${id}`);
    process.exit(1);
  }
  return frames;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("[identity-validate] Missing EXPO_PUBLIC_SUPABASE_URL or key in .env");
    process.exit(1);
  }
  const sb = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const swings: { label: string; id: string }[] = [
    { label: "clean 5827e8bd", id: CLEAN_ID },
    { label: "swap f72e056b", id: SWAP_F72_ID },
    { label: "swap 3c5f2ce2", id: SWAP_3C5_ID },
    { label: "swap 729e41bc", id: SWAP_729_ID },
  ];

  for (const { label, id } of swings) {
    group(label);
    const raw = await loadFrames(sb, id);
    const r = correctLowerBodyIdentity(raw);

    info(`frames=${raw.length} baselineSign=${r.baselineSign} ` +
      `baselineMargin=${JSON.stringify(r.baselineMargin)} ` +
      `lowConfidenceBaseline=${r.lowConfidenceBaseline}`);

    if (r.baselineSign === null) {
      assert(false, "baseline established");
      continue;
    }
    const rawCrossings = countIdentityCrossings(raw, r.baselineSign);
    const correctedCrossings = countIdentityCrossings(r.frames, r.baselineSign);
    info(`crossings raw=${rawCrossings} corrected=${correctedCrossings} ` +
      `swapped=${r.swappedFrames.length} frames [${r.swappedFrames.slice(0, 8).join(",")}${r.swappedFrames.length > 8 ? ",…" : ""}]`);

    if (id === CLEAN_ID) {
      assert(rawCrossings === 0, "clean swing: 0 raw crossings");
      assert(r.swappedFrames.length === 0, "clean swing: 0 frames modified");
      assert(r.frames.every((f, i) => f === raw[i]), "clean swing: all frames by reference");
    } else {
      assert(rawCrossings > 0, `raw crossings > 0 (${rawCrossings})`);
      assert(correctedCrossings === 0, "corrected crossings = 0");
    }
    if (id === SWAP_F72_ID) {
      assert(rawCrossings === 11, `f72e056b raw crossings = 11 (got ${rawCrossings})`);
    }
    if (id === SWAP_3C5_ID) {
      assert(rawCrossings >= 60 && rawCrossings <= 85, `3c5f2ce2 raw crossings ≈70 (got ${rawCrossings})`);
    }
    if (id === SWAP_729_ID) {
      const preserved = raw.slice(35, 59).every((f, i) => deepEqual(f, r.frames[35 + i]));
      assert(preserved, "one-leg collapse f35-58 preserved byte-identical (veto's job)");
    }

    // Idempotency on real data
    const r2 = correctLowerBodyIdentity(r.frames);
    assert(r2.swappedFrames.length === 0, "idempotency: second pass swaps nothing");
    assert(deepEqual(r.frames, r2.frames), "idempotency: second pass deep-equals first");
  }

  // Pipeline smoke: identity debug surfaces through analyzePoseSequence.
  group("pipeline smoke (clean + f72e056b)");
  {
    const clean = await loadFrames(sb, CLEAN_ID);
    const cleanResult = analyzePoseSequence(toSequence(clean));
    const cleanIdentity = cleanResult.swing_debug?.keypoint_identity;
    assert(cleanIdentity != null, "keypoint_identity present in swing_debug");
    assert(cleanIdentity?.swapped_frames.length === 0, "clean swing: pipeline reports 0 swaps");

    assert(cleanResult.phases != null && cleanResult.phases.length > 0, "clean swing: phases produced");

    const f72 = await loadFrames(sb, SWAP_F72_ID);
    const f72Result = analyzePoseSequence(toSequence(f72));
    const f72Identity = f72Result.swing_debug?.keypoint_identity;
    assert((f72Identity?.swapped_frames.length ?? 0) > 0, "f72e056b: pipeline reports swaps");
    // f72e056b NEVER produced phases — probed identical with and without the
    // identity pass on 2026-06-03: phases=[], fallback_gate="top_search_bounds",
    // method=mid_frame_fallback. The invariant is that identity correction
    // does not change that gate outcome, not that phases appear.
    assert(
      f72Result.swing_debug?.fallback_gate === "top_search_bounds",
      "f72e056b: fallback gate unchanged by identity pass (top_search_bounds)",
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
