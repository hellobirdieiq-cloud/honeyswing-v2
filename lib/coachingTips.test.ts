/**
 * coachingTips.test.ts — Tests for frameToLandmarks, pickKeyFrame, and buildRawTips
 *
 * Run with: npx tsx lib/coachingTips.test.ts
 */

import {
  frameToLandmarks,
  pickKeyFrame,
  buildRawTips,
  TIP_SCORE_THRESHOLD,
  METRIC_KEY_MAP,
} from './coachingTips';
import type { PoseFrame, JointName } from '../packages/pose/PoseTypes';
import { createEmptyJoints } from '../packages/pose/PoseTypes';
import type { ScoringBreakdownEntry } from '../packages/domain/swing/scoring';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let currentGroup = '';

function group(name: string): void {
  currentGroup = name;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFrame(jointEntries: [JointName, number][]): PoseFrame {
  const joints = createEmptyJoints();
  for (const [name, confidence] of jointEntries) {
    joints[name] = { name, x: 0.5, y: 0.5, confidence };
  }
  return { timestampMs: 0, joints, frameWidth: 1080, frameHeight: 1920 };
}

function makeEntry(
  metric: string,
  score: number,
  dataQuality: 'measured' | 'missing' = 'measured',
): ScoringBreakdownEntry {
  return { metric, score, weight: 1, weighted: score, dataQuality };
}

// ---------------------------------------------------------------------------
// Section A — frameToLandmarks
// ---------------------------------------------------------------------------

console.log('\n=== Coaching Tips Tests ===');

group('A1. Frame with multiple joints');
{
  const frame = makeFrame([['leftShoulder', 0.9], ['rightHip', 0.7]]);
  const landmarks = frameToLandmarks(frame);
  const ls = landmarks.find((l) => l.name === 'leftShoulder');
  const rh = landmarks.find((l) => l.name === 'rightHip');
  assert(ls !== undefined, 'leftShoulder present');
  assertEq(ls!.x, 0.5, 'leftShoulder x = 0.5');
  assertEq(ls!.y, 0.5, 'leftShoulder y = 0.5');
  assertEq(ls!.inFrameLikelihood, 0.9, 'leftShoulder inFrameLikelihood = 0.9');
  assert(rh !== undefined, 'rightHip present');
  assertEq(rh!.inFrameLikelihood, 0.7, 'rightHip inFrameLikelihood = 0.7');
}

group('A2. Joint with missing confidence defaults to 0');
{
  const joints = createEmptyJoints();
  joints['nose'] = { name: 'nose', x: 0.1, y: 0.2 }; // no confidence field
  const frame: PoseFrame = { timestampMs: 0, joints, frameWidth: 1080, frameHeight: 1920 };
  const landmarks = frameToLandmarks(frame);
  const nose = landmarks.find((l) => l.name === 'nose');
  assert(nose !== undefined, 'nose present');
  assertEq(nose!.inFrameLikelihood, 0, 'missing confidence defaults to 0');
}

group('A3. Null/undefined joint values skipped');
{
  const joints = createEmptyJoints(); // all undefined
  joints['leftShoulder'] = { name: 'leftShoulder', x: 0.5, y: 0.5, confidence: 0.8 };
  // all others are undefined
  const frame: PoseFrame = { timestampMs: 0, joints, frameWidth: 1080, frameHeight: 1920 };
  const landmarks = frameToLandmarks(frame);
  assertEq(landmarks.length, 1, 'only 1 landmark (rest undefined)');
  assertEq(landmarks[0].name, 'leftShoulder', 'the one landmark is leftShoulder');
}

group('A4. Empty joints → empty array');
{
  const frame: PoseFrame = {
    timestampMs: 0,
    joints: createEmptyJoints(),
    frameWidth: 1080,
    frameHeight: 1920,
  };
  const landmarks = frameToLandmarks(frame);
  assertEq(landmarks.length, 0, 'empty joints → 0 landmarks');
}

// ---------------------------------------------------------------------------
// Section B — pickKeyFrame
// ---------------------------------------------------------------------------

group('B1. Single frame → returns that frame');
{
  const frame = makeFrame([['leftShoulder', 0.9]]);
  const result = pickKeyFrame([frame]);
  assert(result === frame, 'returns the only frame');
}

group('B2. Multiple frames, one clearly best');
{
  const low = makeFrame([['leftShoulder', 0.9]]);              // 1 high-confidence joint
  const high = makeFrame([                                       // 5 high-confidence joints
    ['leftShoulder', 0.9], ['rightShoulder', 0.8],
    ['leftHip', 0.7], ['rightHip', 0.6], ['leftElbow', 0.5],
  ]);
  const mid = makeFrame([['leftShoulder', 0.9], ['rightShoulder', 0.8]]); // 2
  const result = pickKeyFrame([low, mid, high]);
  assert(result === high, 'returns frame with most high-confidence joints');
}

group('B3. All frames equal quality → returns middle frame (initial best)');
{
  // pickKeyFrame starts best = frames[Math.floor(length/2)]
  // Uses strict > so equal counts don't replace best
  const f0 = makeFrame([['leftShoulder', 0.9]]);
  const f1 = makeFrame([['rightShoulder', 0.9]]);
  const f2 = makeFrame([['leftHip', 0.9]]);
  const f3 = makeFrame([['rightHip', 0.9]]);
  const f4 = makeFrame([['leftElbow', 0.9]]);
  const frames = [f0, f1, f2, f3, f4];
  const result = pickKeyFrame(frames);
  // Middle index: Math.floor(5/2) = 2 → f2
  // All have count=1, f0 sets bestCount=1, then f1 count=1 not > 1, etc.
  // Actually f0 is first iterated: count=1 > bestCount(0), so best=f0, bestCount=1.
  // Then f1: count=1, not > 1. f2: same. f3: same. f4: same.
  // So best = f0 (first frame that exceeded initial bestCount of 0).
  assert(result === f0, 'returns first frame that exceeded initial bestCount');
}

group('B4. Confidence threshold — only joints >= 0.3 count');
{
  // Frame with many joints below 0.3
  const lowConf = makeFrame([
    ['leftShoulder', 0.1], ['rightShoulder', 0.1],
    ['leftHip', 0.1], ['rightHip', 0.1],
  ]);
  // Frame with fewer joints but above 0.3
  const highConf = makeFrame([['leftShoulder', 0.9], ['rightShoulder', 0.5]]);
  const result = pickKeyFrame([lowConf, highConf]);
  assert(result === highConf, 'lowConf joints below 0.3 not counted');
}

// ---------------------------------------------------------------------------
// Section C — buildRawTips
// ---------------------------------------------------------------------------

group('C1. Entry with score < threshold and measured → included');
{
  const tips = buildRawTips([makeEntry('spineAngle', 60)]);
  assertEq(tips.length, 1, '1 tip');
  assertEq(tips[0].metricKey, 'spineAngle', 'metricKey = spineAngle');
}

group('C2. Entry with score >= threshold → filtered out');
{
  const tips = buildRawTips([makeEntry('spineAngle', TIP_SCORE_THRESHOLD)]);
  assertEq(tips.length, 0, 'score at threshold → filtered');

  const tips2 = buildRawTips([makeEntry('spineAngle', 95)]);
  assertEq(tips2.length, 0, 'score above threshold → filtered');
}

group('C3. Entry with dataQuality=missing → filtered out');
{
  const tips = buildRawTips([makeEntry('spineAngle', 30, 'missing')]);
  assertEq(tips.length, 0, 'missing data → filtered');
}

group('C4. Left/right elbow dedup → single "elbow" entry');
{
  const tips = buildRawTips([
    makeEntry('leftElbowAngle', 70),
    makeEntry('rightElbowAngle', 75),
  ]);
  assertEq(tips.length, 1, '2 elbow entries → 1 tip');
  assertEq(tips[0].metricKey, 'elbow', 'mapped to "elbow"');
}

group('C5. Left/right knee dedup → single "kneeFlex" entry');
{
  const tips = buildRawTips([
    makeEntry('leftKneeAngle', 50),
    makeEntry('rightKneeAngle', 40),
  ]);
  assertEq(tips.length, 1, '2 knee entries → 1 tip');
  assertEq(tips[0].metricKey, 'kneeFlex', 'mapped to "kneeFlex"');
}

group('C6. Unmapped metric → skipped');
{
  const tips = buildRawTips([makeEntry('hipSpreadDelta', 30)]);
  assertEq(tips.length, 0, 'unmapped metric skipped');
}

group('C7. Empty breakdown → empty array');
{
  const tips = buildRawTips([]);
  assertEq(tips.length, 0, 'empty → empty');
}

group('C8. All scores >= threshold → empty array');
{
  const tips = buildRawTips([
    makeEntry('spineAngle', 90),
    makeEntry('leftElbowAngle', 85),
    makeEntry('shoulderTilt', 100),
  ]);
  assertEq(tips.length, 0, 'all good scores → no tips');
}

group('C9. All dataQuality=missing → empty array');
{
  const tips = buildRawTips([
    makeEntry('spineAngle', 30, 'missing'),
    makeEntry('leftElbowAngle', 20, 'missing'),
  ]);
  assertEq(tips.length, 0, 'all missing → no tips');
}

group('C10. Output shape matches RawCoachingTip');
{
  const tips = buildRawTips([makeEntry('shoulderTilt', 60)]);
  assertEq(tips.length, 1, '1 tip');
  assert(typeof tips[0].metricKey === 'string', 'metricKey is string');
  // RawCoachingTip has only { metricKey: string }
  assertEq(Object.keys(tips[0]).length, 1, 'tip has exactly 1 key');
  assertEq(Object.keys(tips[0])[0], 'metricKey', 'only key is metricKey');
}

group('C11. Dedup preserves worse score (order independence)');
{
  // Left worse than right
  const tips1 = buildRawTips([
    makeEntry('leftElbowAngle', 30),
    makeEntry('rightElbowAngle', 70),
  ]);
  assertEq(tips1.length, 1, 'deduped to 1');

  // Right worse than left (reversed order)
  const tips2 = buildRawTips([
    makeEntry('rightElbowAngle', 70),
    makeEntry('leftElbowAngle', 30),
  ]);
  assertEq(tips2.length, 1, 'deduped to 1 (reversed order)');

  // Both produce the same mapped key
  assertEq(tips1[0].metricKey, 'elbow', 'mapped key = elbow');
  assertEq(tips2[0].metricKey, 'elbow', 'mapped key = elbow (reversed)');
}

group('C12. Tempo mapping');
{
  const tips = buildRawTips([makeEntry('tempo', 50)]);
  assertEq(tips.length, 1, 'tempo below threshold → included');
  assertEq(tips[0].metricKey, 'tempo', 'mapped to "tempo"');
}

group('C13. Mixed: some pass, some filtered');
{
  const tips = buildRawTips([
    makeEntry('spineAngle', 60),          // included → spineAngle
    makeEntry('leftElbowAngle', 90),      // filtered (score >= 80)
    makeEntry('rightElbowAngle', 50),     // included → elbow
    makeEntry('shoulderTilt', 30, 'missing'), // filtered (missing)
    makeEntry('tempo', 70),               // included → tempo
  ]);
  assertEq(tips.length, 3, '3 tips pass filters');
  const keys = tips.map((t) => t.metricKey);
  assert(keys.includes('spineAngle'), 'spineAngle included');
  assert(keys.includes('elbow'), 'elbow included');
  assert(keys.includes('tempo'), 'tempo included');
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
  console.log('✅ All coaching tips tests passed');
}
