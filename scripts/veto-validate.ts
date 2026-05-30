/**
 * veto-validate.ts — End-to-end acceptance tests for the Layer-1 velocity-veto
 * pass against two real swings (acceptance #1, #2). Synthetic unit tests for
 * #3/#4 live in packages/domain/swing/keypointVeto.test.ts.
 *
 * Usage:
 *   npx --yes tsx scripts/veto-validate.ts
 *
 * Env: EXPO_PUBLIC_SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY or
 * EXPO_PUBLIC_SUPABASE_ANON_KEY (read from .env at repo root, same loader as
 * scripts/inspectSwing.ts).
 *
 * Swing IDs (resolved from project xutbbirehugrrbkauhnl; both right-handed):
 *   CLEAN    5827e8bd-ff8e-4390-bb08-badf1957ba1a  (270 frames, clean tracking)
 *   COLLAPSE f72e056b-bbc7-4f65-9765-9e5b01dd8e0d  (190 frames, teleports in f60+)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import { analyzePoseSequence } from "../packages/domain/swing/analysisPipeline";
import {
  classifyKeypointStates,
  vetoAndInterpolateKeypoints,
  PER_JOINT_THRESHOLD,
  TRACKED_JOINTS,
} from "../packages/domain/swing/keypointVeto";

const CLEAN_ID = "5827e8bd-ff8e-4390-bb08-badf1957ba1a";
const COLLAPSE_ID = "f72e056b-bbc7-4f65-9765-9e5b01dd8e0d";

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

function toSequence(frames: PoseFrame[]): PoseSequence {
  return { frames, source: "rtmw-l-2d-v1", metadata: { fps: 60 } };
}

function phaseIndex(
  result: ReturnType<typeof analyzePoseSequence>,
  phase: string,
): number | null {
  const p = result.phases?.find((x) => x.phase === phase);
  return p ? p.index : null;
}

/** Count TELEPORT joint-frames at frame index >= minFrame across all tracked joints. */
function teleportSpikes(frames: PoseFrame[], minFrame: number): number {
  const states = classifyKeypointStates(frames);
  let count = 0;
  for (const joint of TRACKED_JOINTS) {
    const s = states[joint];
    for (let i = minFrame; i < s.length; i++) {
      if (s[i] === "TELEPORT") count++;
    }
  }
  return count;
}

async function loadFrames(
  sb: ReturnType<typeof createClient>,
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("[veto-validate] Missing EXPO_PUBLIC_SUPABASE_URL or key in .env");
    process.exit(1);
  }
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // -------------------------------------------------------------------------
  // Test #1 — clean swing: impact unchanged + legit downswing preserved
  // -------------------------------------------------------------------------
  group("#1 clean swing 5827e8bd");
  {
    const raw = await loadFrames(sb, CLEAN_ID);

    // Part A — true veto-vs-no-veto: impact recomputed at runtime (no literal).
    //   rawResult    = analyze with the veto BYPASSED (pre-L1 path, skipVeto:true)
    //   vetoedResult = analyze with the veto applied once (production path)
    const rawResult = analyzePoseSequence(toSequence(raw), false, [], undefined, { skipVeto: true });
    const vetoedResult = analyzePoseSequence(toSequence(raw));
    const rawImpact = phaseIndex(rawResult, "impact");
    const vetoedImpact = phaseIndex(vetoedResult, "impact");
    console.log(`  no-veto impact=${rawImpact}, vetoed impact=${vetoedImpact}`);
    assert(rawImpact !== null, "no-veto run resolves an impact frame");
    assert(rawImpact === vetoedImpact, `impact unchanged by veto (no-veto=${rawImpact}, vetoed=${vetoedImpact})`);

    // Part B — re-derive fastest legit downswing leftWrist motion from THIS swing.
    // Intentionally uses rawResult (the no-veto baseline) for the [top, impact]
    // window: the legit-motion check must measure against phases detected WITHOUT
    // the veto, so the coupling to Part A's no-veto result is deliberate.
    const topIdx = phaseIndex(rawResult, "top");
    const impactIdx = rawImpact;
    if (topIdx === null || impactIdx === null || impactIdx <= topIdx) {
      console.log(`  (skipping Part B — downswing window unavailable: top=${topIdx}, impact=${impactIdx})`);
    } else {
      const lw = raw.map((f) => f.joints.leftWrist ?? null);
      let maxStep = 0;
      for (let i = topIdx + 1; i <= impactIdx; i++) {
        const a = lw[i - 1];
        const b = lw[i];
        if (a && b) {
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          if (d > maxStep) maxStep = d;
        }
      }
      console.log(`  downswing window [${topIdx}, ${impactIdx}]: max leftWrist single-frame motion = ${maxStep.toFixed(4)}`);
      assert(maxStep < PER_JOINT_THRESHOLD.leftWrist, `fastest downswing motion ${maxStep.toFixed(4)} < wrist threshold ${PER_JOINT_THRESHOLD.leftWrist} (threshold does not clip legit motion)`);

      const states = classifyKeypointStates(raw).leftWrist;
      let allGood = true;
      let firstBad = -1;
      for (let i = topIdx; i <= impactIdx; i++) {
        if (states[i] !== "GOOD") { allGood = false; if (firstBad < 0) firstBad = i; }
      }
      assert(allGood, `leftWrist GOOD across entire downswing window [${topIdx}, ${impactIdx}]${allGood ? "" : ` — first non-GOOD at ${firstBad} (${states[firstBad]})`}`);
    }
  }

  // -------------------------------------------------------------------------
  // Test #2 — collapse swing: isolated teleports in f60+ get interpolated
  // -------------------------------------------------------------------------
  group("#2 collapse swing f72e056b");
  {
    const raw = await loadFrames(sb, COLLAPSE_ID);
    const { cleanedFrames, untrustedMap } = vetoAndInterpolateKeypoints(raw);

    const before = teleportSpikes(raw, 60);
    const after = teleportSpikes(cleanedFrames, 60);
    console.log(`  f60+ TELEPORT spikes — before=${before}, after=${after}`);
    console.log(`  veto stats: interpolated=${untrustedMap.stats.interpolated}, untrusted=${untrustedMap.stats.untrusted}, teleport=${untrustedMap.stats.teleport}, frameGlitches=${untrustedMap.frameGlitches.length}`);
    assert(before > 0, `f60+ zone has teleport spikes before the pass (got ${before})`);
    assert(after < before, `teleport spikes drop after the pass (${before} -> ${after})`);
    assert(untrustedMap.stats.interpolated > 0, `isolated/len-2 spikes interpolated (interpolated=${untrustedMap.stats.interpolated})`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
