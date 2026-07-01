/**
 * captureFlow.test.ts — unit tests for the pure capture-flow decision helpers.
 *
 * Run with: npx tsx packages/domain/swing/captureFlow.test.ts
 *
 * No jest — project-standard hand-rolled runner. Expected values derived from
 * the original tryNavigate gate and classification override in useSwingCapture.ts.
 */

import { computeNavigationBlockReason, deriveClassification } from './captureFlow';
import type { CaptureClassification } from './captureValidity';

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

// ---------------------------------------------------------------------------
// computeNavigationBlockReason — precedence: phase → analysis → video → navigated
// ---------------------------------------------------------------------------

group('computeNavigationBlockReason');
assertEq(
  computeNavigationBlockReason({ phase: 'capturing', analysisReady: true, video: 'file.mp4', navigated: false }),
  'phase',
  'phase ≠ complete → phase',
);
// precedence: phase wins even when every later condition would also block
assertEq(
  computeNavigationBlockReason({ phase: 'idle', analysisReady: false, video: 'pending', navigated: true }),
  'phase',
  'phase takes precedence over all others',
);
assertEq(
  computeNavigationBlockReason({ phase: 'complete', analysisReady: false, video: 'file.mp4', navigated: false }),
  'analysis',
  'complete + !analysisReady → analysis',
);
assertEq(
  computeNavigationBlockReason({ phase: 'complete', analysisReady: true, video: 'pending', navigated: false }),
  'video',
  'complete + ready + video pending → video',
);
assertEq(
  computeNavigationBlockReason({ phase: 'complete', analysisReady: true, video: 'file.mp4', navigated: true }),
  'navigated',
  'complete + ready + video ready + navigated → navigated',
);
assertEq(
  computeNavigationBlockReason({ phase: 'complete', analysisReady: true, video: 'file.mp4', navigated: false }),
  null,
  'all clear (video string) → null',
);
assertEq(
  computeNavigationBlockReason({ phase: 'complete', analysisReady: true, video: null, navigated: false }),
  null,
  'all clear (video null, not pending) → null',
);

// ---------------------------------------------------------------------------
// deriveClassification
// ---------------------------------------------------------------------------

group('deriveClassification');
const base: CaptureClassification = {
  validity: 'valid',
  frameCount: 30,
  goodFrameCount: 25,
  poseSuccessRate: 0.83,
  reason: null,
};

const passthrough = deriveClassification(base, null);
assert(passthrough === base, 'fallbackGateReason null → returns base unchanged (same object)');
assertEq(passthrough.validity, 'valid', 'passthrough validity preserved');
assertEq(passthrough.reason, null, 'passthrough reason preserved');

const overridden = deriveClassification(base, 'no-swing');
assertEq(overridden.validity, 'partial', 'fallbackGateReason set → validity partial');
assertEq(overridden.reason, 'no-swing', 'fallbackGateReason set → reason no-swing');
assertEq(overridden.frameCount, 30, 'frameCount preserved');
assertEq(overridden.goodFrameCount, 25, 'goodFrameCount preserved');
assertEq(overridden.poseSuccessRate, 0.83, 'poseSuccessRate preserved');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '✅' : '❌'} captureFlow: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
