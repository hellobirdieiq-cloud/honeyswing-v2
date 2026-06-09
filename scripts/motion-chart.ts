/**
 * motion-chart.ts — Generate a standalone, offline HTML motion chart for one
 * swing: per-joint position (x/y) and velocity (dx/dy) traces across the full
 * capture, with phase markers, per-joint toggles, and a raw vs
 * identity-corrected dataset toggle.
 *
 * Usage:
 *   npx --yes tsx scripts/motion-chart.ts [startFrame] [endFrame]
 *
 * Optional frame window zooms the X axis to [startFrame, endFrame] (defaults:
 * full swing). The window is a VIEW — full data arrays stay embedded; traces
 * simply render across the windowed axis. Non-default windows are reflected
 * in the filename (motion-<id8>-f<start>-<end>.html).
 *
 * Read-only on the DB (single SELECT). Env loader cloned from
 * scripts/identity-validate.ts. Output: scripts/output/motion-<id8>.html —
 * fully self-contained (inline data + hand-drawn SVG, no external libs).
 *
 * Axis conventions (deliberate, labeled in the chart):
 *   - Position panel value axis runs 0 (top) → 1 (bottom) — image/pose
 *     convention — so the body renders upright (head high, ankles low).
 *     Values are NOT numerically inverted; what you read is the raw data.
 *   - Velocity: dy > 0 = moving DOWN in the frame.
 */

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { JointName, PoseFrame } from "../packages/pose/PoseTypes";
import { correctLowerBodyIdentity } from "../packages/domain/swing/lowerBodyIdentity";

const SWING_ID = "c876728a-fa0d-4455-836e-09600deb23c8";

/** User-supplied phase boundaries for this swing (frame indices). */
const PHASES: Array<[number, string]> = [
  [52, "address"],
  [76, "takeaway"],
  [112, "top"],
  [116, "downswing"],
  [126, "impact"],
  [148, "follow_through"],
];

const DEFAULT_ON: string[] = [
  "leftWrist", "rightWrist",
  "leftKnee", "rightKnee",
  "leftAnkle", "rightAnkle",
  "leftHeel", "rightHeel",
  "leftFootIndex", "rightFootIndex",
];

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/identity-validate.ts)
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
// Dataset construction
// ---------------------------------------------------------------------------

type JointSeries = {
  x: (number | null)[];
  y: (number | null)[];
  z: (number | null)[];
  c: (number | null)[];
  dx: (number | null)[];
  dy: (number | null)[];
};

function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Union of joint keys across ALL frames — persisted JSON omits undefined
 * joints, and the present set can vary frame to frame.
 */
function enumerateJoints(frames: PoseFrame[]): string[] {
  const keys = new Set<string>();
  for (const f of frames) {
    for (const [name, j] of Object.entries(f.joints)) {
      if (j) keys.add(name);
    }
  }
  return [...keys].sort();
}

function buildDataset(frames: PoseFrame[], jointNames: string[]): Record<string, JointSeries> {
  const out: Record<string, JointSeries> = {};
  for (const name of jointNames) {
    const x: (number | null)[] = [];
    const y: (number | null)[] = [];
    const z: (number | null)[] = [];
    const c: (number | null)[] = [];
    const dx: (number | null)[] = [];
    const dy: (number | null)[] = [];
    for (let i = 0; i < frames.length; i++) {
      const j = frames[i].joints[name as JointName];
      x.push(j ? r4(j.x) : null);
      y.push(j ? r4(j.y) : null);
      z.push(j && j.z !== undefined ? r4(j.z) : null);
      c.push(j && j.confidence !== undefined ? r4(j.confidence) : null);
      if (i === 0) {
        // Frame 0 velocity = 0 by spec.
        dx.push(0);
        dy.push(0);
      } else {
        const xi = x[i];
        const xp = x[i - 1];
        const yi = y[i];
        const yp = y[i - 1];
        dx.push(xi != null && xp != null ? r4(xi - xp) : null);
        dy.push(yi != null && yp != null ? r4(yi - yp) : null);
      }
    }
    out[name] = { x, y, z, c, dx, dy };
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function buildHtml(payload: unknown): string {
  const dataJson = JSON.stringify(payload);
  // Note: template uses no backticks inside the inline script to keep this
  // outer template literal simple.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Motion chart — swing ${SWING_ID.slice(0, 8)}</title>
<style>
  body { font: 13px -apple-system, "Segoe UI", sans-serif; margin: 16px; background: #16181d; color: #d7dae0; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  .sub { color: #8b93a1; margin-bottom: 10px; }
  .controls { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 10px; }
  .dsToggle label { margin-right: 12px; cursor: pointer; }
  .legend { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 2px 14px; max-width: 1180px; }
  .legend label { cursor: pointer; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  .swatch { display: inline-block; width: 18px; height: 4px; border-radius: 2px; }
  .panelTitle { font-weight: 600; margin: 14px 0 2px; }
  .axisNote { color: #8b93a1; font-size: 12px; margin-bottom: 4px; }
  svg { background: #1d2026; border: 1px solid #2c313a; border-radius: 6px; display: block; }
  .readout { color: #aab2c0; font-size: 12px; margin-top: 2px; min-height: 16px; }
</style>
</head>
<body>
<h1>Swing ${SWING_ID.slice(0, 8)} — per-joint motion</h1>
<div class="sub" id="meta"></div>
<div class="controls">
  <div class="dsToggle">
    <strong>Dataset:</strong>
    <label><input type="radio" name="ds" value="raw" checked> raw (as persisted)</label>
    <label><input type="radio" name="ds" value="corrected"> identity-corrected</label>
  </div>
</div>
<div class="legend" id="legend"></div>

<div class="panelTitle">Position — solid = x, dashed = y</div>
<div class="axisNote">value axis: 0 = top of frame &#9650; &hellip; 1 = ground &#9660; (image/pose convention &mdash; body renders upright; values are raw, not inverted)</div>
<svg id="posSvg" width="1180" height="430"></svg>
<div class="readout" id="posReadout"></div>

<div class="panelTitle">Velocity — solid = dx, dashed = dy (normalized units/frame)</div>
<div class="axisNote">dy &gt; 0 = moving DOWN in the frame; dx &gt; 0 = moving right</div>
<svg id="velSvg" width="1180" height="320"></svg>
<div class="readout" id="velReadout"></div>

<script>
const DATA = ${dataJson};

const M = { l: 46, r: 14, t: 10, b: 22 };
const enabled = new Set(DATA.meta.defaultOn.filter(function (j) { return DATA.meta.joints.indexOf(j) >= 0; }));
let activeDs = "raw";

// ---- colors: bilateral pairs share an index; left = warm, right = cool ----
function pairInfo(name) {
  if (name.indexOf("left") === 0) return { side: "L", base: name.slice(4) };
  if (name.indexOf("right") === 0) return { side: "R", base: name.slice(5) };
  return { side: null, base: name };
}
const baseIndex = {};
(function () {
  let idx = 0;
  DATA.meta.joints.forEach(function (j) {
    const p = pairInfo(j);
    if (p.side && baseIndex[p.base] === undefined) baseIndex[p.base] = idx++;
  });
})();
let neutralIdx = 0;
const neutralColors = {};
function colorFor(name) {
  const p = pairInfo(name);
  if (p.side === "L") return "hsl(" + ((baseIndex[p.base] * 27) % 70) + ", 80%, 58%)";        // warm: reds->oranges->yellows
  if (p.side === "R") return "hsl(" + (195 + ((baseIndex[p.base] * 22) % 70)) + ", 75%, 60%)"; // cool: blues->teals->violets
  if (!neutralColors[name]) { neutralColors[name] = "hsl(120, 12%, " + (45 + (neutralIdx++ * 7) % 30) + "%)"; }
  return neutralColors[name];
}

// ---- legend / toggles ----
const legend = document.getElementById("legend");
DATA.meta.joints.forEach(function (j) {
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = enabled.has(j); cb.dataset.joint = j;
  cb.addEventListener("change", function () {
    if (cb.checked) enabled.add(j); else enabled.delete(j);
    drawAll();
  });
  const sw = document.createElement("span");
  sw.className = "swatch"; sw.style.background = colorFor(j);
  label.appendChild(cb); label.appendChild(sw); label.appendChild(document.createTextNode(j));
  legend.appendChild(label);
});
document.querySelectorAll('input[name="ds"]').forEach(function (r) {
  r.addEventListener("change", function () { activeDs = r.value; drawAll(); });
});

const meta = DATA.meta;
document.getElementById("meta").textContent =
  meta.frames + " frames · window [" + meta.viewStart + ", " + meta.viewEnd + "] · camera " + meta.camera + " · identity: " + meta.identity.swapped +
  " swapped frame(s), baselineSign " + meta.identity.baselineSign +
  " (margin " + meta.identity.marginTally + "/" + meta.identity.marginVotes + ")";

// ---- drawing helpers ----
function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
function clear(svg) { while (svg.firstChild) svg.removeChild(svg.firstChild); }

// Frame window (a VIEW over the full embedded arrays — not a re-slice).
const VS = meta.viewStart, VE = meta.viewEnd;

function frameX(i, w) {
  return M.l + ((i - VS) / (VE - VS)) * (w - M.l - M.r);
}

function pathFor(series, valToPx, w) {
  let d = "", pen = false;
  for (let i = VS; i <= VE; i++) {
    const v = series[i];
    if (v == null) { pen = false; continue; }
    const px = frameX(i, w), py = valToPx(v);
    d += (pen ? "L" : "M") + px.toFixed(1) + "," + py.toFixed(1);
    pen = true;
  }
  return d;
}

function drawPhases(svg, h, w) {
  PHASES_JS.forEach(function (p, k) {
    if (p[0] < VS || p[0] > VE) return; // only markers inside the window
    const x = frameX(p[0], w);
    svg.appendChild(svgEl("line", { x1: x, y1: M.t, x2: x, y2: h - M.b, stroke: "#5a6272", "stroke-dasharray": "3,4" }));
    const t = svgEl("text", { x: x + 3, y: M.t + 11 + (k % 3) * 12, fill: "#8b93a1", "font-size": "10" });
    t.textContent = p[1] + " " + p[0];
    svg.appendChild(t);
  });
}
const PHASES_JS = ${JSON.stringify(PHASES)};

function drawFrameAxis(svg, h, w) {
  const span = VE - VS;
  const step = span <= 30 ? 2 : span <= 60 ? 5 : span <= 150 ? 10 : 20;
  for (let f = Math.ceil(VS / step) * step; f <= VE; f += step) {
    const x = frameX(f, w);
    const t = svgEl("text", { x: x, y: h - 6, fill: "#6b7280", "font-size": "10", "text-anchor": "middle" });
    t.textContent = f;
    svg.appendChild(t);
  }
}

// ---- position panel: value axis 0 (top) -> 1 (bottom), image convention ----
function drawPos() {
  const svg = document.getElementById("posSvg");
  clear(svg);
  const w = svg.width.baseVal.value, h = svg.height.baseVal.value;
  const valToPx = function (v) { return M.t + v * (h - M.t - M.b); }; // 0=top, 1=bottom — renders body upright
  [0, 0.25, 0.5, 0.75, 1].forEach(function (v) {
    const y = valToPx(v);
    svg.appendChild(svgEl("line", { x1: M.l, y1: y, x2: w - M.r, y2: y, stroke: "#262b33" }));
    const t = svgEl("text", { x: M.l - 6, y: y + 3, fill: "#6b7280", "font-size": "10", "text-anchor": "end" });
    t.textContent = v.toFixed(2);
    svg.appendChild(t);
  });
  drawPhases(svg, h, w);
  drawFrameAxis(svg, h, w);
  const ds = DATA[activeDs];
  enabled.forEach(function (j) {
    const col = colorFor(j);
    svg.appendChild(svgEl("path", { d: pathFor(ds[j].x, valToPx, w), fill: "none", stroke: col, "stroke-width": 1.4 }));
    svg.appendChild(svgEl("path", { d: pathFor(ds[j].y, valToPx, w), fill: "none", stroke: col, "stroke-width": 1.4, "stroke-dasharray": "5,3", opacity: 0.85 }));
  });
  hookReadout(svg, "posReadout", function (i) {
    let s = "frame " + i;
    enabled.forEach(function (j) {
      const d = DATA[activeDs][j];
      s += "  |  " + j + " x=" + fmt(d.x[i]) + " y=" + fmt(d.y[i]) + " c=" + fmt(d.c[i]);
    });
    return s;
  });
}

// ---- velocity panel: symmetric scale from enabled joints ----
function drawVel() {
  const svg = document.getElementById("velSvg");
  clear(svg);
  const w = svg.width.baseVal.value, h = svg.height.baseVal.value;
  const ds = DATA[activeDs];
  let maxV = 0.02;
  enabled.forEach(function (j) {
    ds[j].dx.concat(ds[j].dy).forEach(function (v) { if (v != null && Math.abs(v) > maxV) maxV = Math.abs(v); });
  });
  const valToPx = function (v) { return M.t + (1 - (v + maxV) / (2 * maxV)) * (h - M.t - M.b); };
  [-maxV, -maxV / 2, 0, maxV / 2, maxV].forEach(function (v) {
    const y = valToPx(v);
    svg.appendChild(svgEl("line", { x1: M.l, y1: y, x2: w - M.r, y2: y, stroke: v === 0 ? "#3a4150" : "#262b33" }));
    const t = svgEl("text", { x: M.l - 6, y: y + 3, fill: "#6b7280", "font-size": "10", "text-anchor": "end" });
    t.textContent = v.toFixed(3);
    svg.appendChild(t);
  });
  drawPhases(svg, h, w);
  drawFrameAxis(svg, h, w);
  enabled.forEach(function (j) {
    const col = colorFor(j);
    svg.appendChild(svgEl("path", { d: pathFor(ds[j].dx, valToPx, w), fill: "none", stroke: col, "stroke-width": 1.2 }));
    svg.appendChild(svgEl("path", { d: pathFor(ds[j].dy, valToPx, w), fill: "none", stroke: col, "stroke-width": 1.2, "stroke-dasharray": "5,3", opacity: 0.85 }));
  });
  hookReadout(svg, "velReadout", function (i) {
    let s = "frame " + i;
    enabled.forEach(function (j) {
      const d = DATA[activeDs][j];
      s += "  |  " + j + " dx=" + fmt(d.dx[i]) + " dy=" + fmt(d.dy[i]);
    });
    return s;
  });
}

function fmt(v) { return v == null ? "–" : v.toFixed(3); }

function hookReadout(svg, outId, build) {
  svg.onmousemove = function (ev) {
    const rect = svg.getBoundingClientRect();
    const w = svg.width.baseVal.value;
    const rel = (ev.clientX - rect.left - M.l) / (w - M.l - M.r);
    const i = Math.max(VS, Math.min(VE, VS + Math.round(rel * (VE - VS))));
    document.getElementById(outId).textContent = build(i);
  };
}

function drawAll() { drawPos(); drawVel(); }
drawAll();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("[motion-chart] Missing EXPO_PUBLIC_SUPABASE_URL or key in .env");
    process.exit(1);
  }
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await sb
    .from("swings")
    .select("motion_frames, swing_debug")
    .eq("id", SWING_ID)
    .maybeSingle();
  if (error) { console.error("Supabase error:", error.message); process.exit(1); }
  const raw = (data as { motion_frames: PoseFrame[] | null } | null)?.motion_frames;
  if (!raw || raw.length === 0) { console.error("motion_frames empty for " + SWING_ID); process.exit(1); }
  const camera =
    ((data as { swing_debug?: { camera_angle?: string } | null })?.swing_debug?.camera_angle) ?? "?";

  // Optional frame window: [startFrame] [endFrame], clamped to [0, frames-1].
  const lastFrame = raw.length - 1;
  const argStart = process.argv[2] !== undefined ? Number(process.argv[2]) : 0;
  const argEnd = process.argv[3] !== undefined ? Number(process.argv[3]) : lastFrame;
  if (!Number.isFinite(argStart) || !Number.isFinite(argEnd)) {
    console.error("[motion-chart] startFrame/endFrame must be numbers. Usage: motion-chart.ts [startFrame] [endFrame]");
    process.exit(1);
  }
  const viewStart = Math.max(0, Math.min(lastFrame, Math.floor(argStart)));
  const viewEnd = Math.max(0, Math.min(lastFrame, Math.floor(argEnd)));
  if (viewStart >= viewEnd) {
    console.error(`[motion-chart] startFrame (${viewStart}) must be < endFrame (${viewEnd}) after clamping to [0, ${lastFrame}]`);
    process.exit(1);
  }

  const identity = correctLowerBodyIdentity(raw);
  const jointNames = enumerateJoints(raw);

  const payload = {
    meta: {
      id: SWING_ID,
      frames: raw.length,
      camera,
      joints: jointNames,
      defaultOn: DEFAULT_ON,
      viewStart,
      viewEnd,
      identity: {
        swapped: identity.swappedFrames.length,
        baselineSign: identity.baselineSign,
        marginTally: identity.baselineMargin?.tally ?? null,
        marginVotes: identity.baselineMargin?.votes ?? null,
      },
    },
    raw: buildDataset(raw, jointNames),
    corrected: buildDataset(identity.frames, jointNames),
  };

  const outDir = join(REPO_ROOT, "scripts", "output");
  mkdirSync(outDir, { recursive: true });
  const isFullRange = viewStart === 0 && viewEnd === lastFrame;
  const windowSuffix = isFullRange ? "" : `-f${viewStart}-${viewEnd}`;
  const outPath = join(outDir, "motion-" + SWING_ID.slice(0, 8) + windowSuffix + ".html");
  writeFileSync(outPath, buildHtml(payload));
  console.log(
    "[motion-chart] " + raw.length + " frames, " + jointNames.length + " joints, " +
    identity.swappedFrames.length + " identity swaps, window [" + viewStart + ", " + viewEnd + "]");
  console.log(outPath);
}

main();
