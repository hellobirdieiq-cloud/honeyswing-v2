/**
 * analysisPipeline.test.ts — M2 repro: averageFrames() lacks the s > e guard.
 *
 * averageFrames (analysisPipeline.ts:170-214) computes
 *   s = max(0, start); e = min(len-1, end); window = slice(s, e+1)
 *   midFrame = window[floor(window.length / 2)]
 * with NO `if (s > e) return` guard — unlike computeZTrace (:474), which has it.
 *
 * When the caller pins an out-of-range addressFrameIdx, resolvedAddressIdx
 * exceeds the array, and the addressFrame computation at analysisPipeline.ts:609
 *   averageFrames(frames, resolvedAddressIdx, min(resolvedAddressIdx + 9, len-1))
 * yields s > e → empty window → midFrame undefined → midFrame.timestampMs throws.
 *
 * Documented intent (guard parity with computeZTrace): the call should clamp /
 * fall back rather than crash. This test FAILS until the guard is added.
 *
 * Run with: npx --yes tsx packages/domain/swing/analysisPipeline.test.ts
 */

import { analyzePoseSequence, computeFrameCountSuppression } from './analysisPipeline';
import type { MetricWeightingResult, VisibilityWeightingResult } from './visibilityWeighting';
import { createEmptyJoints, type PoseFrame, type PoseSequence } from '../../pose/PoseTypes';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

console.log('\n=== analysisPipeline M2 repro ===');
console.log('\n── out-of-range addressFrameIdx must not crash averageFrames ──');

const N = 30;
const frames: PoseFrame[] = [];
for (let i = 0; i < N; i++) {
  frames.push({
    timestampMs: i * 8,
    joints: createEmptyJoints(), // joints unused — crash happens on the index before any joint read
    frameWidth: 1,
    frameHeight: 1,
  });
}
const seq: PoseSequence = { frames, source: 'test' };

// addressFrameIdx = frames.length is out of range; resolvedAddressIdx = N, so
// averageFrames(frames, N, N-1) gives s = N > e = N-1 → empty window → throw.
let threw = false;
let errMsg = '';
try {
  analyzePoseSequence(seq, false, [], seq.frames.length);
} catch (e) {
  threw = true;
  errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

if (threw) {
  console.log(`  (threw: ${errMsg})`);
}

// Documented intent: should NOT throw (guard like computeZTrace).
assert(!threw, 'M2: analyzePoseSequence(seq,false,[],frames.length) does not throw');

// ---------------------------------------------------------------------------
// D8 — computeFrameCountSuppression maps the per-window hipSpreadDelta keys to
// the plain scoring key. Pre-fix it emitted 'hipSpreadDelta_address'/'_impact',
// which match no suppressible metric — the suppression was silently inert.
// ---------------------------------------------------------------------------
console.log('\n── D8: frame-count suppression key mapping ──');
{
  const metric = (framesUsed: number): MetricWeightingResult => ({
    weightedValue: 0,
    unweightedValue: 0,
    delta: 0,
    framesUsed,
    framesExcluded: 0,
    avgWeight: 1,
    minWeight: 1,
    applied: true,
  });
  const visibility: VisibilityWeightingResult = {
    applied: true,
    version: 'test',
    metrics: {
      spineAngle: metric(1),              // under MIN_USABLE_FRAMES (3)
      leftKneeAngle: metric(10),          // healthy — not suppressed
      hipSpreadDelta_address: metric(1),  // both windows under → ONE plain key
      hipSpreadDelta_impact: metric(0),
    },
  };
  const suppressed = computeFrameCountSuppression(visibility);
  assert(suppressed.includes('spineAngle'), 'D8: under-framed plain metric suppressed');
  assert(!suppressed.includes('leftKneeAngle'), 'D8: healthy metric not suppressed');
  assert(suppressed.includes('hipSpreadDelta'), 'D8: composite windows map to plain hipSpreadDelta');
  assert(
    !suppressed.includes('hipSpreadDelta_address') && !suppressed.includes('hipSpreadDelta_impact'),
    'D8: raw window keys never emitted',
  );
  assert(
    suppressed.filter((k) => k === 'hipSpreadDelta').length === 1,
    'D8: two under-framed windows dedupe to one suppression key',
  );
}

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All analysisPipeline tests passed');
}
