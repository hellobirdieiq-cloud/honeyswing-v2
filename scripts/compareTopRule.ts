/**
 * compareTopRule.ts — Phase 2 shadow validation for the X-extreme top rule.
 *
 * For each swing, re-runs the REAL pipeline (analyzePoseSequence handles its own
 * veto + canonical internally) and prints the LIVE top (detectFaceOnTop, via
 * phases[].top) beside the SHADOW X-extreme top (detectFaceOnTopXExtreme, via
 * swing_debug.phase_rules.top_x_extreme), against hand-verified ground truth.
 *
 * Unlike diagnoseSwingPhases.ts (which hardcodes isLeftHanded=false), this reads
 * each swing's REAL handedness from swing_debug so LH swings canonicalize
 * correctly — required because the X-extreme rule relies on canonical lead = right*.
 *
 * Read-only: no DB writes, no detector edits.
 *
 * Usage:
 *   npx --yes tsx scripts/compareTopRule.ts 16c98eeb=85 d5084eb5=98 e212431b=108 3a814184=88-98
 *   npx --yes tsx scripts/compareTopRule.ts            # defaults to the 4 above
 *
 * Each arg is <idPrefix>=<truth>, where <truth> is a frame (85) or a range (88-98).
 *
 * Env: EXPO_PUBLIC_SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY or
 * EXPO_PUBLIC_SUPABASE_ANON_KEY (read from .env at repo root; same loader as
 * scripts/diagnoseSwingPhases.ts).
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import { analyzePoseSequence } from "../packages/domain/swing/analysisPipeline";

const DEFAULT_ARGS = ["16c98eeb=85", "d5084eb5=98", "e212431b=108", "3a814184=88-98"];

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/diagnoseSwingPhases.ts)
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

type Truth = { lo: number; hi: number; label: string };

function parseTruth(raw: string): Truth {
  if (raw.includes("-")) {
    const [a, b] = raw.split("-").map((s) => parseInt(s, 10));
    return { lo: Math.min(a, b), hi: Math.max(a, b), label: `${a}-${b}` };
  }
  const n = parseInt(raw, 10);
  return { lo: n, hi: n, label: String(n) };
}

// Signed-ish distance to the truth: 0 inside a range, else distance to nearest end.
function delta(frame: number | null, t: Truth): string {
  if (frame == null) return "—";
  if (frame >= t.lo && frame <= t.hi) return "0";
  const d = frame < t.lo ? frame - t.lo : frame - t.hi; // negative = early, positive = late
  return d > 0 ? `+${d}` : `${d}`;
}

interface SwingRow {
  id: string;
  motion_frames: PoseFrame[] | null;
  swing_debug: Record<string, unknown> | null;
}

async function main() {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error(
      "[compareTopRule] Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/EXPO_PUBLIC_SUPABASE_ANON_KEY in .env",
    );
    process.exit(1);
  }

  const args = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ARGS;
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Resolve 8-char prefixes → full uuids client-side (ilike can't apply to a uuid
  // column). Fetching just the id column is tiny even for the full table.
  const { data: idRows, error: idErr } = await sb.from("swings").select("id");
  if (idErr) {
    console.error("[compareTopRule] id list query error:", idErr.message);
    process.exit(1);
  }
  const allIds = (idRows ?? []).map((r) => (r as { id: string }).id);
  const resolveId = (prefix: string): string | null =>
    prefix.length === 36 ? prefix : (allIds.find((id) => id.startsWith(prefix)) ?? null);

  console.log("");
  console.log(
    "swing      hand  truth    live  Δlive   newX  Δnew   mean    spread  nose/sh/ear         window      rel",
  );
  console.log(
    "─────────  ────  ───────  ────  ─────   ────  ────   ──────  ──────  ──────────────────  ──────────  ──────",
  );

  for (const arg of args) {
    const [prefix, truthRaw] = arg.split("=");
    if (!prefix || !truthRaw) {
      console.log(`${arg}  — malformed arg (expected <idPrefix>=<truth>)`);
      continue;
    }
    const truth = parseTruth(truthRaw);

    const fullId = resolveId(prefix);
    if (!fullId) {
      console.log(`${prefix}  — no swing id matches prefix`);
      continue;
    }
    const { data, error } = await sb
      .from("swings")
      .select("id, motion_frames, swing_debug")
      .eq("id", fullId)
      .maybeSingle();
    if (error) {
      console.log(`${prefix}  — query error: ${error.message}`);
      continue;
    }
    if (!data) {
      console.log(`${prefix}  — no swing found`);
      continue;
    }
    const row = data as unknown as SwingRow;
    const rawFrames = row.motion_frames;
    if (!rawFrames || !Array.isArray(rawFrames) || rawFrames.length === 0) {
      console.log(`${prefix}  — motion_frames empty`);
      continue;
    }

    const handedness = String(row.swing_debug?.handedness ?? "right");
    const isLeftHanded = handedness === "left";

    const sequence: PoseSequence = {
      frames: rawFrames,
      source: "rtmw-l-2d-v1",
      metadata: {},
    };
    const result = analyzePoseSequence(sequence, isLeftHanded);

    const liveTop = result.phases?.find((p) => p.phase === "top")?.index ?? null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const phaseRules = (result.swing_debug as any)?.phase_rules ?? null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = (phaseRules?.top_x_extreme ?? null) as any;
    const newTop: number | null = tx?.frame ?? null;
    const mean: number | null = tx?.mean ?? null;
    const spread: number | null = tx?.spread ?? null;
    const pl = tx?.perLandmark ?? {};
    const win = tx?.window ?? null;
    const rel: string = tx?.reliability ?? "—";

    const idCol = row.id.slice(0, 8).padEnd(9);
    const handCol = (isLeftHanded ? "L" : "R").padEnd(4);
    const truthCol = truth.label.padEnd(7);
    const liveCol = String(liveTop ?? "—").padEnd(4);
    const dLive = delta(liveTop, truth).padEnd(5);
    const newCol = String(newTop ?? "—").padEnd(4);
    const dNew = delta(newTop, truth).padEnd(4);
    const medCol = String(mean ?? "—").padEnd(6);
    const sprCol = String(spread ?? "—").padEnd(6);
    const plCol = `${pl.nose ?? "—"}/${pl.leadShoulder ?? "—"}/${pl.leadEar ?? "—"}`.padEnd(18);
    const winCol = (win ? `[${win.from},${win.to}]` : "—").padEnd(10);

    console.log(
      `${idCol}  ${handCol}  ${truthCol}  ${liveCol}  ${dLive}   ${newCol}  ${dNew}   ${medCol}  ${sprCol}  ${plCol}  ${winCol}  ${rel}`,
    );
  }
  console.log("");
  console.log("Δ = frame − truth (0 = on/in-range; − early, + late). nose/sh/ear = per-landmark MAX-x picks.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
