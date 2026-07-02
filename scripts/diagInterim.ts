/**
 * READ-ONLY interim diagnostic — replicates analyzePoseSequence's EXACT prep
 * (correctLowerBodyIdentity → vetoAndInterpolateKeypoints → toCanonicalSequence →
 * buildTrailPoints; preCanonical = post-veto) and calls detectFaceOnPhasesDebug to
 * surface the production interim indices + would-gate + offending bunch pair.
 * (Unlike scripts/debugPhaseDetection.ts, this DOES run veto+identity, matching prod.)
 *   npx --yes tsx scripts/diagInterim.ts <id-prefix...>
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(resolve(__dirname, ".."), ".env");
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  let text = ""; try { text = readFileSync(ENV_PATH, "utf8"); } catch { return env; }
  for (const line of text.split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq < 0) continue;
    const k = t.slice(0, eq).trim(); let v = t.slice(eq + 1).trim();
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
      x: (lead.x + trail.x) / 2, y: (lead.y + trail.y) / 2,
      timestamp: frame.timestampMs,
      leadX: lead.x, leadY: lead.y, trailX: trail.x, trailY: trail.y,
    });
  }
  return points;
}

async function main() {
  const prefixes = process.argv.slice(2);
  if (prefixes.length === 0) { console.error("usage: diagInterim.ts <id-prefix...>"); process.exit(1); }
  const env = loadEnv();
  const sb = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });

  const { data } = await sb.from("swings").select("id, motion_frames, swing_debug");
  const rows = (data ?? []).filter((r) => prefixes.some((p) => String(r.id).startsWith(p)));

  for (const sw of rows) {
    const id8 = String(sw.id).slice(0, 8);
    const dbg = (sw.swing_debug ?? {}) as Record<string, any>;
    const isLeftHanded = dbg.handedness === "left";
    const seq: PoseSequence = { frames: sw.motion_frames as PoseFrame[], source: "diag", metadata: {} };

    // EXACT analyzePoseSequence prep (analysisPipeline.ts:548-582).
    const identity = correctLowerBodyIdentity(seq.frames);
    const identitySeq: PoseSequence = identity.swappedFrames.length > 0 ? { ...seq, frames: identity.frames } : seq;
    const veto = vetoAndInterpolateKeypoints(identitySeq.frames);
    const cleaned: PoseSequence = { ...identitySeq, frames: veto.cleanedFrames };
    const canonical = toCanonicalSequence(cleaned, !isLeftHanded);
    const trail = buildTrailPoints(canonical);
    const msPerFrame = msPerFrameFromTrail(trail);

    const r = detectFaceOnPhasesDebug({ canonical, trail, msPerFrame, preCanonical: cleaned, isLeftHanded });

    const idx = [r.takeawayIdx ?? r.addressIdx, r.topIdx, r.downswingIdx, r.impactIdx, r.finishFrame];
    const labels = ["takeaway", "top", "downswing", "impact", "finish"];
    let worst = "";
    for (let i = 1; i < idx.length; i++) {
      const a = idx[i - 1], b = idx[i];
      if (a != null && b != null && b - a < 2) worst += ` [${labels[i - 1]}=${a}→${labels[i]}=${b} gap=${b - a}]`;
    }
    console.log(
      `${id8} ${isLeftHanded ? "L" : "R"}  takeaway=${r.takeawayIdx ?? r.addressIdx} top=${r.topIdx} ` +
      `downswing=${r.downswingIdx} impact=${r.impactIdx} finish=${r.finishFrame}  ` +
      `gate=${r.wouldFallbackGate ?? "null(ok)"}  topXextreme=${r.topXExtreme?.frame ?? "—"} velmin=${r.topVelMinShadow ?? "—"}` +
      (worst ? `  BUNCH:${worst}` : ""),
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
