/**
 * replayCorpusDigest.ts — Phase-2 gate tool for the pose-rate-independence
 * migration. Replays every stored `motion_frames` swing through the REAL
 * analysis pipeline (`analyzePoseSequence`) + `classifyCapture` and produces a
 * compact per-swing digest of everything the 1b/1c/1d threshold conversions
 * could move: phase indices, phase_rules provenance, tempo, score, and capture
 * classification.
 *
 * Two modes:
 *   write <file>   — compute the digest and write it to <file> (the baseline).
 *   check <file>   — recompute and DIFF against <file>; prints every changed
 *                    field and exits 1 if ANY swing differs (the 1b ZERO-DIFF gate).
 *
 * Usage:
 *   npx --yes tsx scripts/replayCorpusDigest.ts write /tmp/base.json
 *   npx --yes tsx scripts/replayCorpusDigest.ts check /tmp/base.json
 *
 * Env: same as scripts/validate-phase-rules.ts — EXPO_PUBLIC_SUPABASE_URL plus
 * SUPABASE_SERVICE_ROLE_KEY or EXPO_PUBLIC_SUPABASE_ANON_KEY (.env auto-loaded).
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import { analyzePoseSequence } from "../packages/domain/swing/analysisPipeline";
import { classifyCapture } from "../packages/domain/swing/captureValidity";

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
// Digest
// ---------------------------------------------------------------------------

type SwingDigest = Record<string, unknown>;

function digestForSwing(frames: PoseFrame[], isLeftHanded: boolean): SwingDigest {
  const sequence: PoseSequence = {
    frames,
    source: "replay",
    metadata: { fps: undefined, durationMs: undefined },
  };
  const r = analyzePoseSequence(sequence, isLeftHanded);
  const dbg = r.swing_debug;
  const pr = dbg?.phase_rules;
  const phaseIdx: Record<string, number | null> = {
    takeaway: null, top: null, downswing: null, impact: null, follow_through: null,
  };
  for (const p of r.phases ?? []) phaseIdx[p.phase] = p.index;

  const cap = classifyCapture(frames);

  return {
    detector: pr?.detector ?? null,
    fallback_gate: dbg?.fallback_gate ?? null,
    phases: phaseIdx,
    swing_start_frame: pr?.swing_start_frame ?? null,
    true_address_frame: pr?.true_address_frame ?? null,
    reliability: pr?.reliability ?? null,
    impact_source: pr?.impact_source ?? null,
    impact_consensus_final: pr?.impact_consensus_final ?? null,
    impact_arcbottom: pr?.impact_arcbottom ?? null,
    impact_delta: pr?.impact_delta ?? null,
    impact_cross_check_mismatch: pr?.impact_cross_check_mismatch ?? null,
    impact_fallback_reason: pr?.impact_fallback_reason ?? null,
    top_x_extreme_frame: pr?.top_x_extreme?.frame ?? null,
    top_velmin_shadow: pr?.top_velmin_shadow ?? null,
    takeaway_path: pr?.takeaway_path ?? null,
    takeaway_body_scaled_frame: pr?.takeaway_body_scaled_frame ?? null,
    takeaway_fallback_idx: pr?.takeaway_fallback_idx ?? null,
    tempo: r.tempo
      ? {
          backswingMs: r.tempo.backswingMs,
          downswingMs: r.tempo.downswingMs,
          tempoRatio: r.tempo.tempoRatio,
          tempoRating: r.tempo.tempoRating,
        }
      : null,
    score: r.score,
    capture: { validity: cap.validity, frameCount: cap.frameCount, goodFrameCount: cap.goodFrameCount },
  };
}

// Deterministic key order for stable JSON. Recurse objects; arrays as-is.
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function computeAll(): Promise<Record<string, SwingDigest>> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("[replayCorpusDigest] missing Supabase env (URL + SERVICE_ROLE/ANON key) in .env");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Chunked fetch + per-chunk retry (promoted from the .tmp paged fork,
  // Batch 7 / T9-71 partial): the original monolithic 72-row motion_frames
  // select 522'd at Cloudflare on this corpus, so chunking IS the fetch now.
  // Digest logic below is unchanged from the original tool.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const ids: string[] = [];
  for (let attempt = 1; ; attempt++) {
    const { data: idRows, error: idErr } = await sb
      .from("swings")
      .select("id")
      .not("motion_frames", "is", null)
      .order("id", { ascending: true });
    if (!idErr) { for (const r of idRows ?? []) ids.push(String(r.id)); break; }
    if (attempt >= 5) { console.error(`[paged] id fetch failed: ${idErr.message}`); process.exit(1); }
    await sleep(4000 * attempt);
  }
  const data: { id: string; motion_frames: unknown; swing_debug: unknown }[] = [];
  const CHUNK = 6;
  for (let o = 0; o < ids.length; o += CHUNK) {
    const slice = ids.slice(o, o + CHUNK);
    for (let attempt = 1; ; attempt++) {
      const { data: rows, error: rowErr } = await sb
        .from("swings")
        .select("id, motion_frames, swing_debug")
        .in("id", slice)
        .order("id", { ascending: true });
      if (!rowErr) { data.push(...((rows ?? []) as typeof data)); break; }
      if (attempt >= 5) { console.error(`[paged] chunk at ${o} failed: ${rowErr.message}`); process.exit(1); }
      await sleep(4000 * attempt);
    }
    console.error(`[paged] fetched ${data.length}/${ids.length}`);
  }

  const out: Record<string, SwingDigest> = {};
  let n = 0;
  for (const row of data ?? []) {
    const frames = row.motion_frames as PoseFrame[] | null;
    if (!Array.isArray(frames) || frames.length === 0) continue;
    const handed = (row.swing_debug as { handedness?: string } | null)?.handedness;
    const isLeftHanded = handed === "left";
    const shortId = String(row.id).slice(0, 8);
    try {
      out[shortId] = sortDeep(digestForSwing(frames, isLeftHanded)) as SwingDigest;
    } catch (e) {
      out[shortId] = { __error: (e as Error).message };
    }
    n++;
  }
  console.error(`[replayCorpusDigest] computed digest for ${n} swings`);
  return out;
}

function diff(base: Record<string, SwingDigest>, cur: Record<string, SwingDigest>): number {
  let changes = 0;
  const ids = Array.from(new Set([...Object.keys(base), ...Object.keys(cur)])).sort();
  for (const id of ids) {
    const b = JSON.stringify(base[id] ?? null);
    const c = JSON.stringify(cur[id] ?? null);
    if (b !== c) {
      changes++;
      console.log(`\n✗ ${id} DIFFERS`);
      console.log(`  base: ${b}`);
      console.log(`  cur:  ${c}`);
    }
  }
  return changes;
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if ((mode !== "write" && mode !== "check") || !file) {
    console.error("usage: replayCorpusDigest.ts <write|check> <file>");
    process.exit(2);
  }
  const cur = await computeAll();

  if (mode === "write") {
    writeFileSync(file, JSON.stringify(cur, null, 2));
    console.log(`✓ baseline written: ${file} (${Object.keys(cur).length} swings)`);
    return;
  }

  const base = JSON.parse(readFileSync(file, "utf8")) as Record<string, SwingDigest>;
  const changes = diff(base, cur);
  console.log(`\n${"═".repeat(56)}`);
  if (changes === 0) {
    console.log(`  ✓ ZERO DIFFS across ${Object.keys(cur).length} swings`);
    console.log(`${"═".repeat(56)}`);
    return;
  }
  console.log(`  ✗ ${changes} swing(s) changed — 1b gate FAILED`);
  console.log(`${"═".repeat(56)}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
