/**
 * replayThumbImpact.ts — D7 verification replay (read-only, NO DB writes).
 *
 * Runs the EXACT shipped transform chain over every face_on/front swing that has
 * pose_full, then reports impact + finish (old vs new) and the cross-check fields:
 *
 *   pose_full → rtmwToPoseFrame → correctLowerBodyIdentity → vetoAndInterpolateKeypoints
 *             → canonical (mirror) + preCanonical (unmirrored) → detectFaceOnPhases
 *
 * Per-swing output:
 *   { swing_id, handedness, impact_old, impact_new, impact_source, impact_thumb,
 *     impact_arcbottom, impact_delta, mismatch_flag, finish_old, finish_new,
 *     fallback_reason|null, gate|null, coverage }
 *
 * Asserts (see ASSERTIONS at the end):
 *   - 81f0b197 impact_new ≈ 137.5 (vs ground truth 137.6)
 *   - LH swings → consensus (gate flipped; bounded arc_bottom fallback when consensus null)
 *   - mismatch flag on a761da0e + 4b47009e
 *   - 8d85c860 stays thumb-primary at coverage ≥ 0.5; 7692a2b8 coverage reported
 *   - no swing that had a stored impact is newly gated
 *
 * Env/query pattern cloned from scripts/output/_thumbCrossing.mjs and
 * scripts/debugPhaseDetection.ts. Usage: npx --yes tsx scripts/replayThumbImpact.ts
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import type { Rtmw133Frame } from "../packages/pose/rtmw/Rtmw133Frame";
import type { SwingTrailPoint, DetectedPhase } from "../packages/domain/swing/phaseDetection";
import { rtmwToPoseFrame } from "../packages/pose/rtmw/rtmwAdapter";
import { correctLowerBodyIdentity } from "../packages/domain/swing/lowerBodyIdentity";
import { vetoAndInterpolateKeypoints } from "../packages/domain/swing/keypointVeto";
import { toCanonicalSequence } from "../packages/domain/swing/canonicalTransform";
import { msPerFrameFromTrail } from "../packages/domain/swing/phaseDetectionShared";
import {
  detectFaceOnPhases,
  detectFaceOnThumbCrossing,
} from "../packages/domain/swing/phaseDetectionFaceOn";

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/debugPhaseDetection.ts)
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

// Trail builder — identical to analysisPipeline.ts:136-157 (kept in sync).
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

function phaseIdx(phases: unknown, name: string): number | null {
  if (!Array.isArray(phases)) return null;
  const p = (phases as DetectedPhase[]).find(
    (x) => x && x.phase === name && typeof x.index === "number",
  );
  return p ? p.index : null;
}

// Replicates analyzePoseSequence's transform (analysisPipeline.ts:546-604) but forces
// the face-on detector so every swing exercises the thumb path.
function runProductionFaceOn(rtmw: Rtmw133Frame[], isLeftHanded: boolean) {
  const frames: PoseFrame[] = rtmw.map(rtmwToPoseFrame);
  const sequence: PoseSequence = { frames, source: "replay", metadata: {} };

  const identity = correctLowerBodyIdentity(sequence.frames);
  const identitySequence: PoseSequence =
    identity.swappedFrames.length > 0 ? { ...sequence, frames: identity.frames } : sequence;

  const veto = vetoAndInterpolateKeypoints(identitySequence.frames);
  const cleanedSequence: PoseSequence = { ...identitySequence, frames: veto.cleanedFrames };
  const canonical = toCanonicalSequence(cleanedSequence, !isLeftHanded);
  const preCanonical = cleanedSequence;

  const trail = buildTrailPoints(canonical);
  const msPerFrame = msPerFrameFromTrail(trail);

  const detected = detectFaceOnPhases({ canonical, trail, msPerFrame, preCanonical, isLeftHanded });

  // Standalone coverage probe (diagnostic only): re-derive the thumb-window coverage
  // for swings that reach a [top, follow_through] window, so 8d85c860/7692a2b8 can be
  // reported even when the swing later gates.
  return { detected, preCanonical, canonical, trail, msPerFrame };
}

type Row = {
  swing_id: string;
  handedness: string | null;
  impact_old: number | null;
  impact_new: number | null;
  impact_source: string | null;
  impact_thumb: number | null;
  impact_arcbottom: number | null;
  impact_delta: number | null;
  mismatch_flag: boolean | null;
  finish_old: number | null;
  finish_new: number | null;
  fallback_reason: string | null;
  gate: string | null;
  coverage: number | null;
};

async function main() {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("[replayThumbImpact] Missing Supabase URL/key in .env");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: list, error: e1 } = await sb
    .from("swings")
    .select("id, created_at, phases, swing_debug")
    .not("pose_full", "is", null)
    .order("created_at", { ascending: true });
  if (e1) {
    console.error("[replayThumbImpact] supabase error:", e1.message);
    process.exit(1);
  }
  const faceOn = (list ?? []).filter((r) => {
    const cam = (r.swing_debug as { camera_angle?: string } | null)?.camera_angle;
    return cam === "face_on" || cam === "front";
  });

  const GROUND_TRUTH: Record<string, number> = { "81f0b197": 137.6, dec6edd1: 120 };
  const rows: Row[] = [];

  for (const r of faceOn) {
    const { data: pf, error: e2 } = await sb
      .from("swings")
      .select("pose_full")
      .eq("id", r.id)
      .maybeSingle();
    const rtmw = (pf?.pose_full as Rtmw133Frame[] | null) ?? null;
    const handedness = (r.swing_debug as { handedness?: string } | null)?.handedness ?? null;
    const isLeftHanded = handedness === "left";
    const impactOld = phaseIdx(r.phases, "impact");
    const finishOld = phaseIdx(r.phases, "follow_through");

    if (e2 || !rtmw || rtmw.length === 0) {
      rows.push({
        swing_id: r.id, handedness, impact_old: impactOld, impact_new: null,
        impact_source: null, impact_thumb: null, impact_arcbottom: null, impact_delta: null,
        mismatch_flag: null, finish_old: finishOld, finish_new: null,
        fallback_reason: null, gate: "pose_full_empty", coverage: null,
      });
      continue;
    }

    const { detected, preCanonical, trail } = runProductionFaceOn(rtmw, isLeftHanded);
    const rd = detected.ruleDebug;
    const impactNew = phaseIdx(detected.phases, "impact");
    const finishNew = phaseIdx(detected.phases, "follow_through");

    // Diagnostic coverage: if we have a top+follow_through window, probe coverage directly.
    let coverage: number | null = null;
    const topIdx = phaseIdx(detected.phases, "top");
    const ftIdx = finishNew;
    if (!isLeftHanded && topIdx != null && ftIdx != null) {
      coverage = detectFaceOnThumbCrossing(preCanonical.frames, topIdx, ftIdx, false).coverage;
    } else if (rd.impact_arcbottom != null) {
      // window came from the gate-internal finish; recompute against arcbottom-derived top is
      // not available here — leave null unless a phase window exists.
      coverage = null;
    }
    void trail;

    rows.push({
      swing_id: r.id,
      handedness,
      impact_old: impactOld,
      impact_new: impactNew,
      impact_source: rd.impact_source ?? null,
      impact_thumb: rd.impact_thumb ?? null,
      impact_arcbottom: rd.impact_arcbottom ?? null,
      impact_delta: rd.impact_delta ?? null,
      mismatch_flag: rd.impact_cross_check_mismatch ?? null,
      finish_old: finishOld,
      finish_new: finishNew,
      fallback_reason: rd.impact_fallback_reason ?? null,
      gate: detected.fallbackGate,
      coverage,
    });
  }

  // ---- table ----
  const p = (s: unknown, n: number) => String(s ?? "–").padEnd(n);
  const pl = (s: unknown, n: number) => String(s ?? "–").padStart(n);
  console.log(`\nface_on/front swings with pose_full: ${faceOn.length}\n`);
  console.log(
    `${p("id", 9)}| ${p("hand", 5)}| ${pl("imp_old", 7)} | ${pl("imp_new", 7)} | ${p("source", 13)}| ${pl("thumb", 7)} | ${pl("arcbot", 6)} | ${pl("delta", 6)} | ${p("mism", 5)}| ${pl("fin_old", 7)} | ${pl("fin_new", 7)} | ${p("fallback", 15)}| ${p("gate", 18)}| ${pl("cov", 4)}`,
  );
  console.log("-".repeat(170));
  for (const x of rows) {
    console.log(
      `${p(x.swing_id.slice(0, 8), 9)}| ${p(x.handedness, 5)}| ${pl(x.impact_old, 7)} | ${pl(x.impact_new, 7)} | ${p(x.impact_source, 13)}| ${pl(x.impact_thumb, 7)} | ${pl(x.impact_arcbottom, 6)} | ${pl(x.impact_delta, 6)} | ${p(x.mismatch_flag, 5)}| ${pl(x.finish_old, 7)} | ${pl(x.finish_new, 7)} | ${p(x.fallback_reason, 15)}| ${p(x.gate, 18)}| ${pl(x.coverage != null ? x.coverage.toFixed(2) : null, 4)}`,
    );
  }

  // ---- assertions ----
  console.log("\n=== ASSERTIONS ===");
  let pass = 0;
  let fail = 0;
  const find = (id8: string) => rows.find((x) => x.swing_id.slice(0, 8) === id8);
  const assert = (label: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    ok ? pass++ : fail++;
  };

  // (1) 81f0b197 ≈ 137.5 via thumb
  const ref = find("81f0b197");
  if (ref) {
    const gt = GROUND_TRUTH["81f0b197"];
    assert(
      "81f0b197 impact_new ≈ 137.5 via thumb_crossing",
      ref.impact_source === "thumb_crossing" && ref.impact_new != null && Math.abs(ref.impact_new - gt) <= 1.0,
      `impact_new=${ref.impact_new} thumb=${ref.impact_thumb} source=${ref.impact_source} (gt=${gt})`,
    );
  } else assert("81f0b197 present", false);

  // (1b) dec6edd1 = 120 via the low-y-gated FIRST crossing (was 117 arc_bottom under the LAST rule).
  const ref2 = find("dec6edd1");
  if (ref2) {
    const gt2 = GROUND_TRUTH["dec6edd1"];
    assert(
      "dec6edd1 impact_new = 120 via thumb_crossing (low-y first)",
      ref2.impact_source === "thumb_crossing" && ref2.impact_new != null && Math.abs(ref2.impact_new - gt2) <= 1.0,
      `impact_new=${ref2.impact_new} thumb=${ref2.impact_thumb} source=${ref2.impact_source} (gt=${gt2})`,
    );
  } else assert("dec6edd1 present", false);

  // (2) LH swings → consensus (gate flipped — LH now runs the xCross consensus exactly like RH).
  //     A consensus-null LH still falls back to arc_bottom/no_precanonical|no_signals; gated swings skip.
  for (const x of rows.filter((r) => r.handedness === "left")) {
    const detail = `source=${x.impact_source} reason=${x.fallback_reason} gate=${x.gate}`;
    assert(
      `LH ${x.swing_id.slice(0, 8)} → consensus (or bounded arc_bottom fallback / gated)`,
      x.impact_source === "consensus" ||
        (x.impact_source === "arc_bottom" &&
          (x.fallback_reason === "no_precanonical" || x.fallback_reason === "no_signals")) ||
        x.gate != null,
      detail,
    );
  }

  // (3) mismatch flag on a761da0e + 4b47009e
  for (const id8 of ["a761da0e", "4b47009e"]) {
    const x = find(id8);
    assert(`${id8} cross-check mismatch flag set`, !!x && x.mismatch_flag === true,
      x ? `delta=${x.impact_delta} mismatch=${x.mismatch_flag} gate=${x.gate}` : "not found");
  }

  // (4) 8d85c860 thumb-primary at coverage ≥ 0.5; 7692a2b8 coverage reported
  const a = find("8d85c860");
  assert("8d85c860 stays thumb-primary (coverage ≥ 0.5)",
    !!a && a.impact_source === "thumb_crossing" && (a.coverage == null || a.coverage >= 0.5),
    a ? `source=${a.impact_source} cov=${a.coverage}` : "not found");
  const b = find("7692a2b8");
  console.log(`  INFO  7692a2b8 coverage=${b?.coverage ?? "n/a"} source=${b?.impact_source ?? "n/a"} gate=${b?.gate ?? "n/a"} reason=${b?.fallback_reason ?? "n/a"}`);

  // (5) no swing that had a stored impact is newly gated
  const newlyGated = rows.filter((x) => x.impact_old != null && x.impact_new == null);
  assert("no swing with a stored impact is newly gated",
    newlyGated.length === 0,
    newlyGated.length ? newlyGated.map((x) => `${x.swing_id.slice(0, 8)}(gate=${x.gate})`).join(", ") : "0");

  // (6) disambiguate 4e1cf438 fallback trigger
  const d = find("4e1cf438");
  console.log(`  INFO  4e1cf438 disambiguation: handedness=${d?.handedness} source=${d?.impact_source ?? "n/a"} fallback_reason=${d?.fallback_reason ?? "n/a"} gate=${d?.gate ?? "n/a"}`);

  // (7) delta-reject gate: egregious thumb↔arc-bottom disagreement (|delta| > 15) rejects the
  // thumb crossing → arc-bottom with reason cross_check_mismatch; small-delta reals are untouched.
  for (const id8 of ["120ef93c", "c0b6f0e1"]) {
    const x = find(id8);
    assert(
      `${id8} delta-rejected → arc_bottom + cross_check_mismatch`,
      !!x && x.impact_source === "arc_bottom" && x.fallback_reason === "cross_check_mismatch",
      x ? `source=${x.impact_source} reason=${x.fallback_reason} delta=${x.impact_delta} gate=${x.gate}` : "not found",
    );
  }
  // Reals with |delta| ≤ 3.3 stay thumb-primary (regression guard; esp. 15a83abd that arc-% broke).
  for (const id8 of ["15a83abd", "b7b6fe1a", "838c539e"]) {
    const x = find(id8);
    assert(
      `${id8} stays thumb_crossing (small |delta|, not delta-rejected)`,
      !!x && x.impact_source === "thumb_crossing" && x.fallback_reason == null,
      x ? `source=${x.impact_source} delta=${x.impact_delta} reason=${x.fallback_reason} impact_new=${x.impact_new}` : "not found",
    );
  }

  console.log(`\n${pass} passed, ${fail} failed (of hard assertions; INFO lines are descriptive).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
