import assert from 'node:assert';
import { rtmwToPoseFrame, UNMAPPED_JOINTS } from './rtmwAdapter';
import { Rtmw133Frame, Rtmw133Keypoint } from './Rtmw133Frame';
import { COCO_WHOLEBODY_NAMES } from './cocoWholebody';
import { JointName } from '../PoseTypes';

const FRAME_W = 1000;
const FRAME_H = 800;

function makeFrame(overrides: Record<number, Rtmw133Keypoint>): Rtmw133Frame {
  const keypoints: Rtmw133Keypoint[] = [];
  for (let i = 0; i < 133; i++) {
    keypoints[i] = overrides[i] ?? { x: 1, y: 1, confidence: 0.9 };
  }
  return { timestampMs: 0, keypoints, frameWidth: FRAME_W, frameHeight: FRAME_H };
}

function idxOf(name: string): number {
  const i = COCO_WHOLEBODY_NAMES.indexOf(name);
  assert.notStrictEqual(i, -1, `coco_wholebody name not found: ${name}`);
  return i;
}

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}

const traps: { joint: JointName; correct: string; wrong: string }[] = [
  { joint: 'leftIndex', correct: 'left_forefinger1', wrong: 'left_forefinger4' },
  { joint: 'rightIndex', correct: 'right_forefinger1', wrong: 'right_forefinger4' },
  { joint: 'leftThumb', correct: 'left_thumb1', wrong: 'left_thumb4' },
  { joint: 'rightThumb', correct: 'right_thumb1', wrong: 'right_thumb4' },
  { joint: 'leftThumbTip', correct: 'left_thumb4', wrong: 'left_thumb1' },
  { joint: 'rightThumbTip', correct: 'right_thumb4', wrong: 'right_thumb1' },
  { joint: 'leftPinky', correct: 'left_pinky_finger1', wrong: 'left_pinky_finger4' },
  { joint: 'rightPinky', correct: 'right_pinky_finger1', wrong: 'right_pinky_finger4' },
  { joint: 'leftFootIndex', correct: 'left_big_toe', wrong: 'left_small_toe' },
  { joint: 'rightFootIndex', correct: 'right_big_toe', wrong: 'right_small_toe' },
];

for (const t of traps) {
  check(`trap ${t.joint} maps to ${t.correct}, not ${t.wrong}`, () => {
    const correctIdx = idxOf(t.correct);
    const wrongIdx = idxOf(t.wrong);
    const frame = makeFrame({
      [correctIdx]: { x: 100, y: 200, confidence: 0.8 },
      [wrongIdx]: { x: 700, y: 600, confidence: 0.8 },
    });
    const joint = rtmwToPoseFrame(frame).joints[t.joint];
    assert.ok(joint, `${t.joint} should be defined`);
    assert.strictEqual(
      joint!.x, 100 / FRAME_W,
      `${t.joint}.x must come from ${t.correct} (0.1), not ${t.wrong} (0.7)`,
    );
    assert.strictEqual(joint!.y, 200 / FRAME_H, `${t.joint}.y must come from ${t.correct}`);
  });
}

check('all 29 mapped joints are defined when input has all 133 confidences > 0', () => {
  const frame = makeFrame({});
  const out = rtmwToPoseFrame(frame);
  const unmapped = new Set<string>(UNMAPPED_JOINTS);
  const allNames = Object.keys(out.joints) as JointName[];
  assert.strictEqual(allNames.length, 35, 'PoseFrame must have all 35 joint keys');
  for (const name of allNames) {
    if (unmapped.has(name)) {
      assert.strictEqual(out.joints[name], undefined, `${name} is unmapped — must be undefined`);
    } else {
      assert.ok(out.joints[name], `${name} is mapped — must be defined`);
    }
  }
});

check('exactly the 6 UNMAPPED_JOINTS stay undefined', () => {
  assert.strictEqual(UNMAPPED_JOINTS.length, 6, 'expected exactly 6 unmapped joints');
  const frame = makeFrame({});
  const out = rtmwToPoseFrame(frame);
  for (const name of UNMAPPED_JOINTS) {
    assert.strictEqual(out.joints[name], undefined, `${name} must be undefined`);
  }
});

check('confidence is passed through, not derived', () => {
  const noseIdx = idxOf('nose');
  const frame = makeFrame({ [noseIdx]: { x: 50, y: 50, confidence: 0.42 } });
  const out = rtmwToPoseFrame(frame);
  assert.strictEqual(out.joints.nose!.confidence, 0.42, 'confidence must be the passed-through value');
});

check('x and y are normalized 0..1 by frame dims', () => {
  const noseIdx = idxOf('nose');
  const frame = makeFrame({ [noseIdx]: { x: 500, y: 400, confidence: 0.9 } });
  const out = rtmwToPoseFrame(frame);
  assert.strictEqual(out.joints.nose!.x, 0.5, 'x = 500/1000');
  assert.strictEqual(out.joints.nose!.y, 0.5, 'y = 400/800');
});

check('z is undefined on every joint', () => {
  const frame = makeFrame({});
  const out = rtmwToPoseFrame(frame);
  for (const name of Object.keys(out.joints) as JointName[]) {
    const j = out.joints[name];
    if (j) assert.strictEqual(j.z, undefined, `${name}.z must be undefined`);
  }
});

console.log(`\n${passed} checks passed.`);
