/**
 * puttingDetectors.test.ts — Phase A1 putting tempo detectors vs baked fixtures.
 *
 * Fixtures in __fixtures__/ are trimmed from the two device harness v1
 * exports (putting-CV marathon clips). Expected values come from the
 * OPERATOR LABELS + spec acceptance windows (Putting Mode v1 spec §8), never
 * from implementation output:
 *   clip1 51b07a6b (labels 77/120/152): impact === 152, top ∈ [119,121],
 *     takeaway === 77
 *   clip2 a347efc8 (labels 56/118/150): impact ∈ [149,151], top ∈ [117,119],
 *     takeaway ∈ [53,59]
 *
 * Run with: npx --yes tsx packages/domain/putting/puttingDetectors.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { runPuttingDetectors } from './runPuttingDetectors';
import type { BallPoint, PosePriorSample } from './types';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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

function assertInWindow(actual: number | null, lo: number, hi: number, label: string): void {
  assert(
    actual != null && actual >= lo && actual <= hi,
    `${label} ∈ [${lo},${hi}] (got ${actual})`,
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Fixture = {
  source_export: string;
  step_ms: number;
  expected: { takeaway: number; top: number; impact: number };
  pose_priors: PosePriorSample[];
  balls: BallPoint[];
};

function loadFixture(name: string): Fixture {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8'),
  ) as Fixture;
}

const clip1 = loadFixture('clip1-51b07a6b.json');
const clip2 = loadFixture('clip2-a347efc8.json');

// ---------------------------------------------------------------------------
// 1. clip1 — acceptance windows (labels 77/120/152)
// ---------------------------------------------------------------------------

group('clip1 51b07a6b — labels 77/120/152');
const r1 = runPuttingDetectors({
  posePriors: clip1.pose_priors,
  balls: clip1.balls,
  stepMs: clip1.step_ms,
});
assert(r1.impactFrame === 152, `impact === 152 (got ${r1.impactFrame})`);
assertInWindow(r1.topFrame, 119, 121, 'top');
assert(r1.takeawayFrame === 77, `takeaway === 77 (got ${r1.takeawayFrame})`);
assert(r1.tempo != null, 'tempo emitted');
if (r1.tempo && r1.topFrame != null && r1.takeawayFrame != null && r1.impactFrame != null) {
  const expectRatio =
    Math.round(
      ((r1.topFrame - r1.takeawayFrame) / (r1.impactFrame - r1.topFrame)) * 100,
    ) / 100;
  assert(
    r1.tempo.ratio === expectRatio,
    `tempo ratio consistent with detected frames (got ${r1.tempo.ratio}, expected ${expectRatio})`,
  );
  assert(
    r1.tempo.backswingMs === Math.round((r1.topFrame - r1.takeawayFrame) * clip1.step_ms),
    `backswingMs on 8.333ms grid (got ${r1.tempo.backswingMs})`,
  );
}

// ---------------------------------------------------------------------------
// 2. clip2 — acceptance windows (labels 56/118/150)
// ---------------------------------------------------------------------------

group('clip2 a347efc8 — labels 56/118/150');
const r2 = runPuttingDetectors({
  posePriors: clip2.pose_priors,
  balls: clip2.balls,
  stepMs: clip2.step_ms,
});
assertInWindow(r2.impactFrame, 149, 151, 'impact');
assertInWindow(r2.topFrame, 117, 119, 'top');
assertInWindow(r2.takeawayFrame, 53, 59, 'takeaway');
assert(r2.tempo != null, 'tempo emitted');

// ---------------------------------------------------------------------------
// 3. Sentinel regression — clip2's early pose-fallback run must be dropped
//    (unfiltered sentinels poisoned every downstream median in the marathon)
// ---------------------------------------------------------------------------

group('sentinel filter regression');
assert(
  r2.intermediates.sentinel_filtered_count > 0,
  `clip2 sentinels dropped (count ${r2.intermediates.sentinel_filtered_count})`,
);
assert(
  r1.intermediates.sentinel_filtered_count > 0,
  `clip1 sentinels dropped (count ${r1.intermediates.sentinel_filtered_count})`,
);

// ---------------------------------------------------------------------------
// 4. Null-safety — no ball series → impact null → top/takeaway/tempo null,
//    never 0, never a throw
// ---------------------------------------------------------------------------

group('null-safety');
const rEmpty = runPuttingDetectors({
  posePriors: clip1.pose_priors,
  balls: clip1.balls.map(() => null),
  stepMs: clip1.step_ms,
});
assert(rEmpty.impactFrame === null, 'no balls → impact null');
assert(rEmpty.topFrame === null, 'no impact → top null');
assert(rEmpty.takeawayFrame === null, 'no top → takeaway null');
assert(rEmpty.tempo === null, 'tempo withheld (null, not 0)');
assert(
  rEmpty.intermediates.warnings.includes('no_impact_launch') &&
    rEmpty.intermediates.warnings.includes('tempo_withheld'),
  `warnings surfaced (${rEmpty.intermediates.warnings.join(',')})`,
);

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
  console.log('✅ All puttingDetectors tests passed');
}
