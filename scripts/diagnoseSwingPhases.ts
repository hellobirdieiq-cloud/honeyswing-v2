/**
 * diagnoseSwingPhases.ts — read-only diagnostic for ONE swing's phase failure.
 *
 * Re-runs the analysis pipeline on a persisted swing and emits a single
 * self-contained HTML viewer (inline SVG, no CDN, no build step) that plots:
 *   1. the CURRENT impact signal exactly as phaseDetectionFaceOn.ts computes it
 *      (handAvg X vs footRef X, riseRate vs 0.03, rise-active / handAvg>=footRef
 *      bands) so you can SEE the "rise-never-triggered" cause;
 *   2. a CANDIDATE lead-wrist Y-arc-bottom signal (both wrists' .y, arc-bottom
 *      markers) to test whether it would fire where hand-X fails;
 *   3. the authoritative pipeline RESULT (phases, per-phase reliability,
 *      fallback_gate, camera_angle).
 *
 * EXACT-MATCH NOTE: the detector does NOT see raw motion_frames. The pipeline
 * pre-cleans them — analysisPipeline.ts:527-528 runs vetoAndInterpolateKeypoints
 * then toCanonicalSequence, and detectFaceOnPhases reads canonical.frames
 * (phaseDetectionFaceOn.ts:336). This script mirrors that prep using the REAL
 * exported building blocks, and re-implements the two module-local functions
 * (buildTrailPoints, impact inner loop) VERBATIM with line citations, so the
 * recomputed signal matches what the detector actually consumed. A ✓/✗ badge in
 * the HTML asserts the recomputed impact agrees with the pipeline's fallback_gate.
 *
 * Read-only: no DB writes, no detector edits.
 *
 * Usage:
 *   npx --yes tsx scripts/diagnoseSwingPhases.ts            # default swing d517648b
 *   npx --yes tsx scripts/diagnoseSwingPhases.ts <swingId>
 *
 * Env: EXPO_PUBLIC_SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY or
 * EXPO_PUBLIC_SUPABASE_ANON_KEY (read from .env at repo root, same loader as
 * scripts/inspectSwing.ts).
 */

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PoseFrame, PoseSequence } from "../packages/pose/PoseTypes";
import type { SwingTrailPoint } from "../packages/domain/swing/phaseDetection";
import { analyzePoseSequence } from "../packages/domain/swing/analysisPipeline";
import { vetoAndInterpolateKeypoints } from "../packages/domain/swing/keypointVeto";
import { toCanonicalSequence } from "../packages/domain/swing/canonicalTransform";
import {
  EXTERNAL_ASSUMPTIONS,
  msPerFrameFromTrail,
  msToFrames,
} from "../packages/domain/swing/phaseDetectionShared";

const DEFAULT_SWING_ID = "d517648b-f87a-48eb-b04a-3c27b2fef4a1";
const A = EXTERNAL_ASSUMPTIONS.faceOn;

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/inspectSwing.ts)
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
// Mirror of analysisPipeline.ts:126-147 buildTrailPoints (module-local, not
// exported). Verbatim — skips frames missing either wrist (:133). Used only to
// feed msPerFrameFromTrail so msPerFrame matches the detector exactly.
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
// Per-frame impact-signal recompute — mirrors phaseDetectionFaceOn.ts:139-181
// VERBATIM, but instrumented to emit the per-frame arrays the detector throws
// away. Returns the same {frame,reliability} the detector returns, plus traces.
// ---------------------------------------------------------------------------

interface ImpactRecompute {
  frame: number | null;
  reliability: "high" | "low" | null;
  footRef: number | null;
  handAvg: (number | null)[];
  riseRate: (number | null)[]; // handAvg[F]-handAvg[F-lookback], aligned by F
  riseGate: boolean[]; // riseRate > threshold (per :169)
  riseActive: boolean[]; // activeStreak >= sustainFrames (per :174)
  aboveFoot: boolean[]; // handAvg[F] >= footRef (per :175)
  wouldFire: boolean[]; // riseActive && aboveFoot (the :175 firing condition)
  sustainFrames: number;
}

function recomputeImpact(frames: PoseFrame[], msPerFrame: number): ImpactRecompute {
  const n = frames.length;
  const handAvg: (number | null)[] = new Array(n).fill(null);
  const riseRate: (number | null)[] = new Array(n).fill(null);
  const riseGate: boolean[] = new Array(n).fill(false);
  const riseActive: boolean[] = new Array(n).fill(false);
  const aboveFoot: boolean[] = new Array(n).fill(false);
  const wouldFire: boolean[] = new Array(n).fill(false);

  // footRef — phaseDetectionFaceOn.ts:139-147
  const footFrames = Math.min(A.impact.footRefFrames, n);
  const footSamples: number[] = [];
  for (let i = 0; i < footFrames; i++) {
    const h = frames[i].joints.leftHeel;
    const a = frames[i].joints.leftAnkle;
    if (h && a) footSamples.push((h.x + a.x) / 2);
  }
  const sustainFrames = Math.max(1, msToFrames(A.impact.riseSustainMs, msPerFrame)); // :158
  if (footSamples.length === 0) {
    return {
      frame: null, reliability: null, footRef: null,
      handAvg, riseRate, riseGate, riseActive, aboveFoot, wouldFire, sustainFrames,
    };
  }
  const footRef = footSamples.reduce((s, v) => s + v, 0) / footSamples.length; // :147

  // handAvg — phaseDetectionFaceOn.ts:150-156
  for (let f = 0; f < n; f++) {
    const w = frames[f].joints.rightWrist;
    const t = frames[f].joints.rightThumb;
    if (!w) { handAvg[f] = null; continue; }
    handAvg[f] = !t ? w.x : (w.x + t.x) / 2;
  }

  // rise loop — phaseDetectionFaceOn.ts:158-181
  let activeStreak = 0;
  let firedFrame: number | null = null;
  for (let F = A.impact.riseLookbackFrames; F < n; F++) {
    const here = handAvg[F];
    const prev = handAvg[F - A.impact.riseLookbackFrames];
    if (here == null || prev == null) {
      activeStreak = 0;
      continue;
    }
    const rr = here - prev; // :168
    riseRate[F] = rr;
    if (rr > A.impact.riseRateThreshold) { // :169
      activeStreak += 1;
      riseGate[F] = true;
    } else {
      activeStreak = 0;
    }
    const active = activeStreak >= sustainFrames; // :174
    riseActive[F] = active;
    const above = here >= footRef; // :175
    aboveFoot[F] = above;
    if (active && above) {
      wouldFire[F] = true;
      if (firedFrame == null) {
        const lagFrames = msToFrames(A.impact.lagCorrectionMs, msPerFrame); // :176
        firedFrame = Math.max(0, F - lagFrames); // :177
      }
    }
  }

  // Detector returns at the FIRST firing frame (:178) or null (:181).
  return {
    frame: firedFrame,
    reliability: firedFrame == null ? "low" : "high",
    footRef, handAvg, riseRate, riseGate, riseActive, aboveFoot, wouldFire, sustainFrames,
  };
}

// ---------------------------------------------------------------------------
// Candidate lead-wrist Y-arc — derive per-frame .y traces + arc-bottom.
// y normalized top-down (0=top..1=bottom), so bottom-of-arc = MAX y.
// ---------------------------------------------------------------------------

function yTrace(frames: PoseFrame[], joint: "leftWrist" | "rightWrist"): (number | null)[] {
  return frames.map((f) => {
    const j = f.joints[joint];
    return j ? j.y : null;
  });
}

function argMax(trace: (number | null)[]): number | null {
  let bestIdx: number | null = null;
  let best = -Infinity;
  trace.forEach((v, i) => {
    if (v != null && v > best) { best = v; bestIdx = i; }
  });
  return bestIdx;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface SwingRow {
  id: string;
  created_at: string;
  frame_count: number | null;
  motion_frames: PoseFrame[] | null;
  gravity_vector: { x: number; y: number; z: number } | null;
}

async function main() {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error(
      "[diagnoseSwingPhases] Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/EXPO_PUBLIC_SUPABASE_ANON_KEY in .env",
    );
    process.exit(1);
  }

  const swingId = process.argv[2] ?? DEFAULT_SWING_ID;
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await sb
    .from("swings")
    .select("id, created_at, frame_count, motion_frames, gravity_vector")
    .eq("id", swingId)
    .maybeSingle();
  if (error) { console.error("Supabase query error:", error.message); process.exit(1); }
  if (!data) { console.error(`No swing found with id=${swingId}`); process.exit(1); }
  const row = data as unknown as SwingRow;

  const rawFrames = row.motion_frames;
  if (!rawFrames || !Array.isArray(rawFrames) || rawFrames.length === 0) {
    console.error("motion_frames is empty or missing — nothing to diagnose.");
    process.exit(1);
  }

  // RH golfer → isLeftHanded=false. canonical = identity (only x mirrors for LH).
  const isLeftHanded = false;
  const sequence: PoseSequence = {
    frames: rawFrames,
    source: "rtmw-l-2d-v1",
    metadata: {},
  };

  // --- Authoritative pipeline result (handles its own veto+canonical internally).
  const result = analyzePoseSequence(sequence, isLeftHanded);

  // --- Mirror the detector's pre-detector frame prep (analysisPipeline.ts:527-528).
  const veto = vetoAndInterpolateKeypoints(sequence.frames);
  const canonical = toCanonicalSequence(
    { ...sequence, frames: veto.cleanedFrames },
    isLeftHanded,
  );
  const detFrames = canonical.frames; // == phaseDetectionFaceOn.ts:336 frames

  // --- msPerFrame exactly as the dispatcher derives it (phaseDetection.ts:134).
  const trail = buildTrailPoints(canonical);
  const msPerFrame = msPerFrameFromTrail(trail);

  // --- Recompute the impact signal on the detector's frames.
  const impact = recomputeImpact(detFrames, msPerFrame);

  // --- Candidate Y-arc signal (on the same detector frames).
  const leftWristY = yTrace(detFrames, "leftWrist");
  const rightWristY = yTrace(detFrames, "rightWrist");
  const leftArcBottom = argMax(leftWristY);   // LEAD for RH
  const rightArcBottom = argMax(rightWristY); // TRAIL for RH (what detector keys on)

  // --- Self-check: recompute vs pipeline fallback_gate.
  const fallbackGate = result.swing_debug?.fallback_gate ?? null;
  const cameraAngle =
    (result.swing_debug as Record<string, unknown> | undefined)?.camera_angle ??
    (result.swing_debug as Record<string, unknown> | undefined)?.camera_angle_pre ??
    null;
  const recomputeMatches =
    (impact.frame == null && fallbackGate === "impact_search_bounds") ||
    (impact.frame != null && fallbackGate !== "impact_search_bounds");

  const phaseRules = result.swing_debug?.phase_rules ?? null;

  const payload = {
    swingId: row.id,
    createdAt: row.created_at,
    isLeftHanded,
    handednessLabel: "RIGHT (canonical = identity; raw x = canonical x)",
    frameCountDb: row.frame_count,
    frameCountUsed: detFrames.length,
    cameraAngle,
    msPerFrame,
    sustainFrames: impact.sustainFrames,
    thresholds: {
      footRefFrames: A.impact.footRefFrames,
      riseRateThreshold: A.impact.riseRateThreshold,
      riseLookbackFrames: A.impact.riseLookbackFrames,
      riseSustainMs: A.impact.riseSustainMs,
      lagCorrectionMs: A.impact.lagCorrectionMs,
    },
    footRef: impact.footRef,
    handAvg: impact.handAvg,
    riseRate: impact.riseRate,
    riseGate: impact.riseGate,
    riseActive: impact.riseActive,
    aboveFoot: impact.aboveFoot,
    wouldFire: impact.wouldFire,
    detectorImpactFrame: impact.frame,
    detectorImpactReliability: impact.reliability,
    leftWristY,
    rightWristY,
    leftArcBottom,
    rightArcBottom,
    pipeline: {
      score: result.score,
      tempo: result.tempo ?? null,
      fallbackGate,
      phases: result.phases ?? [],
      phaseReliability: phaseRules ? (phaseRules as Record<string, unknown>).reliability ?? null : null,
    },
    recomputeMatches,
  };

  const outDir = join(REPO_ROOT, "scripts", "output");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `swing-diagnostic_${row.id}.html`);
  writeFileSync(outPath, renderHtml(payload));

  console.log("");
  console.log(`Swing:            ${row.id}`);
  console.log(`Frames (db/used): ${row.frame_count} / ${detFrames.length}`);
  console.log(`Camera angle:     ${String(cameraAngle)}`);
  console.log(`msPerFrame:       ${msPerFrame.toFixed(3)}  sustainFrames=${impact.sustainFrames}`);
  console.log(`footRef X:        ${impact.footRef == null ? "—" : impact.footRef.toFixed(4)}`);
  console.log(`Detector impact:  ${impact.frame == null ? "null (rise-never-triggered)" : impact.frame}`);
  console.log(`fallback_gate:    ${String(fallbackGate)}`);
  console.log(`phases detected:  ${(result.phases ?? []).length}`);
  console.log(`Candidate arc-bottom — leftWrist(lead)=${leftArcBottom}  rightWrist(trail)=${rightArcBottom}`);
  console.log(`Recompute matches pipeline: ${recomputeMatches ? "YES ✓" : "NO ✗ (diverged!)"}`);
  console.log(`\nWrote ${outPath}`);
}

// ---------------------------------------------------------------------------
// Self-contained HTML renderer — hand-rolled inline SVG, no external deps.
// ---------------------------------------------------------------------------

function renderHtml(d: ReturnType<typeof JSON.parse> extends never ? never : any): string {
  const json = JSON.stringify(d);
  // The chart-drawing JS is embedded as a string and runs in the browser.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Swing phase diagnostic — ${d.swingId}</title>
<style>
  :root { --bg:#0d0f12; --panel:#15181d; --ink:#e7eaee; --muted:#8b94a0; --grid:#262b33;
          --hand:#5AC8FA; --foot:#FF9F0A; --rise:#34c759; --thr:#FF3B30;
          --lead:#AF52DE; --trail:#FF8A3D; --ok:#34c759; --bad:#FF3B30; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  h2 { font-size:14px; color:var(--muted); margin:24px 0 6px; text-transform:uppercase; letter-spacing:.06em; }
  .meta { display:flex; flex-wrap:wrap; gap:8px 20px; background:var(--panel); padding:14px 18px; border-radius:10px; }
  .meta div { font-size:13px; }
  .meta b { color:var(--muted); font-weight:600; }
  .badge { display:inline-block; padding:2px 10px; border-radius:6px; font-weight:700; }
  .badge.ok { background:rgba(52,199,89,.18); color:var(--ok); }
  .badge.bad { background:rgba(255,59,48,.18); color:var(--bad); }
  .badge.warn { background:rgba(255,159,10,.18); color:var(--foot); }
  .chart { background:var(--panel); border-radius:10px; padding:10px 12px; margin-bottom:14px; }
  .legend { display:flex; gap:16px; flex-wrap:wrap; font-size:12px; color:var(--muted); margin:2px 0 6px; }
  .legend i { display:inline-block; width:12px; height:3px; vertical-align:middle; margin-right:5px; }
  .legend .sw { width:12px; height:12px; border-radius:2px; opacity:.35; }
  table { border-collapse:collapse; width:100%; background:var(--panel); border-radius:10px; overflow:hidden; }
  th,td { padding:8px 12px; text-align:left; border-bottom:1px solid var(--grid); font-size:13px; }
  th { color:var(--muted); font-weight:600; }
  td.null { color:var(--bad); font-weight:700; }
  .note { color:var(--muted); font-size:12px; margin:4px 0 0; }
  .flag { background:rgba(255,159,10,.10); border-left:3px solid var(--foot); padding:10px 14px; border-radius:6px; margin:10px 0; font-size:13px; }
</style>
</head>
<body>
<h1>Swing phase diagnostic</h1>
<div class="meta" id="meta"></div>

<div class="flag" id="leadflag"></div>

<h2>1 · Current impact signal (handAvg X vs footRef X)</h2>
<div class="chart"><div class="legend">
  <span><i style="background:var(--hand)"></i>handAvg X = (rightWrist.x+rightThumb.x)/2</span>
  <span><i style="background:var(--foot)"></i>footRef X</span>
  <span><span class="sw" style="background:var(--rise)"></span>rise-active (streak≥sustain)</span>
  <span><span class="sw" style="background:var(--foot)"></span>handAvg≥footRef</span>
  <span><i style="background:#fff"></i>wouldFire (both)</span>
</div><div id="c1"></div></div>

<h2>2 · riseRate = handAvg[F] − handAvg[F−${d.thresholds.riseLookbackFrames}]</h2>
<div class="chart"><div class="legend">
  <span><i style="background:var(--hand)"></i>riseRate</span>
  <span><i style="background:var(--thr)"></i>threshold ${d.thresholds.riseRateThreshold}</span>
  <span><span class="sw" style="background:var(--rise)"></span>riseRate &gt; threshold</span>
</div><div id="c2"></div></div>

<h2>3 · Candidate lead-wrist Y-arc (bottom = max y)</h2>
<div class="chart"><div class="legend">
  <span><i style="background:var(--lead)"></i>leftWrist.y (LEAD for RH)</span>
  <span><i style="background:var(--trail)"></i>rightWrist.y (TRAIL for RH; detector keys on this hand's X)</span>
  <span><i style="background:#fff"></i>arc-bottom (candidate impact)</span>
</div><div id="c3"></div></div>

<h2>4 · Pipeline result</h2>
<div id="result"></div>

<script id="data" type="application/json">${json}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const N = D.frameCountUsed;
const W = Math.max(900, Math.min(1600, N * 6));
const H = 220, PADL = 52, PADR = 16, PADT = 12, PADB = 26;

function fmt(v){ return (v==null||Number.isNaN(v)) ? '—' : (typeof v==='number'? v.toFixed(4): String(v)); }
function xPix(i){ return PADL + (i/(N-1||1))*(W-PADL-PADR); }

// generic line chart over frame index. series: [{data:[..], color, width}]; bands: [{flags:[bool], color}]
function chart(elId, series, bands, opts){
  opts = opts||{};
  let ymin = opts.ymin, ymax = opts.ymax;
  if (ymin==null||ymax==null){
    let lo=Infinity, hi=-Infinity;
    for(const s of series) for(const v of s.data){ if(v!=null){ if(v<lo)lo=v; if(v>hi)hi=v; } }
    if(opts.includeZero){ lo=Math.min(lo,0); hi=Math.max(hi,0); }
    if(!isFinite(lo)){ lo=0; hi=1; }
    const pad=(hi-lo)*0.08||0.01; ymin=lo-pad; ymax=hi+pad;
  }
  const yPix = v => PADT + (1-(v-ymin)/((ymax-ymin)||1))*(H-PADT-PADB);
  let svg = '<svg width="'+W+'" height="'+H+'" style="display:block">';
  // bands
  for(const b of (bands||[])){
    let i=0;
    while(i<N){
      if(b.flags[i]){ let j=i; while(j<N && b.flags[j]) j++;
        const x0=xPix(i), x1=xPix(Math.max(i,j-1));
        svg += '<rect x="'+x0+'" y="'+PADT+'" width="'+Math.max(1,x1-x0)+'" height="'+(H-PADT-PADB)+'" fill="'+b.color+'" opacity="0.18"/>';
        i=j;
      } else i++;
    }
  }
  // gridlines + y labels (3)
  for(let g=0; g<=2; g++){
    const v=ymin+(ymax-ymin)*g/2, y=yPix(v);
    svg += '<line x1="'+PADL+'" y1="'+y+'" x2="'+(W-PADR)+'" y2="'+y+'" stroke="var(--grid)"/>';
    svg += '<text x="'+(PADL-6)+'" y="'+(y+3)+'" fill="var(--muted)" font-size="10" text-anchor="end">'+v.toFixed(3)+'</text>';
  }
  // horizontal reference lines
  for(const h of (opts.hlines||[])){
    if(h.v==null) continue; const y=yPix(h.v);
    svg += '<line x1="'+PADL+'" y1="'+y+'" x2="'+(W-PADR)+'" y2="'+y+'" stroke="'+h.color+'" stroke-width="1.5" stroke-dasharray="5 4"/>';
  }
  // vertical markers
  for(const m of (opts.vmarks||[])){
    if(m.i==null) continue; const x=xPix(m.i);
    svg += '<line x1="'+x+'" y1="'+PADT+'" x2="'+x+'" y2="'+(H-PADB)+'" stroke="'+m.color+'" stroke-width="1.5"/>';
    svg += '<text x="'+(x+3)+'" y="'+(PADT+10)+'" fill="'+m.color+'" font-size="10">'+m.label+'</text>';
  }
  // series polylines (null-aware: break the line on gaps)
  for(const s of series){
    let dpath=''; let pen=false;
    for(let i=0;i<N;i++){ const v=s.data[i];
      if(v==null){ pen=false; continue; }
      dpath += (pen?'L':'M')+xPix(i).toFixed(1)+' '+yPix(v).toFixed(1)+' '; pen=true;
    }
    svg += '<path d="'+dpath+'" fill="none" stroke="'+s.color+'" stroke-width="'+(s.width||1.6)+'"/>';
  }
  // x axis ticks
  const step = Math.max(1, Math.round(N/12));
  for(let i=0;i<N;i+=step){
    svg += '<text x="'+xPix(i)+'" y="'+(H-8)+'" fill="var(--muted)" font-size="10" text-anchor="middle">'+i+'</text>';
  }
  svg += '</svg>';
  document.getElementById(elId).innerHTML = svg;
}

// --- meta header
const ok = D.recomputeMatches;
const angleWarn = (D.cameraAngle && D.cameraAngle!=='face_on');
document.getElementById('meta').innerHTML = [
  ['Swing', D.swingId],
  ['Created', D.createdAt],
  ['Handedness', D.handednessLabel],
  ['Frames (db/used)', D.frameCountDb+' / '+D.frameCountUsed],
  ['Camera angle', (angleWarn?'<span class="badge warn">':'')+String(D.cameraAngle)+(angleWarn?' ⚠ not face_on</span>':'')],
  ['msPerFrame', D.msPerFrame.toFixed(3)],
  ['sustainFrames', D.sustainFrames],
  ['footRef X', fmt(D.footRef)],
  ['Detector impact', D.detectorImpactFrame==null?'<span class="badge bad">null — rise-never-triggered</span>':D.detectorImpactFrame],
  ['fallback_gate', String(D.pipeline.fallbackGate)],
  ['Recompute match', ok?'<span class="badge ok">✓ matches pipeline</span>':'<span class="badge bad">✗ diverged — chart unreliable</span>'],
].map(([k,v])=>'<div><b>'+k+':</b> '+v+'</div>').join('');

// --- lead/trail flag
document.getElementById('leadflag').innerHTML =
  '⚠ <b>Lead vs trail wrist:</b> buildTrailPoints (analysisPipeline.ts:139-141) labels '+
  '<span style="color:var(--lead)">leftWrist = LEAD</span> / <span style="color:var(--trail)">rightWrist = TRAIL</span> '+
  '(post-canonical, RH+LH). The impact detector keys off <b>rightWrist</b> (the TRAIL hand, phaseDetectionFaceOn.ts:151). '+
  'For a right-handed golfer the LEAD hand is the left arm (leftWrist). Both Y-arcs are plotted below — judge which bottom is the real impact.';

// --- chart 1: handAvg X vs footRef X, with bands
chart('c1',
  [{data: D.handAvg, color:'var(--hand)', width:1.8}],
  [{flags: D.riseActive, color:'var(--rise)'}, {flags: D.aboveFoot, color:'var(--foot)'}],
  { hlines:[{v:D.footRef, color:'var(--foot)'}],
    vmarks: D.wouldFire.map((f,i)=>f?{i,color:'#fff',label:''}:null).filter(Boolean)
            .concat(D.detectorImpactFrame!=null?[{i:D.detectorImpactFrame,color:'#fff',label:'impact'}]:[]) });

// --- chart 2: riseRate vs threshold
chart('c2',
  [{data: D.riseRate, color:'var(--hand)', width:1.6}],
  [{flags: D.riseGate, color:'var(--rise)'}],
  { includeZero:true, hlines:[{v:D.thresholds.riseRateThreshold, color:'var(--thr)'}, {v:0, color:'var(--grid)'}] });

// --- chart 3: wrist Y arcs (y top-down; bottom=max y). Invert display so down is down.
(function(){
  const data=[D.leftWristY, D.rightWristY].flat().filter(v=>v!=null);
  let lo=Math.min(...data), hi=Math.max(...data); const pad=(hi-lo)*0.08||0.01;
  // invert: pass ymin>ymax so larger y renders lower
  chart('c3',
    [{data:D.leftWristY, color:'var(--lead)', width:1.8},
     {data:D.rightWristY, color:'var(--trail)', width:1.8}],
    [],
    { ymin:hi+pad, ymax:lo-pad,
      vmarks:[ D.leftArcBottom!=null?{i:D.leftArcBottom,color:'var(--lead)',label:'lead bottom '+D.leftArcBottom}:null,
               D.rightArcBottom!=null?{i:D.rightArcBottom,color:'var(--trail)',label:'trail bottom '+D.rightArcBottom}:null
             ].filter(Boolean) });
})();

// --- result table
const phases = D.pipeline.phases||[];
const rel = D.pipeline.phaseReliability||{};
let rows = '<table><tr><th>Phase</th><th>Frame index</th><th>Reliability</th></tr>';
if(phases.length===0){
  rows += '<tr><td class="null">none</td><td class="null">— (phases=[])</td><td class="null">fallback_gate: '+String(D.pipeline.fallbackGate)+'</td></tr>';
} else {
  for(const p of phases){
    const r = rel[p.phase] ?? rel[p.phase+'_'] ?? '—';
    const bad = (r==null||r==='low');
    rows += '<tr><td>'+p.phase+'</td><td>'+p.index+'</td><td'+(bad?' class="null"':'')+'>'+String(r)+'</td></tr>';
  }
}
// also show raw reliability object for phases that produced no DetectedPhase
rows += '</table>';
let extra = '<p class="note">phase_rules.reliability (raw): '+JSON.stringify(rel)+'</p>'+
           '<p class="note">tempo: '+(D.pipeline.tempo?JSON.stringify(D.pipeline.tempo):'null')+
           ' · score: '+String(D.pipeline.score)+'</p>';
document.getElementById('result').innerHTML = rows + extra;
</script>
</body>
</html>`;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
