/**
 * debugPhaseDetection.ts — run the face-on phase detector on a single
 * swing's motion_frames and print the interim swingStart / address /
 * takeaway / top / impact / finish indices that the temporal_inversion
 * gate would compare. Read-only: no DB writes.
 *
 * Usage:
 *   npx --yes tsx scripts/debugPhaseDetection.ts <swingId>
 *
 * Env: same as scripts/validate-phase-rules.ts — EXPO_PUBLIC_SUPABASE_URL
 * plus SUPABASE_SERVICE_ROLE_KEY or EXPO_PUBLIC_SUPABASE_ANON_KEY.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import type { SwingTrailPoint } from "../packages/domain/swing/phaseDetection";
import { toCanonicalSequence } from "../packages/domain/swing/canonicalTransform";
import { msPerFrameFromTrail } from "../packages/domain/swing/phaseDetectionShared";
import { detectFaceOnPhasesDebug } from "../packages/domain/swing/phaseDetectionFaceOn";

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
// Trail extraction (inlined from analysisPipeline.ts:118-139 to avoid a
// second cross-file modification).
// ---------------------------------------------------------------------------

function buildTrailPoints(sequence: PoseSequence): SwingTrailPoint[] {
  const points: SwingTrailPoint[] = [];
  for (const frame of sequence.frames) {
    const lw = frame.joints.leftWrist;
    const rw = frame.joints.rightWrist;
    if (!lw || !rw) continue;
    points.push({
      x: (lw.x + rw.x) / 2,
      y: (lw.y + rw.y) / 2,
      timestamp: frame.timestampMs,
      leadX: lw.x,
      leadY: lw.y,
      trailX: rw.x,
      trailY: rw.y,
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const swingId = args.find((a) => a && !a.startsWith("--"));
  const lhOverride = args.includes("--lh")
    ? true
    : args.includes("--rh")
      ? false
      : null;
  if (!swingId) {
    console.error("usage: npx tsx scripts/debugPhaseDetection.ts <swingId> [--lh|--rh]");
    process.exit(1);
  }

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error(
      "[debugPhaseDetection] Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/EXPO_PUBLIC_SUPABASE_ANON_KEY in .env",
    );
    process.exit(1);
  }

  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await sb
    .from("swings")
    .select("id, motion_frames, swing_debug")
    .eq("id", swingId)
    .maybeSingle();

  if (error) {
    console.error(`[debugPhaseDetection] supabase error: ${error.message}`);
    process.exit(1);
  }
  if (!data) {
    console.error(`[debugPhaseDetection] swing not found: ${swingId}`);
    process.exit(1);
  }
  const motionFrames = data.motion_frames as PoseFrame[] | null;
  if (!motionFrames || motionFrames.length === 0) {
    console.error(`[debugPhaseDetection] swing has no motion_frames: ${swingId}`);
    process.exit(1);
  }

  const sequence: PoseSequence = {
    frames: motionFrames,
    source: "debug",
    metadata: { fps: undefined, durationMs: undefined } as PoseSequence["metadata"],
  };

  // Default: match what production used (swing_debug.handedness). Override
  // with --lh or --rh to force.
  const prodHandedness = (data.swing_debug as { handedness?: string } | null)?.handedness;
  const prodIsLeftHanded = prodHandedness === "left";
  const isLeftHanded = lhOverride ?? prodIsLeftHanded;
  const canonical = toCanonicalSequence(sequence, isLeftHanded);

  if (!canonical.frames || canonical.frames.length === 0) {
    console.error(`[debugPhaseDetection] canonicalization produced 0 frames`);
    process.exit(1);
  }

  const trail = buildTrailPoints(canonical);
  const msPerFrame = msPerFrameFromTrail(trail);

  const r = detectFaceOnPhasesDebug({ canonical, trail, msPerFrame });

  const fmt = (n: number | null) => (n == null ? "null" : String(n));

  console.log(`swing:        ${swingId}`);
  console.log(`frames:       canonical=${canonical.frames.length}  trail=${trail.length}  msPerFrame=${msPerFrame.toFixed(2)}`);
  console.log(
    `isLeftHanded: ${isLeftHanded}  (prod handedness=${prodHandedness ?? "?"}${lhOverride != null ? ", overridden via CLI" : ""})`,
  );
  console.log("");
  console.log(`swingStart frame:    ${fmt(r.swingStartFrame)}`);
  console.log(`address frame:       ${fmt(r.addressIdx)}  (== takeaway gate; face-on does not detect true_address)`);
  console.log(`takeaway frame:      ${fmt(r.takeawayIdx)}`);
  console.log(`top frame:           ${fmt(r.topIdx)}`);
  console.log(`downswing frame:     ${fmt(r.downswingIdx)}`);
  console.log(`impact frame:        ${fmt(r.impactIdx)}`);
  console.log(`followThrough frame: ${fmt(r.finishFrame)}`);
  console.log("");
  console.log(`→ triggerA (address < top < impact): ${r.triggerA.condition}   fired=${r.triggerA.fired}`);
  console.log(
    `→ triggerB (strict monotonicity):    ${r.triggerB.fired ? `INVERTED at ${r.triggerB.offendingPair}` : "OK"}   fired=${r.triggerB.fired}`,
  );
  console.log(`→ would fallbackGate to:             ${r.wouldFallbackGate ?? "null (would succeed)"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
