/**
 * smoothShaftSeries.test.ts — smoother vs the v8 playground golden series.
 *
 * Fixtures clip1/clip2-shaft-series.json are the session-validated smoothed
 * shaft series extracted from the DATA blob in
 * docs/putting-cv-test/playground/head-refinement-test-v8.html. The test feeds
 * ONLY the anchor-flagged frames in as accepted fits and asserts the smoother
 * reproduces the interpolated (non-anchor) frames within DATA's rounding
 * tolerance (ang 2dp, px/py 1dp → ang ≤ 0.02°, px/py ≤ 0.06px; hx/hy ≤ 0.11px
 * with headExt 25 = round(0.13 × 194), locking the D3 ratio).
 *
 * Run with: npx --yes tsx packages/domain/putting/smoothShaftSeries.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { smoothShaftSeries } from './smoothShaftSeries';
import type { ShaftFitSample } from './types';

let passed = 0;
let failed = 0;

function group(name: string): void {
  console.log(`\n── ${name} ──`);
}

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

type SeriesFixture = {
  shaft_len: number;
  fps: number;
  events: { takeaway: number; top: number; impact: number };
  frames: { f: number; ang: number; px: number; py: number; hx: number; hy: number; anchor: boolean }[];
};

function loadFixture(name: string): SeriesFixture {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8'),
  ) as SeriesFixture;
}

const HEAD_EXT = Math.round(0.13 * 194); // 25 — D3 ratio must reproduce the playground

function runClip(label: string, fixtureName: string): void {
  group(label);
  const fx = loadFixture(fixtureName);
  assert(HEAD_EXT === 25, `headExt ratio: round(0.13 × ${fx.shaft_len}) === 25 (got ${HEAD_EXT})`);

  // Build the fitter-output view: anchors become accepted cv fits, everything
  // else is unfit (the smoother must reconstruct those frames).
  const maxF = fx.frames[fx.frames.length - 1].f;
  const fits: ShaftFitSample[] = new Array(maxF + 1).fill(null);
  for (const fr of fx.frames) {
    if (!fr.anchor) continue;
    fits[fr.f] = {
      angleDeg: fr.ang,
      gripX: fr.px,
      gripY: fr.py,
      spanPx: fx.shaft_len,
      matX: null,
      lengthMatch: 1,
      score: 1,
      pivotOffsetPx: 0,
      source: 'cv',
    };
  }

  const smoothed = smoothShaftSeries(fits, fx.shaft_len, HEAD_EXT);
  assert(smoothed !== null && smoothed.length === maxF + 1, 'series emitted, full length');
  if (!smoothed) return;

  // Convention note: DATA hx/hy is the TUBE END (px + unit × shaftLen);
  // the v8 refiner recomputed its ellipse center at shaftLen + EXT from
  // px/ang at runtime. The smoother emits the REFINE CENTER (L + headExt) —
  // so compare hx/hy against DATA's tube end extended by unit × headExt.
  let angMax = 0;
  let pMax = 0;
  let hMax = 0;
  let tubeMax = 0;
  let interpCount = 0;
  for (const fr of fx.frames) {
    const s = smoothed[fr.f];
    if (!fr.anchor) interpCount++;
    angMax = Math.max(angMax, Math.abs(s.ang - fr.ang));
    pMax = Math.max(pMax, Math.abs(s.px - fr.px), Math.abs(s.py - fr.py));
    const r = (fr.ang * Math.PI) / 180;
    hMax = Math.max(
      hMax,
      Math.abs(s.hx - (fr.hx + Math.sin(r) * HEAD_EXT)),
      Math.abs(s.hy - (fr.hy + Math.cos(r) * HEAD_EXT)),
    );
    tubeMax = Math.max(
      tubeMax,
      Math.abs(fr.hx - (fr.px + Math.sin(r) * fx.shaft_len)),
      Math.abs(fr.hy - (fr.py + Math.cos(r) * fx.shaft_len)),
    );
  }
  assert(interpCount > 0, `fixture exercises interpolation (${interpCount} non-anchor frames)`);
  assert(angMax <= 0.02, `interp angle matches DATA ≤ 0.02° (max |Δ| ${angMax.toFixed(4)}°)`);
  assert(pMax <= 0.06, `interp pivot matches DATA ≤ 0.06px (max |Δ| ${pMax.toFixed(4)}px)`);
  assert(
    tubeMax <= 0.11,
    `DATA hx/hy confirmed as tube end px+unit×L (max |Δ| ${tubeMax.toFixed(4)}px)`,
  );
  assert(
    hMax <= 0.11,
    `refine center matches DATA tube end + unit×headExt ≤ 0.11px (max |Δ| ${hMax.toFixed(4)}px)`,
  );
  const anchorFlags = fx.frames.every((fr) => smoothed[fr.f].anchor === fr.anchor);
  assert(anchorFlags, 'anchor flags match DATA frame-for-frame');
}

runClip('clip1 51b07a6b (161/255 anchors)', 'clip1-shaft-series.json');
runClip('clip2 a347efc8 (264/288 anchors)', 'clip2-shaft-series.json');

group('null-safety');
assert(smoothShaftSeries([], 194, 25) === null, 'empty input → null');
assert(
  smoothShaftSeries([null, null, null], 194, 25) === null,
  'no anchors → null (fine stage skipped, never throws)',
);

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All smoothShaftSeries tests passed');
}
