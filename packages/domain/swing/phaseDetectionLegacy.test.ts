/**
 * phaseDetectionLegacy.test.ts — D1 + D9 regression suite (Batch 2b).
 *
 * D1: detectLegacyPhases' success branch checked `phases.length === 6` after
 * the June 6→5 phase relabel (fe00cda), so a succeeding heuristic was ALWAYS
 * discarded as gate-less fallback — and the stale ratio slots [2]/[4] read
 * downswing/follow_through instead of top/impact. Both fixtures here fail
 * against the pre-fix code: the pass fixture came back source='fallback',
 * and the ratio-fail fixture computes 0.95 (passes) on the stale slots vs
 * 0.75 (fails) on the correct ones.
 *
 * D9: fallbackPhases' pct floors collide on short captures (n≤7), violating
 * the strictly-increasing index contract downstream row builders assume.
 *
 * Scope note (T11 freeze): this suite pins ONLY the D1/D9 fix contracts —
 * branch selection, source, gate, and index monotonicity — not legacy's
 * frame choices beyond the frozen fixtures. See phaseDetection.test.ts T11
 * for the dispatcher-level smoke test.
 *
 * Run with: npx --yes tsx packages/domain/swing/phaseDetectionLegacy.test.ts
 */

import { detectLegacyPhases, tryHeuristicDetection } from './phaseDetectionLegacy';
import type { SwingTrailPoint } from './phaseDetection';

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

function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(
    actual === expected,
    `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );
}

const MS60 = 1000 / 60;

function pt(x: number, y: number, i: number): SwingTrailPoint {
  return { x, y, timestamp: i * MS60, leadX: x, leadY: y, trailX: x, trailY: y };
}

// ---------------------------------------------------------------------------
// D1a — heuristic success survives (=== 5 branch taken, ratio 27/16 passes)
//
// Shape: setup hold (0-19) → backswing x-rise to 0.70 (20-40) → trailX dip to
// the 0.60 local min @46 (top) → downswing dive to hands-lowest @58 → impact
// 58+4=62 → decelerating swing-through → still from 84 (finish 84).
// ---------------------------------------------------------------------------
group('D1a. Heuristic success returns heuristic phases, no gate');
function d1PassTrail(): SwingTrailPoint[] {
  const points: SwingTrailPoint[] = [];
  for (let i = 0; i < 100; i++) {
    let x: number, y: number;
    if (i < 20) { x = 0.50; y = 0.55; }
    else if (i <= 40) { x = 0.50 + (i - 20) * 0.010; y = 0.55 - (i - 20) * 0.0125; }
    else if (i <= 46) { x = 0.70 - (i - 40) * (0.10 / 6); y = 0.30 - (i - 40) * 0.003; }
    else if (i <= 58) { x = 0.60 + (i - 46) * 0.010; y = 0.282 + (i - 46) * 0.0432; }
    else if (i <= 83) { const t = i - 58; x = 0.72 - t * 0.0068; y = 0.80 - t * 0.012; }
    else { x = 0.72 - 25 * 0.0068; y = 0.80 - 25 * 0.012; }
    points.push(pt(x, y, i));
  }
  return points;
}
{
  const trail = d1PassTrail();
  const heuristic = tryHeuristicDetection(trail);
  assertEq(heuristic.failureGate, null, 'D1a: heuristic itself succeeds (precondition)');
  assertEq(heuristic.phases.length, 5, 'D1a: heuristic returns 5 phases (precondition)');

  const result = detectLegacyPhases(trail);
  assertEq(result.fallbackGate, null, 'D1a: no fallback gate');
  assert(result.phases.every((p) => p.source === 'heuristic'),
    'D1a: every phase source is heuristic (pre-fix: fallback with gate null)');
  assertEq(result.phases.map((p) => p.index).join(','), '19,46,51,62,84',
    'D1a: heuristic indices survive to the caller');
  assertEq(result.phases.map((p) => p.phase).join(','),
    'takeaway,top,downswing,impact,follow_through', 'D1a: canonical 5-phase order');
}

// ---------------------------------------------------------------------------
// D1b — ratio reads top=[1] / impact=[3], not the stale [2]/[4] slots.
//
// Long slow downswing: top@46, impact@82 → backswing/downswing = 27/36 = 0.75
// < 0.8 → must fall back with backswing_ratio_check_failed. On the STALE
// slots the same trail computes (58−19)/(99−58) = 0.95 and would pass — so
// this fixture fails if the slot fix regresses.
// ---------------------------------------------------------------------------
group('D1b. Ratio check consults the 5-slot top/impact positions');
function d1RatioFailTrail(): SwingTrailPoint[] {
  const points: SwingTrailPoint[] = [];
  for (let i = 0; i < 100; i++) {
    let x: number, y: number;
    if (i < 20) { x = 0.50; y = 0.55; }
    else if (i <= 40) { x = 0.50 + (i - 20) * 0.010; y = 0.55 - (i - 20) * 0.0125; }
    else if (i <= 46) { x = 0.70 - (i - 40) * (0.10 / 6); y = 0.30 - (i - 40) * 0.003; }
    else if (i <= 78) { x = 0.60 + (i - 46) * 0.004; y = 0.282 + (i - 46) * 0.0162; }
    else { const t = i - 78; x = 0.728 - t * 0.006; y = 0.80 - t * 0.010; }
    points.push(pt(x, y, i));
  }
  return points;
}
{
  const trail = d1RatioFailTrail();
  const heuristic = tryHeuristicDetection(trail);
  assertEq(heuristic.failureGate, null, 'D1b: heuristic succeeds (precondition)');
  assertEq(heuristic.phases.map((p) => p.index).join(','), '19,46,58,82,99',
    'D1b: heuristic indices (top@46, impact@82) (precondition)');

  const result = detectLegacyPhases(trail);
  assertEq(result.fallbackGate, 'backswing_ratio_check_failed',
    'D1b: 0.75 ratio fails the 0.8 floor (stale slots would compute 0.95 and pass)');
  assert(result.phases.every((p) => p.source === 'fallback'),
    'D1b: ratio failure falls back to percentage phases');
}

// ---------------------------------------------------------------------------
// D9 — fallbackPhases indices are strictly increasing on short captures
// ---------------------------------------------------------------------------
group('D9. Short-capture fallback indices strictly increase');
for (const n of [6, 7]) {
  const points: SwingTrailPoint[] = [];
  for (let i = 0; i < n; i++) points.push(pt(0.5, 0.5, i));
  const result = detectLegacyPhases(points);
  assertEq(result.fallbackGate, 'top_search_bounds', `D9 n=${n}: still trail routes to fallback`);
  assertEq(result.phases.length, 5, `D9 n=${n}: 5 fallback phases`);
  let strictly = true;
  for (let i = 1; i < result.phases.length; i++) {
    if (result.phases[i].index <= result.phases[i - 1].index) strictly = false;
  }
  assert(strictly, `D9 n=${n}: indices strictly increase (pre-fix n=6 emitted 0,2,2,3,4)`);
  assert(result.phases.every((p) => p.index >= 0 && p.index < n),
    `D9 n=${n}: indices stay within the trail`);
  assertEq(result.phases.map((p) => p.index).join(','), '0,2,3,4,5',
    `D9 n=${n}: forward-filled indices`);
}

// Corpus-neutrality guard: on a normal-length trail the forward-fill is a
// no-op — indices equal the raw pct floors exactly (0.12/0.45/0.55/0.65/0.9).
group('D9. Forward-fill is a no-op on normal-length trails');
{
  const n = 90;
  const points: SwingTrailPoint[] = [];
  for (let i = 0; i < n; i++) points.push(pt(0.5, 0.5, i));
  const result = detectLegacyPhases(points);
  assertEq(result.phases.map((p) => p.index).join(','), '10,40,48,57,80',
    'D9: n=90 fallback indices are the raw pct floors (unchanged by the fix)');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All phaseDetectionLegacy tests passed');
}
