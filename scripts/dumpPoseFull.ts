/**
 * dumpPoseFull.ts — Export ONE swing's data as a self-describing JSON for the
 * standalone swing-inspector.html tool.
 *
 * FAITHFULNESS CONTRACT (read before editing):
 *   Every app-meaningful number this file emits must trace to the app's REAL
 *   code — either read straight from a persisted Supabase column (the value the
 *   app actually shipped for that swing) or produced by calling the app's own
 *   functions. NOTHING here reimplements app math. The companion HTML is a dumb
 *   plotter; it computes only two TOOL-ONLY series the app has no function for
 *   (pixel velocity, inter-keypoint distance) and badges them as such.
 *
 *   - pose_full / motion_frames / phases / trail_points / angles / tempo /
 *     score / swing_debug / … : read verbatim from the `swings` row. These ARE
 *     the app's outputs (motion_frames already carries app vx/vy/vz from
 *     lib/persistSwing.ts enrichFramesWithVelocity).
 *   - perFrameAngles : the ONE app series not persisted. Built by calling the
 *     real rtmwToPoseFrame() then calculateGolfAngles() per frame — same code
 *     the analysis pipeline uses. (spineDrift is always null per-frame: it is a
 *     cross-frame address→top value the single-frame fn does not compute.)
 *
 * Usage:
 *   npx --yes tsx scripts/dumpPoseFull.ts [swingId]
 *
 * Defaults to the same demo swing as scripts/hand-keypoint-chart.ts.
 * Read-only on the DB (single SELECT). Output:
 *   scripts/output/pose-full-<id8>.json
 *
 * Env loader cloned from scripts/hand-keypoint-chart.ts.
 */

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rtmwToPoseFrame } from "../packages/pose/rtmw/rtmwAdapter";
import type { Rtmw133Frame } from "../packages/pose/rtmw/Rtmw133Frame";
import { calculateGolfAngles, type GolfAngles } from "../packages/domain/swing/angles";

const DEFAULT_SWING_ID = "c876728a-fa0d-4455-836e-09600deb23c8";

// The 8 angle keys calculateGolfAngles returns, in stable display order.
const ANGLE_KEYS: (keyof GolfAngles)[] = [
  "spineAngle",
  "leftElbowAngle",
  "rightElbowAngle",
  "leftKneeAngle",
  "rightKneeAngle",
  "hipSpreadDelta",
  "shoulderTilt",
  "spineDrift", // always null per-frame; emitted for completeness
];

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/hand-keypoint-chart.ts)
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
// Types for the persisted columns we read (loose: DB columns are Json).
// ---------------------------------------------------------------------------

type SwingRow = {
  id: string;
  created_at: string | null;
  app_version: string | null;
  analysis_version: string | null;
  pose_full: Rtmw133Frame[] | null;
  motion_frames: unknown;
  phases: unknown;
  trail_points: unknown;
  angles: unknown;
  tempo: unknown;
  score: number | null;
  honey_boom: boolean | null;
  camera_angle_valid: boolean | null;
  metric_confidences: unknown;
  category_scores: unknown;
  phase_source: string | null;
  backswing_ms: number | null;
  downswing_ms: number | null;
  tempo_ratio: number | null;
  frame_count: number | null;
  duration_ms: number | null;
  fps_actual: number | null;
  swing_debug: { camera_angle?: unknown; handedness?: unknown } | null;
};

const SELECT_COLUMNS = [
  "id", "created_at", "app_version", "analysis_version",
  "pose_full", "motion_frames", "phases", "trail_points",
  "angles", "tempo", "score", "honey_boom", "camera_angle_valid",
  "metric_confidences", "category_scores", "phase_source",
  "backswing_ms", "downswing_ms", "tempo_ratio",
  "frame_count", "duration_ms", "fps_actual", "swing_debug",
].join(", ");

// ---------------------------------------------------------------------------
// Per-frame angle curves via the REAL app functions (the only computed series).
// ---------------------------------------------------------------------------

function buildPerFrameAngles(frames: Rtmw133Frame[]): Record<string, (number | null)[]> {
  const out: Record<string, (number | null)[]> = {};
  for (const key of ANGLE_KEYS) out[key] = [];
  for (const f of frames) {
    const angles = calculateGolfAngles(rtmwToPoseFrame(f)); // app code, not reimplemented
    for (const key of ANGLE_KEYS) {
      const v = angles[key];
      out[key].push(typeof v === "number" && Number.isFinite(v) ? v : null);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const arg = process.argv.slice(2)[0];
  const swingId = arg && arg.trim() ? arg.trim() : DEFAULT_SWING_ID;

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("[dumpPoseFull] Missing EXPO_PUBLIC_SUPABASE_URL or key in .env");
    process.exit(1);
  }
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await sb
    .from("swings")
    .select(SELECT_COLUMNS)
    .eq("id", swingId)
    .maybeSingle();
  if (error) { console.error("[dumpPoseFull] Supabase error:", error.message); process.exit(1); }

  const row = data as unknown as SwingRow | null;
  if (!row) { console.error("[dumpPoseFull] no swing row for " + swingId); process.exit(1); }

  const poseFull = row.pose_full;
  if (!Array.isArray(poseFull) || poseFull.length === 0) {
    console.error("[dumpPoseFull] pose_full empty for " + swingId +
      " (pre-RTMW swing, or fire-and-forget pose_full write failed). Cannot build inspector JSON.");
    process.exit(1);
  }

  const perFrameAngles = buildPerFrameAngles(poseFull);

  const cameraAngle = row.swing_debug?.camera_angle ?? null;
  const handedness = row.swing_debug?.handedness ?? null;

  const wrapper = {
    // provenance
    source: "dumpPoseFull",
    swingId: row.id,
    createdAt: row.created_at,
    appVersion: row.app_version,
    analysisVersion: row.analysis_version,
    // raw 133-kp model output (PIXELS) — app's persisted pose_full
    pose_full: poseFull,
    // 39 named joints, NORMALIZED, with app-computed vx/vy/vz
    motion_frames: row.motion_frames ?? null,
    // APP per-frame angle curves (via rtmwToPoseFrame -> calculateGolfAngles)
    perFrameAngles,
    // APP per-frame wrist series
    trail_points: row.trail_points ?? null,
    // APP phase anchors (index + timestamp + phase)
    phases: row.phases ?? null,
    // APP swing-level scalars
    summary: {
      score: row.score,
      honeyBoom: row.honey_boom,
      cameraAngleValid: row.camera_angle_valid,
      angles: row.angles ?? null,
      tempo: row.tempo ?? null,
      tempoRatio: row.tempo_ratio,
      backswingMs: row.backswing_ms,
      downswingMs: row.downswing_ms,
      metricConfidences: row.metric_confidences ?? null,
      categoryScores: row.category_scores ?? null,
      phaseSource: row.phase_source,
      frameCount: row.frame_count,
      durationMs: row.duration_ms,
      fpsActual: row.fps_actual,
      handedness,
      cameraAngle,
    },
    // APP debug blob (shown raw/collapsible by the inspector)
    swing_debug: row.swing_debug ?? null,
  };

  const outDir = join(REPO_ROOT, "scripts", "output");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "pose-full-" + swingId.slice(0, 8) + ".json");
  writeFileSync(outPath, JSON.stringify(wrapper, null, 2));

  const angleFrames = perFrameAngles.spineAngle?.length ?? 0;
  console.log("[dumpPoseFull] swing " + swingId);
  console.log("[dumpPoseFull]   pose_full frames : " + poseFull.length);
  console.log("[dumpPoseFull]   perFrameAngles   : " + angleFrames + " frames × " + ANGLE_KEYS.length + " angles");
  console.log("[dumpPoseFull]   score / tempoRatio: " + row.score + " / " + row.tempo_ratio);
  console.log("[dumpPoseFull]   camera / handed  : " + JSON.stringify(cameraAngle) + " / " + JSON.stringify(handedness));
  console.log("[dumpPoseFull] wrote " + outPath);
}

main();
