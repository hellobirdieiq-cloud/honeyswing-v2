#!/usr/bin/env node
// scripts/swing_chart.mjs
// Live Supabase fetch → static HTML chart for one swing.
// Signal computation is copied verbatim from app/clinic/coach-mode/tab4Signals.ts.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const SWING_ID = '4f47a66d-c401-4a7b-bc1c-502dcb3b047f';

const PHASE_COLORS = {
  address:   '#6E6E73',
  takeaway:  '#5AC8FA',
  top:       '#AF52DE',
  downswing: '#FF9F0A',
  impact:    '#FF3B30',
  finish:    '#34C759',
};

function parseEnv(path) {
  const text = readFileSync(path, 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}

function mapDbPhaseToClinic(p) {
  return p === 'follow_through' ? 'finish' : p;
}

function convertPhasesToRanges(detected, totalFrameCount) {
  if (!detected || detected.length === 0) return [];
  const sorted = [...detected].sort((a, b) => a.index - b.index);
  const seen = new Set();
  const deduped = [];
  for (const p of sorted) {
    const tag = mapDbPhaseToClinic(p.phase);
    if (seen.has(tag)) continue;
    seen.add(tag);
    deduped.push(p);
  }
  const ranges = [];
  for (let i = 0; i < deduped.length; i++) {
    const start = deduped[i].index;
    const end = i + 1 < deduped.length ? deduped[i + 1].index - 1 : totalFrameCount - 1;
    ranges.push({
      phase: mapDbPhaseToClinic(deduped[i].phase),
      startFrameIndex: start,
      endFrameIndex: end,
    });
  }
  return ranges;
}

function computeTab4Signals(frames, phaseTags, handedness, options) {
  const collapseAddress = options?.collapseAddress !== false;

  const indexToPhase = new Array(frames.length).fill(undefined);
  for (const tag of phaseTags) {
    const end = Math.min(tag.endFrameIndex, frames.length - 1);
    for (let i = tag.startFrameIndex; i <= end; i++) {
      if (i >= 0 && i < frames.length) indexToPhase[i] = tag.phase;
    }
  }

  const takeaway = phaseTags.find((p) => p.phase === 'takeaway');
  const onset = takeaway ? takeaway.startFrameIndex : null;
  const startIdx = collapseAddress && onset !== null ? Math.max(0, onset - 7) : 0;
  const visibleFrames = frames.slice(startIdx);

  const trailKey = handedness === 'right' ? 'rightWrist' : 'leftWrist';

  const trailX = visibleFrames.map((f) => f.joints?.[trailKey]?.x ?? 0);
  const trailY = visibleFrames.map((f) => f.joints?.[trailKey]?.y ?? 0);
  const hipSpread = visibleFrames.map(
    (f) => (f.joints?.leftHip?.x ?? 0) - (f.joints?.rightHip?.x ?? 0),
  );
  const hipDelta = hipSpread.map((v, i) => (i === 0 ? 0 : v - hipSpread[i - 1]));
  const wristDX = trailX.map((v, i) => (i === 0 ? 0 : v - trailX[i - 1]));

  return { startIdx, visibleFrames, indexToPhase, trailX, trailY, hipDelta, wristDX, onset };
}

async function main() {
  const env = parseEnv(resolve(repoRoot, '.env'));
  const url = env.EXPO_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL in .env');

  let keyName, key;
  if (env.SUPABASE_SERVICE_ROLE_KEY) {
    keyName = 'SUPABASE_SERVICE_ROLE_KEY';
    key = env.SUPABASE_SERVICE_ROLE_KEY;
  } else if (env.EXPO_PUBLIC_SUPABASE_ANON_KEY) {
    keyName = 'EXPO_PUBLIC_SUPABASE_ANON_KEY';
    key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  } else {
    throw new Error('No Supabase key found in .env');
  }
  console.log(`Using ${keyName}`);

  const restUrl =
    `${url}/rest/v1/swings?id=eq.${encodeURIComponent(SWING_ID)}` +
    `&select=id,motion_frames,frame_count,phases,swing_debug`;

  const res = await fetch(restUrl, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`Swing ${SWING_ID} not found`);
  const row = rows[0];

  const frames = row.motion_frames;
  if (!Array.isArray(frames)) throw new Error('motion_frames is null/invalid');
  const frameCount = row.frame_count ?? frames.length;
  const rawPhases = row.phases || [];
  const handedness = row.swing_debug?.handedness === 'left' ? 'left' : 'right';

  const phaseTags = convertPhasesToRanges(rawPhases, frameCount);
  const signals = computeTab4Signals(frames, phaseTags, handedness);

  const visiblePhases = signals.indexToPhase
    .slice(signals.startIdx)
    .map((p) => p ?? null);

  console.log(`swing_id: ${row.id}`);
  console.log(`frame_count: ${frameCount}`);
  console.log(`visible frames: ${signals.visibleFrames.length} (startIdx=${signals.startIdx}, onset=${signals.onset})`);
  console.log(`handedness: ${handedness}`);

  const payload = {
    swingId: row.id,
    frameCount,
    visibleFrameCount: signals.visibleFrames.length,
    startIdx: signals.startIdx,
    onset: signals.onset,
    handedness,
    phaseColors: PHASE_COLORS,
    visiblePhases,
    trailX: signals.trailX,
    trailY: signals.trailY,
    hipDelta: signals.hipDelta,
    wristDX: signals.wristDX,
  };

  const html = renderHtml(payload);
  const outPath = resolve(__dirname, 'swing_chart.html');
  writeFileSync(outPath, html);
  console.log(outPath);
}

function renderHtml(p) {
  const data = JSON.stringify(p);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Swing ${p.swingId}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  body { font: 14px -apple-system, system-ui, sans-serif; margin: 24px; background: #fafafa; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #555; margin-bottom: 16px; font-size: 13px; }
  .chart-card { background: #fff; border-radius: 8px; padding: 12px 16px 16px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  .chart-card h2 { font-size: 14px; margin: 0 0 8px; color: #333; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 0 4px; font-size: 12px; color: #444; }
  .legend span.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
</style>
</head>
<body>
<h1>Swing ${p.swingId}</h1>
<div class="meta">
  frame_count: ${p.frameCount} &middot; visible: ${p.visibleFrameCount}
  &middot; startIdx: ${p.startIdx} &middot; onset: ${p.onset === null ? 'null' : p.onset}
  &middot; handedness: ${p.handedness}
</div>

<div class="chart-card">
  <h2>Phase trace</h2>
  <div class="legend" id="phaseLegend"></div>
  <div style="position:relative;height:60px"><canvas id="phaseChart"></canvas></div>
</div>

<div class="chart-card"><h2>trailX (${p.handedness}Wrist.x)</h2><div style="position:relative;height:200px"><canvas id="trailX"></canvas></div></div>
<div class="chart-card"><h2>trailY (${p.handedness}Wrist.y)</h2><div style="position:relative;height:200px"><canvas id="trailY"></canvas></div></div>
<div class="chart-card"><h2>hipDelta (Δ(leftHip.x − rightHip.x))</h2><div style="position:relative;height:200px"><canvas id="hipDelta"></canvas></div></div>
<div class="chart-card"><h2>wristDX (Δ trailX)</h2><div style="position:relative;height:200px"><canvas id="wristDX"></canvas></div></div>

<script>
const P = ${data};
const labels = P.trailX.map((_, i) => i);

// Phase legend
const legendEl = document.getElementById('phaseLegend');
for (const [name, color] of Object.entries(P.phaseColors)) {
  const el = document.createElement('div');
  el.innerHTML = '<span class="sw" style="background:' + color + '"></span>' + name;
  legendEl.appendChild(el);
}

// Phase trace bar chart — one bar per visible frame, height=1, colored by phase
const phaseColors = P.visiblePhases.map(ph => ph && P.phaseColors[ph] ? P.phaseColors[ph] : '#dddddd');
new Chart(document.getElementById('phaseChart'), {
  type: 'bar',
  data: {
    labels,
    datasets: [{
      data: labels.map(() => 1),
      backgroundColor: phaseColors,
      borderWidth: 0,
      categoryPercentage: 1.0,
      barPercentage: 1.0,
    }],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => P.visiblePhases[ctx.dataIndex] || '(none)',
          title: (items) => 'frame ' + items[0].label,
        },
      },
    },
    scales: {
      x: { ticks: { autoSkip: true, maxTicksLimit: 16 } },
      y: { display: false, min: 0, max: 1 },
    },
  },
});

function lineChart(id, label, values) {
  new Chart(document.getElementById(id), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label,
        data: values,
        borderColor: '#007AFF',
        backgroundColor: 'rgba(0,122,255,0.12)',
        borderWidth: 1.5,
        pointRadius: 2,
        pointHoverRadius: 4,
        tension: 0,
        fill: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { autoSkip: true, maxTicksLimit: 16 } },
        y: { ticks: { precision: 4 } },
      },
    },
  });
}

lineChart('trailX',  'trailX',  P.trailX);
lineChart('trailY',  'trailY',  P.trailY);
lineChart('hipDelta','hipDelta',P.hipDelta);
lineChart('wristDX', 'wristDX', P.wristDX);
</script>
</body>
</html>`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
