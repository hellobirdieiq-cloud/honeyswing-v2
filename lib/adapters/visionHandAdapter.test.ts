/**
 * Phase 2A mandatory test (Risk Flag #5).
 *
 * Run: npx tsx lib/adapters/visionHandAdapter.test.ts
 *
 * Verifies the Apple Vision → MediaPipe joint id mapping bijectively covers
 * all 21 landmarks the classify-grip edge function expects, and that the
 * MediaPipe round-trip (HandResult → CanonicalHandFrame → HandResult)
 * preserves all coordinate and confidence values.
 */

import assert from 'node:assert/strict';
import type { HandResult } from '../handDetection';
import { HandJoint } from '../canonicalHandFrame';
import { mediapipeToCanonical } from './mediapipeHandAdapter';
import {
  APPLE_VISION_JOINT_TO_MP_ID,
  canonicalToHandResult,
  visionToCanonical,
  type AppleVisionHand,
  type AppleVisionHandResult,
  type AppleVisionJointName,
} from './visionHandAdapter';

type Case = { name: string; run: () => void };
const cases: Case[] = [];
const test = (name: string, run: () => void) => cases.push({ name, run });

test('Apple Vision → MediaPipe id mapping covers all 21 joints', () => {
  const expected: Array<[AppleVisionJointName, number]> = [
    ['wrist', HandJoint.WRIST],
    ['thumbCMC', HandJoint.THUMB_CMC],
    ['thumbMP', HandJoint.THUMB_MCP],
    ['thumbIP', HandJoint.THUMB_IP],
    ['thumbTip', HandJoint.THUMB_TIP],
    ['indexMCP', HandJoint.INDEX_MCP],
    ['indexPIP', HandJoint.INDEX_PIP],
    ['indexDIP', HandJoint.INDEX_DIP],
    ['indexTip', HandJoint.INDEX_TIP],
    ['middleMCP', HandJoint.MIDDLE_MCP],
    ['middlePIP', HandJoint.MIDDLE_PIP],
    ['middleDIP', HandJoint.MIDDLE_DIP],
    ['middleTip', HandJoint.MIDDLE_TIP],
    ['ringMCP', HandJoint.RING_MCP],
    ['ringPIP', HandJoint.RING_PIP],
    ['ringDIP', HandJoint.RING_DIP],
    ['ringTip', HandJoint.RING_TIP],
    ['littleMCP', HandJoint.PINKY_MCP],
    ['littlePIP', HandJoint.PINKY_PIP],
    ['littleDIP', HandJoint.PINKY_DIP],
    ['littleTip', HandJoint.PINKY_TIP],
  ];
  assert.equal(expected.length, 21, 'Expected table must cover all 21 joints');
  for (const [appleName, mpId] of expected) {
    assert.equal(
      APPLE_VISION_JOINT_TO_MP_ID[appleName],
      mpId,
      `"${appleName}" should map to MP id ${mpId}`,
    );
  }
  assert.equal(
    Object.keys(APPLE_VISION_JOINT_TO_MP_ID).length,
    21,
    'Mapping table itself must declare exactly 21 entries',
  );
});

test('Mapping codomain is exactly {0, 1, ..., 20}', () => {
  const mpIds = Object.values(APPLE_VISION_JOINT_TO_MP_ID).sort((a, b) => a - b);
  assert.deepEqual(mpIds, Array.from({ length: 21 }, (_, i) => i));
});

test('Apple → MP mapping is one-to-one (no MP id reused)', () => {
  const mpIds = Object.values(APPLE_VISION_JOINT_TO_MP_ID);
  assert.equal(new Set(mpIds).size, mpIds.length);
});

test('visionToCanonical sorts points by joint id ascending', () => {
  const hand: AppleVisionHand = {
    chirality: 'right',
    score: 0.95,
    joints: {
      littleTip: { x: 0.9, y: 0.1, confidence: 0.8 },
      wrist: { x: 0.5, y: 0.5, confidence: 0.99 },
      thumbCMC: { x: 0.4, y: 0.4, confidence: 0.9 },
    },
  };
  const [frame] = visionToCanonical([hand]);
  assert.deepEqual(
    frame.points.map((p) => p.joint),
    [HandJoint.WRIST, HandJoint.THUMB_CMC, HandJoint.PINKY_TIP],
  );
});

test('visionToCanonical: Apple chirality → HandLabel', () => {
  const result: AppleVisionHandResult = [
    { chirality: 'left', score: 0.9, joints: {} },
    { chirality: 'right', score: 0.9, joints: {} },
    { chirality: 'unknown', score: 0.9, joints: {} },
  ];
  const frames = visionToCanonical(result);
  assert.equal(frames[0].handedness, 'Left');
  assert.equal(frames[1].handedness, 'Right');
  assert.equal(frames[2].handedness, 'Unknown');
});

test('visionToCanonical: handIndex assigned by array position', () => {
  const result: AppleVisionHandResult = [
    { chirality: 'left', score: 0.9, joints: {} },
    { chirality: 'right', score: 0.9, joints: {} },
  ];
  const frames = visionToCanonical(result);
  assert.equal(frames[0].handIndex, 0);
  assert.equal(frames[1].handIndex, 1);
});

test('visionToCanonical: every emitted point carries detectorType=apple_vision', () => {
  const result: AppleVisionHandResult = [
    {
      chirality: 'left',
      score: 0.9,
      joints: { wrist: { x: 0.5, y: 0.5, confidence: 0.95 } },
    },
  ];
  const [frame] = visionToCanonical(result);
  assert.equal(frame.detectorType, 'apple_vision');
});

test('MediaPipe round-trip: HandResult → canonical → HandResult preserves coords + visibility', () => {
  const original: HandResult[] = [
    {
      handIndex: 0,
      label: 'Right',
      score: 0.93,
      landmarks: Array.from({ length: 21 }, (_, i) => ({
        id: i,
        name: `synthetic_${i}`,
        x: 0.05 + 0.04 * i,
        y: 0.95 - 0.04 * i,
        z: -0.1 + 0.01 * i,
        visibility: 0.5 + 0.02 * i,
      })),
    },
  ];

  const roundTripped = canonicalToHandResult(mediapipeToCanonical(original));

  assert.equal(roundTripped.length, 1);
  assert.equal(roundTripped[0].handIndex, original[0].handIndex);
  assert.equal(roundTripped[0].label, original[0].label);
  assert.equal(roundTripped[0].score, original[0].score);
  assert.equal(roundTripped[0].landmarks.length, 21);

  for (let i = 0; i < 21; i++) {
    const o = original[0].landmarks[i];
    const r = roundTripped[0].landmarks[i];
    assert.equal(r.id, o.id, `landmark ${i}: id`);
    assert.equal(r.x, o.x, `landmark ${i}: x`);
    assert.equal(r.y, o.y, `landmark ${i}: y`);
    assert.equal(r.z, o.z, `landmark ${i}: z`);
    assert.equal(r.visibility, o.visibility, `landmark ${i}: visibility`);
  }
});

test('MediaPipe round-trip: unknown label collapses to Unknown then renders as Unknown', () => {
  const original: HandResult[] = [
    { handIndex: 0, label: 'gibberish', score: 0.5, landmarks: [] },
  ];
  const roundTripped = canonicalToHandResult(mediapipeToCanonical(original));
  assert.equal(roundTripped[0].label, 'Unknown');
});

let failed = 0;
for (const c of cases) {
  try {
    c.run();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${c.name}`);
    console.error(err);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} test(s) passed`);
if (failed > 0) process.exit(1);
