/**
 * hand-keypoint-chart.ts — Standalone, offline HTML chart of selected RTMW
 * hand keypoints (133-kp pose_full, COCO-WholeBody indices) for one swing:
 * raw PIXEL x/y traces across the full capture, with phase markers,
 * per-keypoint toggles, and per-keypoint avg/min confidence in the legend.
 *
 * Usage:
 *   npx --yes tsx scripts/hand-keypoint-chart.ts [swingId] [startFrame] [endFrame]
 *
 * Defaults to the latest face_on swing at time of writing (c876728a…).
 * Numeric leading args are treated as the frame window (swingId optional).
 * The window is a VIEW — full data arrays stay embedded; traces simply
 * render across the windowed axis. Non-default windows are reflected in
 * the filename (hands-<id8>-f<start>-<end>.html).
 * Phases come from the DB `phases` column, so any swing id works.
 *
 * Read-only on the DB (single SELECT). Env loader cloned from
 * scripts/motion-chart.ts. Output: scripts/output/hands-<id8>.html —
 * fully self-contained (inline data + hand-drawn SVG, no external libs).
 *
 * Axis convention (deliberate, labeled in the chart):
 *   - Value axis is RAW PIXELS, image convention: 0 = top of frame, rendered
 *     at the top of the panel. Values are NOT numerically inverted.
 */

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SWING_ID = "c876728a-fa0d-4455-836e-09600deb23c8";

/** COCO-WholeBody indices to plot, grouped by hand role. */
const KEYPOINTS: Array<{ idx: number; name: string; group: "TRAIL (right) hand" | "LEAD (left) hand" }> = [
  { idx: 120, name: "R forefinger tip", group: "TRAIL (right) hand" },
  { idx: 119, name: "R forefinger DIP", group: "TRAIL (right) hand" },
  { idx: 116, name: "R thumb tip", group: "TRAIL (right) hand" },
  { idx: 115, name: "R thumb IP", group: "TRAIL (right) hand" },
  { idx: 123, name: "R middle DIP", group: "TRAIL (right) hand" },
  { idx: 127, name: "R ring DIP", group: "TRAIL (right) hand" },
  { idx: 96, name: "L forefinger MCP", group: "LEAD (left) hand" },
  { idx: 100, name: "L middle MCP", group: "LEAD (left) hand" },
  { idx: 104, name: "L ring MCP", group: "LEAD (left) hand" },
];

// ---------------------------------------------------------------------------
// .env loader (mirrors scripts/motion-chart.ts)
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

type RawKeypoint = { x: number; y: number; confidence: number } | null | undefined;
type PoseFullFrame = {
  keypoints: RawKeypoint[];
  frameWidth?: number;
  frameHeight?: number;
  timestampMs?: number;
};
type PhaseRow = { index: number; phase: string };

type KpSeries = {
  x: (number | null)[];
  y: (number | null)[];
  c: (number | null)[];
  avgC: number | null;
  minC: number | null;
};

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function buildSeries(frames: PoseFullFrame[], idx: number): KpSeries {
  const x: (number | null)[] = [];
  const y: (number | null)[] = [];
  const c: (number | null)[] = [];
  let sumC = 0;
  let nC = 0;
  let minC = Infinity;
  for (const f of frames) {
    const kp = f.keypoints?.[idx];
    if (kp && Number.isFinite(kp.x) && Number.isFinite(kp.y)) {
      x.push(r1(kp.x));
      y.push(r1(kp.y));
      const conf = Number.isFinite(kp.confidence) ? kp.confidence : null;
      c.push(conf === null ? null : r3(conf));
      if (conf !== null) {
        sumC += conf;
        nC++;
        if (conf < minC) minC = conf;
      }
    } else {
      x.push(null);
      y.push(null);
      c.push(null);
    }
  }
  return {
    x, y, c,
    avgC: nC > 0 ? r3(sumC / nC) : null,
    minC: nC > 0 ? r3(minC) : null,
  };
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function buildHtml(payload: unknown, swingId: string): string {
  const dataJson = JSON.stringify(payload);
  // Note: template uses no backticks inside the inline script to keep this
  // outer template literal simple.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hand keypoints — swing ${swingId.slice(0, 8)}</title>
<style>
  body { font: 13px -apple-system, "Segoe UI", sans-serif; margin: 16px; background: #16181d; color: #d7dae0; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  .sub { color: #8b93a1; margin-bottom: 10px; }
  .groups { display: flex; gap: 40px; flex-wrap: wrap; margin-bottom: 10px; }
  .groupTitle { font-weight: 600; margin: 6px 0 4px; }
  .legend label { cursor: pointer; white-space: nowrap; display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  .swatch { display: inline-block; width: 18px; height: 4px; border-radius: 2px; }
  .conf { color: #8b93a1; }
  .confBad { color: #e0707a; }
  .panelTitle { font-weight: 600; margin: 14px 0 2px; }
  .axisNote { color: #8b93a1; font-size: 12px; margin-bottom: 4px; }
  svg { background: #1d2026; border: 1px solid #2c313a; border-radius: 6px; display: block; }
  .readout { color: #aab2c0; font-size: 12px; margin-top: 2px; min-height: 32px; }
</style>
</head>
<body>
<h1>Swing ${swingId.slice(0, 8)} — hand keypoints (pose_full, raw pixels)</h1>
<div class="sub" id="meta"></div>
<div class="groups" id="groups"></div>

<div class="panelTitle">Position — solid = x, dashed = y (raw pixels)</div>
<div class="axisNote">value axis: 0 = top of frame &#9650; (image convention &mdash; values are raw pixels, not inverted)</div>
<svg id="posSvg" width="1180" height="520"></svg>
<div class="readout" id="posReadout"></div>

<script>
const DATA = ${dataJson};

const M = { l: 54, r: 14, t: 10, b: 22 };
const enabled = new Set(DATA.meta.keypoints.map(function (k) { return k.idx; }));

// ---- colors: lead (left) = warm, trail (right) = cool (mirrors motion-chart) ----
const PALETTE = {};
(function () {
  let warm = 0, cool = 0;
  DATA.meta.keypoints.forEach(function (k) {
    if (k.group.indexOf("LEAD") === 0) {
      PALETTE[k.idx] = "hsl(" + (warm * 24) + ", 82%, 60%)";   // reds -> oranges -> yellows
      warm++;
    } else {
      PALETTE[k.idx] = "hsl(" + (190 + cool * 16) + ", 78%, 62%)"; // blues -> teals -> violets
      cool++;
    }
  });
})();
function colorFor(idx) { return PALETTE[idx]; }

// ---- grouped legend with per-keypoint toggle + avg/min confidence ----
const groupsEl = document.getElementById("groups");
const groupDivs = {};
DATA.meta.keypoints.forEach(function (k) {
  if (!groupDivs[k.group]) {
    const div = document.createElement("div");
    div.className = "legend";
    const title = document.createElement("div");
    title.className = "groupTitle";
    title.textContent = k.group;
    div.appendChild(title);
    groupsEl.appendChild(div);
    groupDivs[k.group] = div;
  }
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = true;
  cb.addEventListener("change", function () {
    if (cb.checked) enabled.add(k.idx); else enabled.delete(k.idx);
    drawPos();
  });
  const sw = document.createElement("span");
  sw.className = "swatch"; sw.style.background = colorFor(k.idx);
  const s = DATA.series[k.idx];
  const confSpan = document.createElement("span");
  confSpan.className = (s.minC != null && s.minC < 0.5) ? "conf confBad" : "conf";
  confSpan.textContent = s.avgC == null
    ? "(no conf)"
    : "avg " + s.avgC.toFixed(3) + " / min " + s.minC.toFixed(3);
  label.appendChild(cb); label.appendChild(sw);
  label.appendChild(document.createTextNode(k.idx + " " + k.name + " "));
  label.appendChild(confSpan);
  groupDivs[k.group].appendChild(label);
});

const meta = DATA.meta;
document.getElementById("meta").textContent =
  meta.id + " · " + meta.frames + " frames · window [" + meta.viewStart + ", " + meta.viewEnd + "] · " +
  meta.frameWidth + "x" + meta.frameHeight +
  " · camera " + meta.camera + " · phases: " +
  meta.phases.map(function (p) { return p[1] + " " + p[0]; }).join(", ");

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
  meta.phases.forEach(function (p, k) {
    if (p[0] < VS || p[0] > VE) return; // only markers inside the window
    const x = frameX(p[0], w);
    svg.appendChild(svgEl("line", { x1: x, y1: M.t, x2: x, y2: h - M.b, stroke: "#5a6272", "stroke-dasharray": "3,4" }));
    const t = svgEl("text", { x: x + 3, y: M.t + 11 + (k % 3) * 12, fill: "#8b93a1", "font-size": "10" });
    t.textContent = p[1] + " " + p[0];
    svg.appendChild(t);
  });
}

function drawFrameAxis(svg, h, w) {
  const span = VE - VS;
  const step = span <= 15 ? 1 : span <= 30 ? 2 : span <= 60 ? 5 : span <= 150 ? 10 : 20;
  for (let f = Math.ceil(VS / step) * step; f <= VE; f += step) {
    const x = frameX(f, w);
    const t = svgEl("text", { x: x, y: h - 6, fill: "#6b7280", "font-size": "10", "text-anchor": "middle" });
    t.textContent = f;
    svg.appendChild(t);
  }
}

// ---- position panel: pixel axis, 0 (top of image) rendered at top ----
function drawPos() {
  const svg = document.getElementById("posSvg");
  clear(svg);
  const w = svg.width.baseVal.value, h = svg.height.baseVal.value;

  // Auto-scale to the enabled keypoints' x/y extent INSIDE the window, padded.
  let lo = Infinity, hi = -Infinity;
  enabled.forEach(function (idx) {
    const s = DATA.series[idx];
    for (let i = VS; i <= VE; i++) {
      [s.x[i], s.y[i]].forEach(function (v) {
        if (v == null) return;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      });
    }
  });
  if (!isFinite(lo)) { lo = 0; hi = meta.frameHeight; }
  const pad = Math.max(20, (hi - lo) * 0.05);
  lo = Math.max(0, lo - pad);
  hi = hi + pad;

  // Image convention: smaller pixel value (closer to top of frame) at top.
  const valToPx = function (v) { return M.t + ((v - lo) / (hi - lo)) * (h - M.t - M.b); };

  // Gridlines at ~6 round-pixel steps.
  const rawStep = (hi - lo) / 6;
  const mag = Math.pow(10, Math.floor(Math.log(rawStep) / Math.LN10));
  const step = Math.ceil(rawStep / mag) * mag;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    const y = valToPx(v);
    svg.appendChild(svgEl("line", { x1: M.l, y1: y, x2: w - M.r, y2: y, stroke: "#262b33" }));
    const t = svgEl("text", { x: M.l - 6, y: y + 3, fill: "#6b7280", "font-size": "10", "text-anchor": "end" });
    t.textContent = Math.round(v) + "px";
    svg.appendChild(t);
  }

  drawPhases(svg, h, w);
  drawFrameAxis(svg, h, w);

  DATA.meta.keypoints.forEach(function (k) {
    if (!enabled.has(k.idx)) return;
    const s = DATA.series[k.idx];
    const col = colorFor(k.idx);
    svg.appendChild(svgEl("path", { d: pathFor(s.x, valToPx, w), fill: "none", stroke: col, "stroke-width": 1.4 }));
    svg.appendChild(svgEl("path", { d: pathFor(s.y, valToPx, w), fill: "none", stroke: col, "stroke-width": 1.4, "stroke-dasharray": "5,3", opacity: 0.85 }));
  });

  hookReadout(svg, "posReadout", function (i) {
    let s = "frame " + i;
    DATA.meta.keypoints.forEach(function (k) {
      if (!enabled.has(k.idx)) return;
      const d = DATA.series[k.idx];
      s += "  |  " + k.idx + " " + k.name + " x=" + fmt(d.x[i], 1) + " y=" + fmt(d.y[i], 1) + " c=" + fmt(d.c[i], 3);
    });
    return s;
  });
}

function fmt(v, dp) { return v == null ? "–" : v.toFixed(dp); }

function hookReadout(svg, outId, build) {
  svg.onmousemove = function (ev) {
    const rect = svg.getBoundingClientRect();
    const w = svg.width.baseVal.value;
    const rel = (ev.clientX - rect.left - M.l) / (w - M.l - M.r);
    const i = Math.max(VS, Math.min(VE, VS + Math.round(rel * (VE - VS))));
    document.getElementById(outId).textContent = build(i);
  };
}

drawPos();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Args: numeric leading args are the frame window; a non-numeric arg is the swing id.
  const rest = process.argv.slice(2);
  const swingId = rest.length > 0 && !/^\d+$/.test(rest[0]) ? rest.shift()! : DEFAULT_SWING_ID;
  const argStart = rest[0] !== undefined ? Number(rest[0]) : 0;
  const argEnd = rest[1] !== undefined ? Number(rest[1]) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(argStart) || Number.isNaN(argEnd)) {
    console.error("[hand-keypoint-chart] startFrame/endFrame must be numbers. Usage: hand-keypoint-chart.ts [swingId] [startFrame] [endFrame]");
    process.exit(1);
  }

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("[hand-keypoint-chart] Missing EXPO_PUBLIC_SUPABASE_URL or key in .env");
    process.exit(1);
  }
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await sb
    .from("swings")
    .select("pose_full, phases, swing_debug")
    .eq("id", swingId)
    .maybeSingle();
  if (error) { console.error("Supabase error:", error.message); process.exit(1); }

  const row = data as {
    pose_full: PoseFullFrame[] | null;
    phases: PhaseRow[] | null;
    swing_debug?: { camera_angle?: string } | null;
  } | null;

  const frames = row?.pose_full;
  if (!frames || frames.length === 0) {
    console.error("pose_full empty for " + swingId);
    process.exit(1);
  }
  const camera = row?.swing_debug?.camera_angle ?? "?";
  const phases: Array<[number, string]> = (row?.phases ?? [])
    .filter((p) => typeof p?.index === "number" && typeof p?.phase === "string")
    .map((p) => [p.index, p.phase]);

  // Frame window (a view; full arrays stay embedded), clamped to [0, frames-1].
  const lastFrame = frames.length - 1;
  const viewStart = Math.max(0, Math.min(lastFrame, Math.floor(argStart)));
  const viewEnd = Math.max(0, Math.min(lastFrame, Math.floor(argEnd)));
  if (viewStart >= viewEnd) {
    console.error(`[hand-keypoint-chart] startFrame (${viewStart}) must be < endFrame (${viewEnd}) after clamping to [0, ${lastFrame}]`);
    process.exit(1);
  }

  const series: Record<number, KpSeries> = {};
  for (const kp of KEYPOINTS) {
    series[kp.idx] = buildSeries(frames, kp.idx);
  }

  const payload = {
    meta: {
      id: swingId,
      frames: frames.length,
      frameWidth: frames[0].frameWidth ?? null,
      frameHeight: frames[0].frameHeight ?? null,
      camera,
      phases,
      keypoints: KEYPOINTS,
      viewStart,
      viewEnd,
    },
    series,
  };

  const outDir = join(REPO_ROOT, "scripts", "output");
  mkdirSync(outDir, { recursive: true });
  const isFullRange = viewStart === 0 && viewEnd === lastFrame;
  const windowSuffix = isFullRange ? "" : `-f${viewStart}-${viewEnd}`;
  const outPath = join(outDir, "hands-" + swingId.slice(0, 8) + windowSuffix + ".html");
  writeFileSync(outPath, buildHtml(payload, swingId));

  console.log("[hand-keypoint-chart] swing " + swingId + " · " + frames.length + " frames · camera " + camera + " · window [" + viewStart + ", " + viewEnd + "]");
  console.log("[hand-keypoint-chart] phases: " + phases.map(([i, p]) => `${p} ${i}`).join(" / "));
  for (const kp of KEYPOINTS) {
    const s = series[kp.idx];
    console.log(
      `  ${String(kp.idx).padStart(3)} ${kp.name.padEnd(17)} avgC=${s.avgC?.toFixed(3) ?? "–"} minC=${s.minC?.toFixed(3) ?? "–"}`,
    );
  }
  console.log(outPath);
}

main();
