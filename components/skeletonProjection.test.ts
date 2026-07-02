/**
 * skeletonProjection.test.ts — Characterization tests for the coordinate math
 * extracted from SwingSkeletonCanvas.tsx (pure code motion, commit 9d42c60).
 *
 * These pin CURRENT rendering behavior — they are regression guards, not
 * opinions about correct mirroring. Expected values derive from
 * skeletonProjection.ts source:
 *   - MIN_CONF = 0.2, inclusive >=                       (:9, :11-14)
 *     (NOTE: this is the RENDER threshold — intentionally looser than the
 *      domain analysis threshold 0.5 in angles.ts:67)
 *   - spatialMedian: per-axis independent medians, upper-middle on even
 *     counts (floor(n/2) of the sorted array)            (:16-28)
 *   - temporalMedianSmooth: edge-clamped windowed median, nulls skipped
 *                                                        (:30-48)
 *   - buildPath: `M x y` / ` L x y` with toFixed(1)      (:50-59)
 *   - makeDrivenTransform: identity mapping x*width / y*height, no flip
 *                                                        (:66-77)
 *   - makeAnchoredTransform: hip-midpoint → (width/2, height*0.40),
 *     scale = height*0.75/vertical, hScale = scale*0.70, joint fallback
 *     chains, null without anchors                       (:84-109)
 *
 * Run with: npx --yes tsx components/skeletonProjection.test.ts
 */

import {
  getJoint,
  spatialMedian,
  temporalMedianSmooth,
  buildPath,
  makeDrivenTransform,
  makeAnchoredTransform,
} from './skeletonProjection';
import { createEmptyJoints } from '../packages/pose/PoseTypes';
import type { JointName, NormalizedJoint, PoseFrame } from '../packages/pose/PoseTypes';

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

function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(
    actual === expected,
    `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );
}

function assertApprox(actual: number | undefined, expected: number, label: string, eps = 1e-9): void {
  assert(
    actual !== undefined && Math.abs(actual - expected) < eps,
    `${label} (got ${actual}, expected ≈${expected})`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function joint(name: JointName, x: number, y: number, confidence = 0.9): NormalizedJoint {
  return { name, x, y, confidence };
}

function makeFrame(joints: NormalizedJoint[]): PoseFrame {
  const map = createEmptyJoints();
  for (const j of joints) map[j.name] = j;
  return { timestampMs: 0, joints: map, frameWidth: 1080, frameHeight: 1920 };
}

console.log('\n=== skeletonProjection Module Tests ===');

// ---------------------------------------------------------------------------
// Section A — getJoint render-confidence gate (:9, :11-14)
// ---------------------------------------------------------------------------

group('A. getJoint');

assertEq(getJoint(makeFrame([]), 'nose'), null, 'A1: absent joint → null');
assertEq(
  getJoint(makeFrame([joint('nose', 0.5, 0.5, 0.19)]), 'nose'),
  null,
  'A2: confidence 0.19 < MIN_CONF 0.2 → null (:9, :13)',
);
assert(
  getJoint(makeFrame([joint('nose', 0.5, 0.5, 0.2)]), 'nose') !== null,
  'A3: confidence exactly 0.2 passes (inclusive >=, :13)',
);
{
  const noConf: NormalizedJoint = { name: 'nose', x: 0.5, y: 0.5 };
  const map = createEmptyJoints();
  map.nose = noConf;
  const frame: PoseFrame = { timestampMs: 0, joints: map, frameWidth: 1080, frameHeight: 1920 };
  assertEq(getJoint(frame, 'nose'), null, 'A4: missing confidence treated as 0 (?? 0, :13)');
}

// ---------------------------------------------------------------------------
// Section B — spatialMedian (:16-28)
// ---------------------------------------------------------------------------

group('B. spatialMedian');

assertEq(spatialMedian(makeFrame([]), ['nose', 'leftWrist']), null, 'B1: no confident joints → null (:23)');
{
  const m = spatialMedian(makeFrame([joint('leftWrist', 0.3, 0.7)]), ['leftWrist', 'leftPinky']);
  assertApprox(m?.x, 0.3, 'B2a: single joint → its x');
  assertApprox(m?.y, 0.7, 'B2b: single joint → its y');
}
{
  // Odd count: median of [0.1, 0.3, 0.9] is 0.3
  const m = spatialMedian(
    makeFrame([joint('leftWrist', 0.1, 0.5), joint('leftPinky', 0.3, 0.5), joint('leftIndex', 0.9, 0.5)]),
    ['leftWrist', 'leftPinky', 'leftIndex'],
  );
  assertApprox(m?.x, 0.3, 'B3: odd count → true median, outlier 0.9 rejected (:24-27)');
}
{
  // Even count: floor(2/2)=1 → UPPER middle of the sorted pair (characterization)
  const m = spatialMedian(
    makeFrame([joint('leftWrist', 0.2, 0.5), joint('leftPinky', 0.6, 0.5)]),
    ['leftWrist', 'leftPinky'],
  );
  assertApprox(m?.x, 0.6, 'B4: even count → upper-middle element, not average (:26-27)');
}
{
  // CHARACTERIZATION: x and y are sorted INDEPENDENTLY (:24-25) — the result can
  // be a coordinate pair belonging to no single joint.
  const m = spatialMedian(
    makeFrame([joint('leftWrist', 0.1, 0.9), joint('leftPinky', 0.5, 0.1), joint('leftIndex', 0.9, 0.5)]),
    ['leftWrist', 'leftPinky', 'leftIndex'],
  );
  assert(
    m !== null && Math.abs(m.x - 0.5) < 1e-9 && Math.abs(m.y - 0.5) < 1e-9,
    'B5: per-axis medians combine across joints (x from one, y from another)',
  );
}
{
  // Low-confidence joints excluded before the median (:20-21 via getJoint)
  const m = spatialMedian(
    makeFrame([joint('leftWrist', 0.1, 0.5), joint('leftPinky', 0.9, 0.5, 0.1)]),
    ['leftWrist', 'leftPinky'],
  );
  assertApprox(m?.x, 0.1, 'B6: low-conf joint excluded from the median');
}

// ---------------------------------------------------------------------------
// Section C — temporalMedianSmooth (:30-48)
// ---------------------------------------------------------------------------

group('C. temporalMedianSmooth');

{
  const constant = Array.from({ length: 7 }, () => ({ x: 0.4, y: 0.6 }));
  const s = temporalMedianSmooth(constant, 5);
  assert(
    s.every((p) => p !== null && p.x === 0.4 && p.y === 0.6),
    'C1: constant input is a fixed point',
  );
  assertEq(s.length, 7, 'C2: length preserved (:35 map)');
}
{
  // Median filter REMOVES a single spike entirely (unlike a mean, which damps it):
  // window around the spike is [.3,.3,.9,.3,.3] → sorted median .3
  const pts = [0.3, 0.3, 0.3, 0.9, 0.3, 0.3, 0.3].map((x) => ({ x, y: 0.5 }));
  const s = temporalMedianSmooth(pts, 5);
  assertApprox(s[3]?.x, 0.3, 'C3: single-frame spike fully rejected by the median (:38-46)');
}
{
  // Null entries are skipped inside the window, not zero-filled (:40-41)
  const pts: ({ x: number; y: number } | null)[] = [{ x: 0.2, y: 0.5 }, null, { x: 0.4, y: 0.5 }];
  const s = temporalMedianSmooth(pts, 5);
  assert(s[1] !== null, 'C4a: null gap bridged from neighbors');
  assertApprox(s[1]?.x, 0.4, 'C4b: even surviving count → upper-middle (:42-46)');
}
{
  const s = temporalMedianSmooth([null, null, null], 5);
  assert(s.every((p) => p === null), 'C5: all-null window stays null (:42)');
}
{
  const pts = [0.1, 0.7, 0.2, 0.8].map((x) => ({ x, y: 0.5 }));
  const s = temporalMedianSmooth(pts, 1);
  assert(
    s.every((p, i) => p !== null && p.x === pts[i].x),
    'C6: windowSize 1 is the identity (half=0, :34)',
  );
}

// ---------------------------------------------------------------------------
// Section D — buildPath format stability (:50-59)
// ---------------------------------------------------------------------------

group('D. buildPath');

assertEq(buildPath([]), '', 'D1: empty → empty string (:51)');
assertEq(buildPath([{ x: 12.34, y: 56.78 }]), 'M 12.3 56.8', 'D2: single point → M with toFixed(1) (:52)');
assertEq(
  // .24/.46 chosen away from the .x5 boundary — binary float representation
  // makes exact-half cases round unpredictably under toFixed.
  buildPath([{ x: 0, y: 0 }, { x: 100.24, y: 200 }, { x: 300.46, y: 400.44 }]),
  'M 0.0 0.0 L 100.2 200.0 L 300.5 400.4',
  'D3: polyline M/L format, 1-decimal rounding (:53-58)',
);

// ---------------------------------------------------------------------------
// Section E — makeDrivenTransform (:66-77)
// ---------------------------------------------------------------------------

group('E. makeDrivenTransform');

{
  const t = makeDrivenTransform(360, 800);
  assertEq(t.tx(0), 0, 'E1: tx(0) = 0');
  assertEq(t.tx(1), 360, 'E2: tx(1) = width');
  assertEq(t.tx(0.25), 90, 'E3: tx is x*width exactly (:74)');
  assertEq(t.ty(0.5), 400, 'E4: ty is y*height exactly (:75)');
  // CHARACTERIZATION (mirror-sensitive — pins behavior, asserts no opinion on
  // correctness): the mapping is monotone increasing in x, i.e. NO x-flip.
  // The "no flip" contract is documented at skeletonProjection.ts:70-71.
  assert(t.tx(0.2) < t.tx(0.8), 'E5: driven mapping is flip-free (monotone in x)');
}

// ---------------------------------------------------------------------------
// Section F — makeAnchoredTransform (:84-109)
// ---------------------------------------------------------------------------

// Reference frame (values chosen for exact binary representation where the
// math allows): shoulders y=0.25, hips (0.25,0.5)/(0.75,0.5), ankle y=0.75.
// Derivation: top=leftShoulder(0.25) bot=leftAnkle(0.75) → vertical 0.5;
// height 800 → scale = 800*0.75/0.5 = 1200; hScale = 1200*0.70 = 840;
// hipX0 = 0.5, hipY0 = 0.5; anchorX = 180 (width 360), anchorY = 800*0.40 = 320.
function referenceFrame(): PoseFrame {
  return makeFrame([
    joint('leftShoulder', 0.25, 0.25),
    joint('rightShoulder', 0.75, 0.25),
    joint('leftHip', 0.25, 0.5),
    joint('rightHip', 0.75, 0.5),
    joint('leftAnkle', 0.25, 0.75),
  ]);
}

group('F. makeAnchoredTransform');

{
  const t = makeAnchoredTransform(referenceFrame(), 360, 800);
  assert(t !== null, 'F1: full anchor set → transform');
  assertApprox(t?.tx(0.5), 180, 'F2: hip-midpoint x → width/2 (anchorX, :103,107)');
  assertApprox(t?.ty(0.5), 320, 'F3: hip-midpoint y → height*0.40 (anchorY, :104,108)');
  assertApprox(t?.tx(0.75), 180 + 0.25 * 840, 'F4: x offsets scale by hScale = scale*0.70 (:99-100,107)');
  assertApprox(t?.ty(0.75), 320 + 0.25 * 1200, 'F5: y offsets scale by scale = height*0.75/vertical (:98,108)');
  // CHARACTERIZATION (mirror-sensitive): hip-anchored mapping is also monotone
  // increasing in x — same flip-free convention as driven mode.
  assert(t !== null && t.tx(0.2) < t.tx(0.8), 'F6: anchored mapping is flip-free (monotone in x)');
}
{
  // top fallback chain leftShoulder → rightShoulder → nose (:89)
  const t = makeAnchoredTransform(
    makeFrame([
      joint('nose', 0.5, 0.15),
      joint('leftHip', 0.25, 0.5),
      joint('rightHip', 0.75, 0.5),
      joint('rightFootIndex', 0.5, 0.85),
    ]),
    360,
    800,
  );
  assert(t !== null, 'F7: nose + rightFootIndex fallbacks anchor the fit (:89-94)');
}
assertEq(
  makeAnchoredTransform(
    makeFrame([joint('leftShoulder', 0.25, 0.25), joint('leftAnkle', 0.25, 0.75), joint('leftHip', 0.25, 0.5)]),
    360,
    800,
  ),
  null,
  'F8: missing rightHip → null (:95-96)',
);
assertEq(
  makeAnchoredTransform(makeFrame([]), 360, 800),
  null,
  'F9: empty frame → null',
);
{
  // Degenerate vertical clamps at 0.01 (:97): top and bot at the same y
  const t = makeAnchoredTransform(
    makeFrame([
      joint('leftShoulder', 0.25, 0.5),
      joint('leftAnkle', 0.25, 0.5),
      joint('leftHip', 0.25, 0.5),
      joint('rightHip', 0.75, 0.5),
    ]),
    360,
    800,
  );
  assert(t !== null, 'F10a: zero vertical extent still yields a transform');
  assertApprox(t?.ty(0.51), 320 + 0.01 * (800 * 0.75 / 0.01), 'F10b: scale uses the 0.01 clamp (:97-98)');
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
  console.log('✅ All skeletonProjection tests passed');
}
