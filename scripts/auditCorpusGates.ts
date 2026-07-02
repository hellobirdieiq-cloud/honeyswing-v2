/**
 * auditCorpusGates.ts — RULE 83 corpus regression audit for the impact cutover. READ-ONLY.
 * Runs detectFaceOnPhasesDebug over the FULL RH corpus and prints "<id8>,<gate>" per swing so the
 * post-flip working tree can be diffed against pre-flip (git stash). Bar = ZERO new gate-outs
 * (no swing that scores today — gate "ok" — may flip to any gate).
 *
 *   npx --yes tsx scripts/auditCorpusGates.ts > post.txt   # post-flip
 *   git stash && npx --yes tsx scripts/auditCorpusGates.ts > pre.txt && git stash pop
 *
 * UNTRACKED on purpose: `git stash` (no -u) leaves it in place so the same script runs against
 * both code states. LH swings are excluded (arc-bottom by design, unaffected by the cutover).
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

const ENV_PATH = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), ".env");
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  let text = "";
  try { text = readFileSync(ENV_PATH, "utf8"); } catch { return env; }
  for (const line of text.split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[t.slice(0, i).trim()] === undefined) env[t.slice(0, i).trim()] = v;
  }
  return env;
}
function buildTrail(seq: PoseSequence): SwingTrailPoint[] {
  const pts: SwingTrailPoint[] = [];
  for (const f of seq.frames) {
    const lead = f.joints[CANONICAL_LEAD.wrist]; const tr = f.joints[CANONICAL_TRAIL.wrist];
    if (!lead || !tr) continue;
    pts.push({ x: (lead.x + tr.x) / 2, y: (lead.y + tr.y) / 2, timestamp: f.timestampMs, leadX: lead.x, leadY: lead.y, trailX: tr.x, trailY: tr.y });
  }
  return pts;
}
(async () => {
  const env = loadEnv();
  const sb = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.from("swings").select("id, motion_frames, swing_debug");
  if (error) { console.error(error.message); process.exit(1); }
  const rows = (data ?? []).filter((r: any) => (r.swing_debug?.handedness ?? "right") !== "left" && Array.isArray(r.motion_frames) && r.motion_frames.length > 0);
  const out: string[] = [];
  for (const sw of rows) {
    const id8 = String(sw.id).slice(0, 8);
    try {
      const seq: PoseSequence = { frames: sw.motion_frames as PoseFrame[], source: "audit", metadata: {} };
      const id = correctLowerBodyIdentity(seq.frames);
      const iseq = id.swappedFrames.length > 0 ? { ...seq, frames: id.frames } : seq;
      const veto = vetoAndInterpolateKeypoints(iseq.frames);
      const cleaned = { ...iseq, frames: veto.cleanedFrames };
      const canon = toCanonicalSequence(cleaned, true); // RH → mirror
      const trail = buildTrail(canon);
      const r = detectFaceOnPhasesDebug({ canonical: canon, trail, msPerFrame: msPerFrameFromTrail(trail), preCanonical: cleaned, isLeftHanded: false });
      out.push(`${id8},${r.wouldFallbackGate ?? "ok"}`);
    } catch (e) {
      out.push(`${id8},ERROR:${(e as Error).message.slice(0, 40)}`);
    }
  }
  out.sort();
  console.log(out.join("\n"));
  console.error(`[audit] ${out.length} RH swings processed`);
})();
