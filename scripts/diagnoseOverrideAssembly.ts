/**
 * diagnoseOverrideAssembly.ts — READ-ONLY. Reconstructs the face-on phase ASSEMBLY
 * interior for an externally-supplied (speed-banded leftWrist) impact frame, which the
 * gated detectFaceOnPhases return ([] on a fired gate) and detectFaceOnPhasesDebug
 * (internal impact only) do not surface. No production edits.
 *
 * Fidelity: detectFaceOnTop / detectFaceOnFinish / jointVelocity are mirrored VERBATIM
 * from phaseDetectionFaceOn.ts (cited) and self-checked —
 *   (a) myTop(anchor, debug.internalImpact) === debug.topIdx, and
 *   (b) the reconstructed gate === detectFaceOnPhases({impactOverride}).fallbackGate.
 * swingStartFrame + takeawayAddressIdx come straight from detectFaceOnPhasesDebug
 * (impact-independent), and the address-gate funcs are the real exported ones.
 *
 * Modes:
 *   npx --yes tsx scripts/diagnoseOverrideAssembly.ts                 # SCAN: T=0.90 non-recovery ids
 *   npx --yes tsx scripts/diagnoseOverrideAssembly.ts <swingId> [..]  # DETAIL per swing
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import type { SwingTrailPoint } from "../packages/domain/swing/phaseDetection";
import { analyzePoseSequence } from "../packages/domain/swing/analysisPipeline";
import {
  detectFaceOnPhases,
  detectFaceOnPhasesDebug,
} from "../packages/domain/swing/phaseDetectionFaceOn";
import { detectCameraAngleEarly } from "../packages/domain/swing/cameraAngle";
import { vetoAndInterpolateKeypoints } from "../packages/domain/swing/keypointVeto";
import { toCanonicalSequence } from "../packages/domain/swing/canonicalTransform";
import {
  EXTERNAL_ASSUMPTIONS,
  computeTrailVelocities,
  smoothVelocities,
  findSetupEndIndex,
  msPerFrameFromTrail,
} from "../packages/domain/swing/phaseDetectionShared";

const A = EXTERNAL_ASSUMPTIONS.faceOn;
const T = 0.9;
const SPEED_LOOKBACK = 3;

// --- env loader (mirrors sweepSwingGates.ts) -------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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

// --- buildTrailPoints mirror (analysisPipeline.ts:126-147) -----------------
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

// --- speed-banded leftWrist arc-bottom (same as testLeadWristImpact.ts) -----
function leadWristSpeed(frames: PoseFrame[], k: number): number[] {
  const n = frames.length;
  const speed = new Array<number>(n).fill(0);
  for (let f = k; f < n; f++) {
    const a = frames[f - k].joints.leftWrist;
    const b = frames[f].joints.leftWrist;
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    speed[f] = Math.sqrt(dx * dx + dy * dy);
  }
  return speed;
}
function robustPeak(speed: number[]): number {
  const n = speed.length;
  if (n === 0) return 0;
  const sorted = [...speed].sort((a, b) => a - b);
  return sorted[Math.min(Math.floor(0.95 * n), n - 1)];
}
function bandedArcBottom(frames: PoseFrame[]): { impact: number | null; peak: number; bandSize: number } {
  const speed = leadWristSpeed(frames, SPEED_LOOKBACK);
  const peak = robustPeak(speed);
  if (!(peak > 0)) return { impact: null, peak, bandSize: 0 };
  const floor = T * peak;
  let bestIdx: number | null = null;
  let bestY = -Infinity;
  let bandSize = 0;
  for (let f = 0; f < frames.length; f++) {
    if (speed[f] < floor) continue;
    bandSize++;
    const y = frames[f].joints.leftWrist?.y;
    if (y == null) continue;
    if (y > bestY) {
      bestY = y;
      bestIdx = f;
    }
  }
  return { impact: bestIdx, peak, bandSize };
}

function globalArcBottom(frames: PoseFrame[]): number | null {
  let bestIdx: number | null = null;
  let best = -Infinity;
  frames.forEach((f, i) => {
    const y = f.joints.leftWrist?.y;
    if (y != null && y > best) {
      best = y;
      bestIdx = i;
    }
  });
  return bestIdx;
}

// ---------------------------------------------------------------------------
// VERBATIM mirrors from phaseDetectionFaceOn.ts (cited). Pure functions.
// ---------------------------------------------------------------------------

// :52-63
function jointVelocity(prev: PoseFrame, curr: PoseFrame, name: "rightWrist"): number | null {
  const a = prev.joints[name];
  const b = curr.joints[name];
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// :188-251 detectFaceOnTop
function detectFaceOnTopMirror(
  frames: PoseFrame[],
  swingStartIdx: number,
  impactIdx: number,
): { frame: number | null } {
  const totalSpan = impactIdx - swingStartIdx;
  if (totalSpan < 6) return { frame: null };
  const fromOffset = Math.round(totalSpan * A.top.searchStartFraction);
  const toOffset = Math.round(totalSpan * A.top.searchEndFraction);
  const from = swingStartIdx + fromOffset;
  const to = impactIdx - toOffset;
  if (to <= from) return { frame: null };
  const rwVel: (number | null)[] = frames.map((f, i) => (i === 0 ? null : jointVelocity(frames[i - 1], f, "rightWrist")));
  let velMinFi = from;
  let velMinV = Infinity;
  for (let F = from; F <= to; F++) {
    const v = rwVel[F];
    if (v != null && v < velMinV) {
      velMinV = v;
      velMinFi = F;
    }
  }
  const window = A.top.consensusWindowFrames;
  let zMaxFi: number | null = null;
  let zMaxV = -Infinity;
  for (let F = Math.max(from, velMinFi - window); F <= Math.min(to, velMinFi + window); F++) {
    const z = frames[F].joints.rightWrist?.z;
    if (z != null && z > zMaxV) {
      zMaxV = z;
      zMaxFi = F;
    }
  }
  let lsMinFi: number | null = null;
  let lsMinV = Infinity;
  for (let F = Math.max(from, velMinFi - window); F <= Math.min(to, velMinFi + window); F++) {
    const x = frames[F].joints.leftShoulder?.x;
    if (x != null && x < lsMinV) {
      lsMinV = x;
      lsMinFi = F;
    }
  }
  const signals = [velMinFi, zMaxFi, lsMinFi].filter((v): v is number => v != null);
  if (signals.length === 0) return { frame: null };
  const mn = Math.min(...signals);
  const mx = Math.max(...signals);
  if (signals.length === 3 && mx - mn <= window) {
    return { frame: Math.round(signals.reduce((s, v) => s + v, 0) / signals.length) };
  }
  return { frame: velMinFi };
}

// :257-320 detectFaceOnFinish (frame only; confirmation affects reliability, not frame)
function detectFaceOnFinishMirror(frames: PoseFrame[], impactIdx: number): { frame: number } {
  const lastIdx = frames.length - 1;
  const tsx: (number | null)[] = frames.map((f) => f.joints.rightShoulder?.x ?? null);
  const W = A.finish.rollingWindow;
  const rolling: (number | null)[] = tsx.map((_, i) => {
    const lo = Math.max(0, i - Math.floor(W / 2));
    const hi = Math.min(lastIdx, i + Math.floor(W / 2));
    let sum = 0;
    let count = 0;
    for (let j = lo; j <= hi; j++) {
      const v = tsx[j];
      if (v == null) continue;
      sum += v;
      count++;
    }
    return count === W ? sum / count : null;
  });
  const cleaned: (number | null)[] = rolling.map((r, i) => {
    if (r == null) return null;
    const raw = tsx[i];
    if (raw == null) return null;
    if (Math.abs(raw - r) > Math.abs(r) * A.finish.plateauJitterPct) return null;
    return r;
  });
  let plateau = -Infinity;
  let plateauIdx: number | null = null;
  for (let i = impactIdx + 1; i <= lastIdx; i++) {
    const v = cleaned[i];
    if (v == null) continue;
    if (v > plateau) {
      plateau = v;
      plateauIdx = i;
    }
  }
  if (plateauIdx == null) return { frame: lastIdx };
  return { frame: plateauIdx };
}

// ---------------------------------------------------------------------------
// Shared prep
// ---------------------------------------------------------------------------
interface SwingRow {
  id: string;
  motion_frames: PoseFrame[] | null;
}

interface Prep {
  swingId: string;
  frames: PoseFrame[];
  trail: SwingTrailPoint[];
  msPerFrame: number;
  canonical: PoseSequence;
  earlyAngle: string;
  currentGate: string | null;
  currentPhases: number;
}

function prepSwing(id: string, rawFrames: PoseFrame[]): Prep {
  const sequence: PoseSequence = { frames: rawFrames, source: "rtmw-l-2d-v1", metadata: {} };
  const result = analyzePoseSequence(sequence, false);
  const veto = vetoAndInterpolateKeypoints(sequence.frames);
  const canonical = toCanonicalSequence({ ...sequence, frames: veto.cleanedFrames }, false);
  const trail = buildTrailPoints(canonical);
  return {
    swingId: id,
    frames: canonical.frames,
    trail,
    msPerFrame: msPerFrameFromTrail(trail),
    canonical,
    earlyAngle: detectCameraAngleEarly(canonical).angle,
    currentGate: (result.swing_debug?.fallback_gate as string | null) ?? null,
    currentPhases: (result.phases ?? []).length,
  };
}

// Reconstruct the assembly for a given impact override. Returns the 6 indices, the
// predicted gate, and the offending pair.
function reconstruct(p: Prep, impactIdx: number) {
  const { frames, trail } = p;
  const debug = detectFaceOnPhasesDebug({ canonical: p.canonical, trail, msPerFrame: p.msPerFrame });

  // address gate (real exported funcs) → frame-space addressIdx (:404-411)
  const smoothed = smoothVelocities(computeTrailVelocities(trail), 5);
  const takeawayAddressIdx = findSetupEndIndex(smoothed, trail);
  const addressTs = trail[takeawayAddressIdx].timestamp;
  const addressIdx = frames.findIndex((f) => f.timestampMs === addressTs);

  const anchor = debug.swingStartFrame ?? takeawayAddressIdx; // :385
  const top = detectFaceOnTopMirror(frames, anchor, impactIdx);

  // self-check the top mirror against debug (debug uses the INTERNAL impact)
  let topMirrorOk = "n/a (debug had no impact)";
  if (debug.impactIdx != null && debug.topIdx != null) {
    const reTop = detectFaceOnTopMirror(frames, anchor, debug.impactIdx).frame;
    topMirrorOk = reTop === debug.topIdx ? `OK (=${reTop})` : `MISMATCH (mirror=${reTop} debug=${debug.topIdx})`;
  }

  if (top.frame == null) {
    return { addressIdx, takeawayAddressIdx, anchor, topIdx: null, impactIdx, topMirrorOk, gate: "top_search_bounds", offending: "top=null", indices: null as number[] | null };
  }
  const topIdx = top.frame;

  if (addressIdx === -1) {
    return { addressIdx, takeawayAddressIdx, anchor, topIdx, impactIdx, topMirrorOk, gate: "(address frame not found)", offending: "addressIdx=-1", indices: null };
  }

  // first ordering gate (:415)
  if (!(addressIdx < topIdx && topIdx < impactIdx)) {
    const where = !(addressIdx < topIdx) ? `address(${addressIdx}) !< top(${topIdx})` : `top(${topIdx}) !< impact(${impactIdx})`;
    return { addressIdx, takeawayAddressIdx, anchor, topIdx, impactIdx, topMirrorOk, gate: "temporal_inversion", offending: where, indices: null };
  }

  const takeawayIdx = Math.floor(addressIdx + (topIdx - addressIdx) * 0.4); // :429
  const downswingIdx = Math.floor(topIdx + (impactIdx - topIdx) * 0.35); // :430
  const finishFrame = detectFaceOnFinishMirror(frames, impactIdx).frame; // :433
  const indices = [addressIdx, takeawayIdx, topIdx, downswingIdx, impactIdx, finishFrame];
  const labels = ["address", "takeaway", "top", "downswing", "impact", "follow_through"];

  // ordering loop (:437-452)
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] <= indices[i - 1]) {
      return { addressIdx, takeawayAddressIdx, anchor, topIdx, impactIdx, topMirrorOk, gate: "temporal_inversion", offending: `${labels[i - 1]}=${indices[i - 1]} >= ${labels[i]}=${indices[i]}`, indices };
    }
  }
  // bunched loop (:453-467)
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] - indices[i - 1] < 2) {
      return { addressIdx, takeawayAddressIdx, anchor, topIdx, impactIdx, topMirrorOk, gate: "phases_too_bunched", offending: `${labels[i - 1]}=${indices[i - 1]} , ${labels[i]}=${indices[i]} (gap=${indices[i] - indices[i - 1]})`, indices };
    }
  }
  return { addressIdx, takeawayAddressIdx, anchor, topIdx, impactIdx, topMirrorOk, gate: null as string | null, offending: "none (ordered)", indices };
}

async function detail(p: Prep) {
  const band = bandedArcBottom(p.frames);
  const global = globalArcBottom(p.frames);
  const cand = band.impact;
  console.log(`\n========== ${p.swingId} ==========`);
  console.log(`frames=${p.frames.length}  msPerFrame=${p.msPerFrame.toFixed(3)}  earlyAngle=${p.earlyAngle}`);
  console.log(`current detector: gate=${p.currentGate}  phases=${p.currentPhases}`);
  console.log(`leftWrist GLOBAL arc-bottom (argmax y) = ${global}`);
  console.log(`speed-band T=${T}: peak(p95)=${band.peak.toFixed(4)}  bandSize=${band.bandSize}  candidate impact = ${cand}`);
  if (cand == null) {
    console.log(`no banded candidate.`);
    return;
  }
  const r = reconstruct(p, cand);
  console.log(`top-mirror self-check: ${r.topMirrorOk}`);
  console.log(`swingStartFrame=${detectFaceOnPhasesDebug({ canonical: p.canonical, trail: p.trail, msPerFrame: p.msPerFrame }).swingStartFrame}  takeawayAddressIdx(trail)=${r.takeawayAddressIdx}  anchor=${r.anchor}`);
  if (r.indices) {
    const labels = ["address", "takeaway", "top", "downswing", "impact", "follow_through"];
    console.log(`assembled phases (impact override=${cand}):`);
    labels.forEach((l, i) => console.log(`    ${l.padEnd(15)} = ${r.indices![i]}`));
  } else {
    console.log(`assembled (partial): address=${r.addressIdx}  top=${r.topIdx}  impact=${r.impactIdx}`);
  }
  console.log(`RECONSTRUCTED gate: ${r.gate}   offending: ${r.offending}`);

  // cross-check vs the real seam
  const real = detectFaceOnPhases({ canonical: p.canonical, trail: p.trail, msPerFrame: p.msPerFrame, impactOverride: cand });
  const realGate = real.fallbackGate;
  const match = realGate === r.gate;
  console.log(`detectFaceOnPhases(override=${cand}).fallbackGate = ${realGate}  → reconstruction ${match ? "MATCHES ✓" : "DIVERGES ✗"}`);
}

async function main() {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("Missing supabase env");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const args = process.argv.slice(2);

  if (args.length > 0) {
    // DETAIL mode
    for (const id of args) {
      const { data, error } = await sb.from("swings").select("id, motion_frames").eq("id", id).maybeSingle();
      if (error || !data) {
        console.error(`load failed for ${id}: ${error?.message ?? "not found"}`);
        continue;
      }
      const row = data as unknown as SwingRow;
      if (!row.motion_frames?.length) {
        console.error(`${id}: no motion_frames`);
        continue;
      }
      await detail(prepSwing(row.id, row.motion_frames));
    }
    return;
  }

  // SCAN mode — at T=0.90, list impact_search_bounds non-recoveries grouped by candGate.
  const { data, error } = await sb
    .from("swings")
    .select("id, motion_frames, swing_debug")
    .eq("swing_debug->>camera_angle", "face_on")
    .eq("swing_debug->>handedness", "right")
    .limit(100);
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  const rows = (data ?? []) as unknown as SwingRow[];
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.motion_frames?.length) continue;
    const p = prepSwing(row.id, row.motion_frames);
    const currentBucket = p.currentGate ?? (p.currentPhases > 0 ? "success" : "no_gate_empty_phases");
    if (currentBucket !== "impact_search_bounds") continue;
    const base = detectFaceOnPhases({ canonical: p.canonical, trail: p.trail, msPerFrame: p.msPerFrame });
    const crossOk = p.earlyAngle === "face_on" && base.fallbackGate === p.currentGate && base.phases.length === p.currentPhases;
    if (!crossOk) continue;
    const cand = bandedArcBottom(p.frames).impact;
    if (cand == null) continue;
    const over = detectFaceOnPhases({ canonical: p.canonical, trail: p.trail, msPerFrame: p.msPerFrame, impactOverride: cand });
    const ordered = over.fallbackGate === null && over.phases.length > 0;
    if (ordered) continue;
    const g = String(over.fallbackGate);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(row.id);
  }
  console.log(`\n=== T=0.90 impact_search_bounds NON-RECOVERIES (grouped by resulting gate) ===`);
  for (const [g, ids] of [...groups.entries()].sort()) {
    console.log(`\n${g} (${ids.length}):`);
    for (const id of ids) console.log(`  ${id}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
