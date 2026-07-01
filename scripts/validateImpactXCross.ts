/**
 * validateImpactXCross.ts — PR1 shadow validation for the ported xCross CONSENSUS impact
 * (packages/domain/swing/faceOnImpactConsensus.ts). READ-ONLY on the DB.
 *
 * For each ground-truth swing it replicates analyzePoseSequence's EXACT prep
 * (correctLowerBodyIdentity → vetoAndInterpolateKeypoints → toCanonicalSequence; preCanonical =
 * post-veto), runs detectFaceOnPhasesDebug (live impact + the shadow consensus), and then SWEEPS
 * the consensus over BOTH spaces (preCanonical / canonical) × BOTH signs (+1 / −1) to LOCK the
 * signFlip empirically against ground truth — the sign is PROVEN here, never reasoned.
 *
 * Window for every sweep = [topIdx, finishFrame] (same as the production shadow). Reports a
 * per-swing computed-vs-verified table + the PR1 acceptance summary.
 *
 *   npx --yes tsx scripts/validateImpactXCross.ts
 *
 * Env: EXPO_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or anon) in .env.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import type { SwingTrailPoint } from "../packages/domain/swing/phaseDetection";
import { correctLowerBodyIdentity } from "../packages/domain/swing/lowerBodyIdentity";
import { vetoAndInterpolateKeypoints } from "../packages/domain/swing/keypointVeto";
import { toCanonicalSequence, CANONICAL_LEAD, CANONICAL_TRAIL } from "../packages/domain/swing/canonicalTransform";
import { msPerFrameFromTrail } from "../packages/domain/swing/phaseDetectionShared";
import { detectFaceOnPhasesDebug } from "../packages/domain/swing/phaseDetectionFaceOn";
import { computeFaceOnImpactConsensus } from "../packages/domain/swing/faceOnImpactConsensus";

// Hand-verified impacts (honeyswing-swing-inspector ImpactRuleValidation.tsx VERIFIED).
// d5084eb5 EXCLUDED (eyes-closed / atypical).
const VERIFIED: { prefix: string; impact: number; tier: "easy" | "hard" }[] = [
  { prefix: "16c98eeb", impact: 112, tier: "easy" },
  { prefix: "919cb737", impact: 141, tier: "easy" },
  { prefix: "9de4f7ff", impact: 108, tier: "easy" },
  { prefix: "9d1606a6", impact: 125, tier: "hard" },
  { prefix: "e212431b", impact: 151, tier: "hard" },
  { prefix: "3a814184", impact: 134, tier: "hard" },
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(resolve(__dirname, ".."), ".env");
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  let text = "";
  try {
    text = readFileSync(ENV_PATH, "utf8");
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[k] === undefined) env[k] = v;
  }
  return env;
}

// Local copy of analysisPipeline.buildTrailPoints (module-local there).
function buildTrailPoints(sequence: PoseSequence): SwingTrailPoint[] {
  const points: SwingTrailPoint[] = [];
  for (const frame of sequence.frames) {
    const lead = frame.joints[CANONICAL_LEAD.wrist];
    const trail = frame.joints[CANONICAL_TRAIL.wrist];
    if (!lead || !trail) continue;
    points.push({
      x: (lead.x + trail.x) / 2,
      y: (lead.y + trail.y) / 2,
      timestamp: frame.timestampMs,
      leadX: lead.x,
      leadY: lead.y,
      trailX: trail.x,
      trailY: trail.y,
    });
  }
  return points;
}

const fmt = (n: number | null, d = 1) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(d));
const pad = (s: string | number, w: number) => String(s).padEnd(w);

type SweepKey = "pre+1" | "pre-1" | "can+1" | "can-1";

async function main() {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("[validateImpactXCross] Missing EXPO_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Resolve prefixes → full ids (lightweight), then pull motion_frames only for those.
  const { data: idRows, error: idErr } = await sb.from("swings").select("id");
  if (idErr) {
    console.error(`[validateImpactXCross] supabase error: ${idErr.message}`);
    process.exit(1);
  }
  const fullIds: { prefix: string; id: string }[] = [];
  for (const v of VERIFIED) {
    const hit = (idRows ?? []).find((r) => String(r.id).startsWith(v.prefix));
    if (!hit) {
      console.error(`[validateImpactXCross] swing not found for prefix ${v.prefix}`);
      continue;
    }
    fullIds.push({ prefix: v.prefix, id: String(hit.id) });
  }
  const { data, error } = await sb
    .from("swings")
    .select("id, motion_frames, swing_debug")
    .in("id", fullIds.map((f) => f.id));
  if (error) {
    console.error(`[validateImpactXCross] supabase error: ${error.message}`);
    process.exit(1);
  }
  const byId = new Map((data ?? []).map((r) => [String(r.id), r]));

  // Per-sweep accumulators of |Δ| for picking the winning (space, sign) against ground truth.
  const sweepAbs: Record<SweepKey, number[]> = { "pre+1": [], "pre-1": [], "can+1": [], "can-1": [] };
  const rowsOut: {
    prefix: string;
    tier: string;
    hand: string;
    verified: number;
    live: number | null;
    liveSrc: string;
    gate: string;
    shadow: number | null;
    shadowSrc: string;
    budget: number | null;
    sweeps: Record<SweepKey, number | null>;
  }[] = [];

  for (const { prefix, id } of fullIds) {
    const v = VERIFIED.find((x) => x.prefix === prefix)!;
    const sw = byId.get(id);
    if (!sw || !sw.motion_frames) {
      console.error(`[validateImpactXCross] no motion_frames for ${prefix}`);
      continue;
    }
    const dbg = (sw.swing_debug ?? {}) as Record<string, unknown>;
    const isLeftHanded = dbg.handedness === "left";
    const seq: PoseSequence = { frames: sw.motion_frames as PoseFrame[], source: "validate", metadata: {} };

    // EXACT analyzePoseSequence prep (analysisPipeline.ts:548-582).
    const identity = correctLowerBodyIdentity(seq.frames);
    const identitySeq: PoseSequence = identity.swappedFrames.length > 0 ? { ...seq, frames: identity.frames } : seq;
    const veto = vetoAndInterpolateKeypoints(identitySeq.frames);
    const cleaned: PoseSequence = { ...identitySeq, frames: veto.cleanedFrames };
    const canonical = toCanonicalSequence(cleaned, !isLeftHanded);
    const trail = buildTrailPoints(canonical);
    const msPerFrame = msPerFrameFromTrail(trail);

    // fps parity check: ms/frame from RAW frame timestamps (independent of dropped-wrist trail).
    const fr = sw.motion_frames as PoseFrame[];
    const rawMsPerFrame = fr.length > 1 ? (fr[fr.length - 1].timestampMs - fr[0].timestampMs) / (fr.length - 1) : NaN;
    console.log(`[fps] ${prefix} (${isLeftHanded ? "LH" : "RH"}): msPerFrame=${rawMsPerFrame.toFixed(3)} fps=${(1000 / rawMsPerFrame).toFixed(2)} nframes=${fr.length}`);

    const r = detectFaceOnPhasesDebug({ canonical, trail, msPerFrame, preCanonical: cleaned, isLeftHanded });

    const topIdx = r.topIdx;
    const finishFrame = r.finishFrame;
    const lastIdx = cleaned.frames.length - 1;
    const sweeps: Record<SweepKey, number | null> = { "pre+1": null, "pre-1": null, "can+1": null, "can-1": null };

    let budgetFinal: number | null = null;

    if (topIdx != null && finishFrame != null && finishFrame > topIdx) {
      const combos: { keyk: SweepKey; frames: PoseFrame[]; sign: number }[] = [
        { keyk: "pre+1", frames: cleaned.frames, sign: 1 },
        { keyk: "pre-1", frames: cleaned.frames, sign: -1 },
        { keyk: "can+1", frames: canonical.frames, sign: 1 },
        { keyk: "can-1", frames: canonical.frames, sign: -1 },
      ];
      console.log(`\n${prefix} (${v.tier}, ${isLeftHanded ? "LH" : "RH"}) verified=${v.impact} window=[${topIdx},${finishFrame}]`);
      for (const c of combos) {
        const out = computeFaceOnImpactConsensus({
          frames: c.frames,
          lo: topIdx,
          hi: finishFrame,
          isLeftHanded,
          signFlipOverride: c.sign,
        });
        sweeps[c.keyk] = out.final;
        if (out.final != null) sweepAbs[c.keyk].push(Math.abs(out.final - v.impact));
        const crossFrames = out.xCrossings.map((x) => x.frame).join(",") || "none";
        console.log(
          `   ${pad(c.keyk, 6)} final=${pad(fmt(out.final), 7)} src=${pad(out.source, 10)} ` +
            `Δ=${pad(out.final == null ? "—" : fmt(out.final - v.impact), 7)} ` +
            `xCross=${pad(fmt(out.xCross), 7)} S1=${pad(out.s1.frame ?? "—", 4)} S2=${pad(out.s2.frame ?? "—", 4)} ` +
            `S3=${pad(out.s3.frame ?? "—", 4)} cons=${pad(fmt(out.consensus), 6)} crossings=[${crossFrames}]`,
        );
      }
      // Budget window (viewer design: [topIdx, topIdx+DOWNSWING_BUDGET=50]) on preCanonical with
      // the NOMINAL sign (RH+1 / LH−1) — proves whether the WINDOW, not the algorithm/sign, is the
      // hard-swing blocker.
      const hiB = Math.min(topIdx + 50, lastIdx);
      const outB = computeFaceOnImpactConsensus({ frames: cleaned.frames, lo: topIdx, hi: hiB, isLeftHanded });
      budgetFinal = outB.final;
      console.log(
        `   ${pad("BUDGET", 6)} final=${pad(fmt(outB.final), 7)} src=${pad(outB.source, 10)} ` +
          `Δ=${pad(outB.final == null ? "—" : fmt(outB.final - v.impact), 7)} ` +
          `xCross=${pad(fmt(outB.xCross), 7)} S1=${pad(outB.s1.frame ?? "—", 4)} S2=${pad(outB.s2.frame ?? "—", 4)} ` +
          `S3=${pad(outB.s3.frame ?? "—", 4)} cons=${pad(fmt(outB.consensus), 6)} window=[${topIdx},${hiB}]`,
      );
    } else {
      console.log(`\n${prefix} (${v.tier}, ${isLeftHanded ? "LH" : "RH"}) verified=${v.impact}  NO WINDOW (top/finish missing; gate=${r.wouldFallbackGate})`);
    }

    rowsOut.push({
      prefix,
      tier: v.tier,
      hand: isLeftHanded ? "LH" : "RH",
      verified: v.impact,
      live: r.impactIdx,
      liveSrc: r.impactSource ?? "—",
      gate: r.wouldFallbackGate ?? "ok",
      shadow: r.impactConsensus?.final ?? null,
      shadowSrc: r.impactConsensus?.source ?? "—",
      budget: budgetFinal,
      sweeps,
    });
  }

  // --- per-swing summary table ---
  console.log("\n\n================ PER-SWING SUMMARY (computed vs verified) ================");
  console.log(
    `${pad("swing", 10)}${pad("tier", 6)}${pad("hand", 5)}${pad("verif", 7)}${pad("LIVE", 7)}${pad("liveSrc", 12)}` +
      `${pad("gate", 18)}${pad("shadow", 9)}${pad("shΔ", 7)}${pad("shadowSrc", 11)}`,
  );
  for (const o of rowsOut) {
    const shD = o.shadow == null ? "—" : fmt(o.shadow - o.verified);
    console.log(
      `${pad(o.prefix, 10)}${pad(o.tier, 6)}${pad(o.hand, 5)}${pad(o.verified, 7)}${pad(o.live ?? "—", 7)}` +
        `${pad(o.liveSrc, 12)}${pad(o.gate, 18)}${pad(fmt(o.shadow), 9)}${pad(shD, 7)}${pad(o.shadowSrc, 11)}`,
    );
  }

  // --- signFlip × space sweep summary (which combo is closest to ground truth) ---
  console.log("\n================ signFlip × SPACE SWEEP (lock the sign) ================");
  const keys: SweepKey[] = ["pre+1", "pre-1", "can+1", "can-1"];
  for (const k of keys) {
    const arr = sweepAbs[k];
    const n = arr.length;
    const avg = n ? arr.reduce((s, x) => s + x, 0) / n : NaN;
    const max = n ? Math.max(...arr) : NaN;
    console.log(`   ${pad(k, 6)} resolved ${n}/${VERIFIED.length}  avg|Δ|=${fmt(avg, 2)}  max|Δ|=${fmt(max, 2)}`);
  }

  // --- PR1 acceptance gate evaluation (against the production combo pre+1) ---
  console.log("\n================ PR1 ACCEPTANCE GATE ================");
  const easy = rowsOut.filter((o) => o.tier === "easy");
  const hard = rowsOut.filter((o) => o.tier === "hard");
  const within = (o: (typeof rowsOut)[number], tol: number) =>
    o.shadow != null && Math.abs(o.shadow - o.verified) <= tol;
  console.log("Easy-3 (target avg|Δ|≤0.43 / max≤1.0):");
  for (const o of easy) console.log(`   ${o.prefix}: shadow=${fmt(o.shadow)} verified=${o.verified} Δ=${o.shadow == null ? "—" : fmt(o.shadow - o.verified)} ${within(o, 1.0) ? "✅" : "❌"}`);
  console.log("Hard-3 (broken→fixed) — evaluated on the BUDGET window [topIdx, topIdx+50]:");
  for (const o of hard) {
    const okB = o.budget != null && Math.abs(o.budget - o.verified) <= 3.0;
    console.log(
      `   ${o.prefix}: budget=${fmt(o.budget)} verified=${o.verified} ` +
        `Δ=${o.budget == null ? "—" : fmt(o.budget - o.verified)}  (prodShadow=${fmt(o.shadow)}) ${okB ? "✅ FIXED" : "❌"}`,
    );
  }
  console.log("\nLIVE (arc-bottom/thumb) for reference — what the app does TODAY:");
  for (const o of [...easy, ...hard]) console.log(`   ${o.prefix}: live=${o.live ?? "—"} (${o.liveSrc}) verified=${o.verified} Δ=${o.live == null ? "—" : o.live - o.verified}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
