/**
 * verifyTakeawayOnset.ts — read-only verification for the body-scaled,
 * reversal-rejecting takeaway gate (findTakeawayOnsetFaceOn). NO DB writes.
 *
 * Runs the EXACT shipped transform chain (analysisPipeline.ts:546-604):
 *   pose_full → rtmwToPoseFrame → correctLowerBodyIdentity
 *             → vetoAndInterpolateKeypoints → toCanonicalSequence(!isLeftHanded)
 *             → buildTrailPoints → findTakeawayOnsetFaceOn
 *
 * 1. BLOCKING real-data check on a target swing (default 6623e3e8): prints the
 *    onset converted to FRAME space. PASS = ~65 (not ~26/null).
 * 2. TRACE: per-frame travel-in-body-heights for frames 20–90 + lockedBodyHeight
 *    + onset, so the feint (<0.5 BH, turns back) and the real run (climbs past
 *    0.5) are both visible.
 * 3. CORPUS disagreement scan (NOT auto-pass/fail) over all face_on/front swings:
 *    (a) fires-vs-fallback tally + fallback-reason breakdown,
 *    (b) |bodyScaledOnset − findSetupEndIndex| per firing swing, sorted desc,
 *    (c) travel-BH and body-height distributions (does 0.5 cleanly separate?).
 *
 * Env/query pattern cloned from scripts/replayThumbImpact.ts.
 * Usage: npx --yes tsx scripts/verifyTakeawayOnset.ts [swingId8=6623e3e8]
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../lib/database.types";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import type { Rtmw133Frame } from "../packages/pose/rtmw/Rtmw133Frame";
import type { SwingTrailPoint } from "../packages/domain/swing/phaseDetection";
import { rtmwToPoseFrame } from "../packages/pose/rtmw/rtmwAdapter";
import { correctLowerBodyIdentity } from "../packages/domain/swing/lowerBodyIdentity";
import { vetoAndInterpolateKeypoints } from "../packages/domain/swing/keypointVeto";
import { toCanonicalSequence } from "../packages/domain/swing/canonicalTransform";
import {
  computeTrailVelocities,
  findSetupEndIndex,
  findTakeawayOnsetFaceOn,
  smoothVelocities,
} from "../packages/domain/swing/phaseDetectionShared";

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/replayThumbImpact.ts)
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  let text = "";
  try {
    text = readFileSync(join(REPO_ROOT, ".env"), "utf8");
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (env[k] === undefined) env[k] = v;
  }
  return env;
}

// Trail builder — identical to analysisPipeline.ts:136-157 (kept in sync;
// same convention as scripts/replayThumbImpact.ts).
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
      leadX: rw.x,   // canonical LEAD = right* (CANONICAL_LEAD); TRAIL = left*
      leadY: rw.y,
      trailX: lw.x,
      trailY: lw.y,
    });
  }
  return points;
}

// Replicates analyzePoseSequence's transform (analysisPipeline.ts:546-604).
function reconstruct(rtmw: Rtmw133Frame[], isLeftHanded: boolean) {
  const frames: PoseFrame[] = rtmw.map(rtmwToPoseFrame);
  const sequence: PoseSequence = { frames, source: "verify", metadata: {} };

  const identity = correctLowerBodyIdentity(sequence.frames);
  const identitySequence: PoseSequence =
    identity.swappedFrames.length > 0 ? { ...sequence, frames: identity.frames } : sequence;

  const veto = vetoAndInterpolateKeypoints(identitySequence.frames);
  const cleanedSequence: PoseSequence = { ...identitySequence, frames: veto.cleanedFrames };
  const canonical = toCanonicalSequence(cleanedSequence, !isLeftHanded);
  const trail = buildTrailPoints(canonical);
  return { canonical, trail };
}

const trailIdxToFrame = (
  trail: SwingTrailPoint[],
  frames: PoseFrame[],
  idx: number | null,
): number | null => {
  if (idx == null || idx < 0 || idx >= trail.length) return null;
  const f = frames.findIndex((fr) => fr.timestampMs === trail[idx].timestamp);
  return f === -1 ? null : f;
};

async function fetchPoseFull(
  sb: SupabaseClient<Database>,
  id: string,
): Promise<Rtmw133Frame[] | null> {
  const { data, error } = await sb.from("swings").select("pose_full").eq("id", id).maybeSingle();
  if (error) return null;
  return ((data as { pose_full?: Rtmw133Frame[] | null } | null)?.pose_full as
    | Rtmw133Frame[]
    | null) ?? null;
}

// Per-swing blocking onset expectations (FRAME space). Ranges, not exact
// equality — real pose-data onsets are brittle to 1-frame transform rounding,
// so a correct 43/72 must not false-FAIL. `reject` flags a specific wrong onset
// the new rule must NOT return (6623e3e8's pre-fix waggle latch at 26).
const EXPECTED_ONSET: Record<string, { lo: number; hi: number; reject?: number; note: string }> = {
  "6623e3e8": { lo: 55, hi: 75, reject: 26, note: "validated ~63" },
  "838c539e": { lo: 42, hi: 46, note: "validated 44" },
  "8d85c860": { lo: 70, hi: 76, note: "validated 73" },
};

async function main() {
  const targetId8 = (process.argv[2] ?? "6623e3e8").slice(0, 8);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("[verifyTakeawayOnset] Missing Supabase URL/key in .env");
    process.exit(1);
  }
  const sb = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: list, error: e1 } = await sb
    .from("swings")
    .select("id, created_at, swing_debug")
    .not("pose_full", "is", null)
    .order("created_at", { ascending: true });
  if (e1) {
    console.error("[verifyTakeawayOnset] supabase error:", e1.message);
    process.exit(1);
  }

  const handednessOf = (r: { swing_debug: unknown }): boolean =>
    (r.swing_debug as { handedness?: string } | null)?.handedness === "left";
  const cameraOf = (r: { swing_debug: unknown }): string | undefined =>
    (r.swing_debug as { camera_angle?: string } | null)?.camera_angle;

  const all = (list ?? []) as { id: string; swing_debug: unknown }[];
  const faceOn = all.filter((r) => {
    const cam = cameraOf(r);
    return cam === "face_on" || cam === "front";
  });

  // ---------------------------------------------------------------------------
  // 1 + 2 — BLOCKING real-data check + trace on the target swing.
  // ---------------------------------------------------------------------------
  const target = all.find((r) => r.id.slice(0, 8) === targetId8);
  console.log(`\n=== TARGET SWING ${targetId8} ===`);
  if (!target) {
    console.log(`  (not found among ${all.length} swings with pose_full)`);
  } else {
    const isLH = handednessOf(target);
    const rtmw = await fetchPoseFull(sb, target.id);
    if (!rtmw || rtmw.length === 0) {
      console.log("  pose_full empty");
    } else {
      const { canonical, trail } = reconstruct(rtmw, isLH);
      const frames = canonical.frames;
      const r = findTakeawayOnsetFaceOn(trail, frames);
      const fallbackIdx = findSetupEndIndex(smoothVelocities(computeTrailVelocities(trail), 5), trail);

      const onsetFrame = trailIdxToFrame(trail, frames, r.onsetTrailIdx);
      const candidateFrame = trailIdxToFrame(trail, frames, r.candidateTrailIdx);
      const fallbackFrame = trailIdxToFrame(trail, frames, fallbackIdx);

      console.log(`  handedness         : ${isLH ? "left" : "right"}`);
      console.log(`  trail length       : ${trail.length}  (frames ${frames.length})`);
      console.log(`  lockedBodyHeight   : ${r.lockedBodyHeight?.toFixed(4) ?? "null"}`);
      console.log(`  travelBH (max)     : ${r.travelBH?.toFixed(3) ?? "null"}`);
      console.log(`  fired              : ${r.fired}  reason=${r.fallbackReason ?? "—"}`);
      console.log(`  body-scaled onset  : trail ${r.onsetTrailIdx ?? "null"} → FRAME ${onsetFrame ?? "null"}`);
      console.log(`  body-scaled cand.  : trail ${r.candidateTrailIdx ?? "null"} → FRAME ${candidateFrame ?? "null"}`);
      console.log(`  legacy findSetupEnd: trail ${fallbackIdx} → FRAME ${fallbackFrame ?? "null"}`);

      const exp = EXPECTED_ONSET[targetId8];
      if (exp) {
        const pass =
          onsetFrame != null &&
          onsetFrame >= exp.lo &&
          onsetFrame <= exp.hi &&
          onsetFrame !== exp.reject;
        const rejectNote = exp.reject != null ? ` AND != ${exp.reject}` : "";
        console.log(
          `  >>> ${pass ? "PASS" : "FAIL"}: expect FRAME in [${exp.lo},${exp.hi}]${rejectNote} (${exp.note}). got ${onsetFrame ?? "null"}`,
        );
      } else {
        console.log(
          `  (no blocking range registered for ${targetId8}) got FRAME ${onsetFrame ?? "null"}`,
        );
      }

      // TRACE — per-frame travel-in-BH for frames 20–90.
      const bh = r.lockedBodyHeight ?? 1;
      const s = smoothVelocities(trail.map((p) => p.leadX), 5);
      let runMin = s[0];
      console.log(`\n  --- TRACE (frame : smoothed leadX : travel-in-BH) ---`);
      for (let i = 0; i < s.length; i++) {
        if (s[i] < runMin) runMin = s[i];
        const travelBH = (s[i] - runMin) / bh;
        const frameIdx = trailIdxToFrame(trail, frames, i);
        if (frameIdx != null && frameIdx >= 20 && frameIdx <= 90) {
          const bar = "#".repeat(Math.max(0, Math.round(travelBH * 20)));
          const mark = i === r.onsetTrailIdx ? "  <== ONSET" : travelBH >= 0.5 ? "  (>=0.5)" : "";
          console.log(
            `  f${String(frameIdx).padStart(3)} : ${s[i].toFixed(4)} : ${travelBH.toFixed(3)} ${bar}${mark}`,
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3 — CORPUS disagreement scan (read-only; operator eyeballs disagreements).
  // ---------------------------------------------------------------------------
  console.log(`\n\n=== CORPUS SCAN (${faceOn.length} face_on/front swings with pose_full) ===`);
  type Stat = {
    id8: string;
    fired: boolean;
    reason: string | null;
    onsetFrame: number | null;
    fallbackFrame: number | null;
    diffTrail: number | null;
    travelBH: number | null;
    bh: number | null;
  };
  const stats: Stat[] = [];

  for (const r of faceOn) {
    const isLH = handednessOf(r);
    const rtmw = await fetchPoseFull(sb, r.id);
    if (!rtmw || rtmw.length === 0) {
      stats.push({ id8: r.id.slice(0, 8), fired: false, reason: "pose_full_empty", onsetFrame: null, fallbackFrame: null, diffTrail: null, travelBH: null, bh: null });
      continue;
    }
    const { canonical, trail } = reconstruct(rtmw, isLH);
    const frames = canonical.frames;
    const res = findTakeawayOnsetFaceOn(trail, frames);
    const fallbackIdx = findSetupEndIndex(smoothVelocities(computeTrailVelocities(trail), 5), trail);
    stats.push({
      id8: r.id.slice(0, 8),
      fired: res.fired,
      reason: res.fallbackReason,
      onsetFrame: trailIdxToFrame(trail, frames, res.onsetTrailIdx),
      fallbackFrame: trailIdxToFrame(trail, frames, fallbackIdx),
      diffTrail: res.onsetTrailIdx != null ? Math.abs(res.onsetTrailIdx - fallbackIdx) : null,
      travelBH: res.travelBH,
      bh: res.lockedBodyHeight,
    });
  }

  // (a) fires-vs-fallback tally + fallback-reason breakdown
  const fired = stats.filter((s) => s.fired);
  const fellBack = stats.filter((s) => !s.fired);
  console.log(`\n(a) fired (body-scaled): ${fired.length} / ${stats.length}; fell back: ${fellBack.length}`);
  const reasonCounts = new Map<string, number>();
  for (const s of fellBack) reasonCounts.set(s.reason ?? "unknown", (reasonCounts.get(s.reason ?? "unknown") ?? 0) + 1);
  for (const [reason, n] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    fallback ${reason.padEnd(20)} : ${n}`);
  }

  // (b) |onset − findSetupEndIndex| per firing swing, sorted descending
  console.log(`\n(b) firing swings — |bodyScaledOnset − findSetupEndIndex| (trail space), desc:`);
  console.log(`    ${"id".padEnd(9)}| ${"onsetF".padStart(7)} | ${"fallbF".padStart(7)} | ${"|Δtrail|".padStart(8)} | ${"travelBH".padStart(8)}`);
  for (const s of [...fired].sort((a, b) => (b.diffTrail ?? 0) - (a.diffTrail ?? 0))) {
    console.log(
      `    ${s.id8.padEnd(9)}| ${String(s.onsetFrame ?? "–").padStart(7)} | ${String(s.fallbackFrame ?? "–").padStart(7)} | ${String(s.diffTrail ?? "–").padStart(8)} | ${(s.travelBH?.toFixed(2) ?? "–").padStart(8)}`,
    );
  }

  // (c) travel-BH + body-height distributions (does 0.5 cleanly separate?)
  const hist = (vals: number[], lo: number, hi: number, bins: number, label: string) => {
    console.log(`\n(c) ${label} (n=${vals.length}):`);
    if (vals.length === 0) return;
    const width = (hi - lo) / bins;
    const counts = new Array(bins).fill(0);
    let under = 0;
    let over = 0;
    for (const v of vals) {
      if (v < lo) under++;
      else if (v >= hi) over++;
      else counts[Math.min(bins - 1, Math.floor((v - lo) / width))]++;
    }
    if (under) console.log(`    < ${lo.toFixed(2)}        : ${"*".repeat(under)} (${under})`);
    for (let b = 0; b < bins; b++) {
      const a = (lo + b * width).toFixed(2);
      console.log(`    [${a}, ${(lo + (b + 1) * width).toFixed(2)}) : ${"*".repeat(counts[b])} (${counts[b]})`);
    }
    if (over) console.log(`    >= ${hi.toFixed(2)}       : ${"*".repeat(over)} (${over})`);
  };
  hist(
    stats.map((s) => s.travelBH).filter((v): v is number => v != null),
    0, 2, 20, "travel-BH distribution (0.5 = fire threshold)",
  );
  hist(
    stats.map((s) => s.bh).filter((v): v is number => v != null),
    0, 1, 20, "lockedBodyHeight distribution (normalized)",
  );

  console.log("\n(Disagreements are NOT auto-failures — eyeball flagged swings to sort fixes from regressions.)\n");
}

main().catch((e) => {
  console.error("[verifyTakeawayOnset] fatal:", e);
  process.exit(1);
});
