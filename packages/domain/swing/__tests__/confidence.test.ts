/**
 * packages/domain/swing/__tests__/confidence.test.ts
 *
 * Pure-function tests for Task 6 confidence module.
 * Run with: npx jest confidence.test.ts (or ts-jest)
 *
 * Tests the math and logic without needing the full app.
 * Scoring functions are private — tested through the public API
 * by constructing inputs that isolate each component.
 */

import {
  computeSwingConfidence,
  getAllowedMetricsForTier,
  shouldShowMetric,
  type SwingConfidence,
} from '../confidenceScore';
import type { CameraAngleResult } from '../cameraAngle';
import type { PoseFrame } from '../../../pose/PoseTypes';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Build a minimal PoseFrame with key joints at given confidence */
function makeFrame(jointConfidence: number): PoseFrame {
  const joints: Record<string, { x: number; y: number; z: number; confidence: number }> = {};
  const keys = [
    'leftShoulder', 'rightShoulder', 'leftHip', 'rightHip',
    'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
    'leftKnee', 'rightKnee',
  ];
  for (const key of keys) {
    joints[key] = { x: 0.5, y: 0.5, z: 0, confidence: jointConfidence };
  }
  return { joints, timestampMs: 0, frameWidth: 1920, frameHeight: 1080 } as PoseFrame;
}

/**
 * Build a PoseFrame with mixed joint confidence.
 * First `highCount` key joints get highConf, rest get lowConf.
 */
function makeMixedFrame(highCount: number, highConf: number, lowConf: number): PoseFrame {
  const keys = [
    'leftShoulder', 'rightShoulder', 'leftHip', 'rightHip',
    'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
    'leftKnee', 'rightKnee',
  ];
  const joints: Record<string, { x: number; y: number; z: number; confidence: number }> = {};
  for (let i = 0; i < keys.length; i++) {
    joints[keys[i]] = {
      x: 0.5, y: 0.5, z: 0,
      confidence: i < highCount ? highConf : lowConf,
    };
  }
  return { joints, timestampMs: 0, frameWidth: 1920, frameHeight: 1080 } as PoseFrame;
}

/** Build N frames with given joint confidence */
function makeFrames(count: number, jointConfidence: number) {
  return Array.from({ length: count }, () => makeFrame(jointConfidence));
}

/** Build a CameraAngleResult with realistic weight tables */
function makeCameraResult(angle: 'front' | 'side' | 'unknown', avgSpread = 0.15): CameraAngleResult {
  const weights = {
    spineAngle: angle === 'front' ? 0.4 : angle === 'side' ? 1.0 : 0.4,
    leftElbowAngle: angle === 'front' ? 0.9 : 0.6,
    rightElbowAngle: angle === 'front' ? 0.9 : 0.6,
    leftKneeAngle: angle === 'front' ? 0.6 : 1.0,
    rightKneeAngle: angle === 'front' ? 0.6 : 1.0,
    hipRotation: angle === 'front' ? 1.0 : 0.2,
    shoulderTilt: angle === 'front' ? 0.7 : 1.0,
    tempo: 1.0,
  };
  return {
    angle,
    shoulderSpread: avgSpread + 0.02,
    hipSpread: avgSpread - 0.02,
    avgSpread,
    weights,
  };
}

// ── Core confidence tests ────────────────────────────────────────────────────

describe('computeSwingConfidence', () => {
  test('high confidence: good data, known angle, heuristic phases, many frames', () => {
    const frames = makeFrames(80, 0.95);
    const camera = makeCameraResult('front', 0.25);
    const result = computeSwingConfidence(frames, camera, true);

    expect(result.overall).toBeGreaterThanOrEqual(0.75);
    expect(result.tier).toBe('high');
    expect(result.components.jointVisibility).toBeGreaterThan(0.9);
    expect(result.components.cameraAngle).toBeGreaterThanOrEqual(0.9);
    expect(result.components.phaseDetection).toBe(1.0);
    expect(result.components.frameCoverage).toBeGreaterThan(0.5);
  });

  test('medium confidence: unknown angle, heuristic phases', () => {
    const frames = makeFrames(60, 0.85);
    const camera = makeCameraResult('unknown', 0.115); // dead center of unknown zone
    const result = computeSwingConfidence(frames, camera, true);

    expect(result.overall).toBeGreaterThanOrEqual(0.50);
    expect(result.overall).toBeLessThan(0.75);
    expect(result.tier).toBe('medium');
    expect(result.components.cameraAngle).toBeLessThan(0.5);
  });

  test('low confidence: fallback phases, few frames, poor visibility', () => {
    const frames = makeFrames(15, 0.35);
    const camera = makeCameraResult('unknown', 0.115);
    const result = computeSwingConfidence(frames, camera, false);

    expect(result.overall).toBeLessThan(0.50);
    expect(result.tier).toBe('low');
    expect(result.components.phaseDetection).toBe(0.3);
  });

  test('fallback phases lower confidence vs heuristic, all else equal', () => {
    const frames = makeFrames(60, 0.9);
    const camera = makeCameraResult('front', 0.25);

    const heuristic = computeSwingConfidence(frames, camera, true);
    const fallback  = computeSwingConfidence(frames, camera, false);

    expect(heuristic.overall).toBeGreaterThan(fallback.overall);
    expect(heuristic.components.phaseDetection).toBe(1.0);
    expect(fallback.components.phaseDetection).toBe(0.3);
  });

  test('overall is always 0–1', () => {
    const high = computeSwingConfidence(
      makeFrames(200, 1.0), makeCameraResult('front'), true,
    );
    expect(high.overall).toBeLessThanOrEqual(1.0);

    const low = computeSwingConfidence(
      makeFrames(5, 0), makeCameraResult('unknown'), false,
    );
    expect(low.overall).toBeGreaterThanOrEqual(0);
  });

  test('empty frames → 0 confidence', () => {
    const result = computeSwingConfidence([], makeCameraResult('unknown'), false);
    expect(result.overall).toBe(0);
    expect(result.tier).toBe('low');
  });

  test('measurementFrameIndices filters visibility to specified frames', () => {
    const frames = [...makeFrames(10, 0.99), ...makeFrames(90, 0.1)];
    const camera = makeCameraResult('front');

    const filtered = computeSwingConfidence(frames, camera, true, [0,1,2,3,4,5,6,7,8,9]);
    const unfiltered = computeSwingConfidence(frames, camera, true);

    expect(filtered.components.jointVisibility).toBeGreaterThan(
      unfiltered.components.jointVisibility
    );
  });

  test('components weighted correctly (jv=0.40, ca=0.30, pd=0.20, fc=0.10)', () => {
    const frames = makeFrames(60, 0.9);
    const camera = makeCameraResult('front');
    const result = computeSwingConfidence(frames, camera, true);

    const expected =
      result.components.jointVisibility * 0.40 +
      result.components.cameraAngle * 0.30 +
      result.components.phaseDetection * 0.20 +
      result.components.frameCoverage * 0.10;

    expect(Math.abs(result.overall - expected)).toBeLessThan(0.001);
  });
});

// ── Camera angle scoring curve ───────────────────────────────────────────────

describe('camera angle scoring curve', () => {
  // Isolate camera component: perfect joints, heuristic, enough frames.
  // Only cameraAngle varies. Test via components.cameraAngle.

  test('front at boundary (0.15) scores 0.80', () => {
    const result = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('front', 0.15), true,
    );
    expect(result.components.cameraAngle).toBe(0.8);
  });

  test('front scales with clarity: 0.15 < 0.20 < 0.25', () => {
    const atBoundary = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('front', 0.15), true,
    );
    const midRange = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('front', 0.20), true,
    );
    const veryClear = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('front', 0.25), true,
    );

    expect(atBoundary.components.cameraAngle).toBe(0.8);
    expect(midRange.components.cameraAngle).toBe(0.9);
    expect(veryClear.components.cameraAngle).toBe(1.0);
  });

  test('side at boundary (0.08) scores 0.80', () => {
    const result = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('side', 0.08), true,
    );
    expect(result.components.cameraAngle).toBe(0.8);
  });

  test('side scales with clarity: 0.08 > 0.06 > 0.04', () => {
    const atBoundary = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('side', 0.08), true,
    );
    const midRange = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('side', 0.06), true,
    );
    const veryClear = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('side', 0.04), true,
    );

    expect(atBoundary.components.cameraAngle).toBeLessThan(midRange.components.cameraAngle);
    expect(midRange.components.cameraAngle).toBeLessThan(veryClear.components.cameraAngle);
    expect(veryClear.components.cameraAngle).toBe(1.0);
  });

  test('unknown at dead center (0.115) scores low', () => {
    const result = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('unknown', 0.115), true,
    );
    // nearness ≈ 0.125, score ≈ 0.10 + 0.20*0.125 = 0.125
    expect(result.components.cameraAngle).toBeLessThan(0.2);
    expect(result.components.cameraAngle).toBeGreaterThan(0);
  });

  test('unknown near front boundary (0.14) scores higher than dead center', () => {
    const nearFront = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('unknown', 0.14), true,
    );
    const deadCenter = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('unknown', 0.115), true,
    );
    expect(nearFront.components.cameraAngle).toBeGreaterThan(
      deadCenter.components.cameraAngle
    );
  });

  test('unknown near side boundary (0.09) scores higher than dead center', () => {
    const nearSide = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('unknown', 0.09), true,
    );
    const deadCenter = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('unknown', 0.115), true,
    );
    expect(nearSide.components.cameraAngle).toBeGreaterThan(
      deadCenter.components.cameraAngle
    );
  });
});

// ── Frame count graduation ───────────────────────────────────────────────────

describe('frame count scoring curve', () => {
  // Isolate frame coverage: perfect joints, known angle, heuristic.
  // Vary frame count. Test via components.frameCoverage.

  test('1 frame scores very low', () => {
    const result = computeSwingConfidence(
      makeFrames(1, 1.0), makeCameraResult('front', 0.25), true,
    );
    expect(result.components.frameCoverage).toBeLessThan(0.05);
    expect(result.components.frameCoverage).toBeGreaterThan(0);
  });

  test('below MIN_FRAMES (15): graduated, not cliff-edge', () => {
    const at5 = computeSwingConfidence(
      makeFrames(5, 1.0), makeCameraResult('front', 0.25), true,
    );
    const at10 = computeSwingConfidence(
      makeFrames(10, 1.0), makeCameraResult('front', 0.25), true,
    );
    const at14 = computeSwingConfidence(
      makeFrames(14, 1.0), makeCameraResult('front', 0.25), true,
    );

    // Monotonically increasing
    expect(at5.components.frameCoverage).toBeLessThan(at10.components.frameCoverage);
    expect(at10.components.frameCoverage).toBeLessThan(at14.components.frameCoverage);
    // All below the MIN_FRAMES knee at 0.3
    expect(at14.components.frameCoverage).toBeLessThan(0.3);
  });

  test('at MIN_FRAMES (15) scores 0.3', () => {
    const result = computeSwingConfidence(
      makeFrames(15, 1.0), makeCameraResult('front', 0.25), true,
    );
    expect(result.components.frameCoverage).toBe(0.3);
  });

  test('between MIN and GOOD: linear ramp 0.3 to 1.0', () => {
    const at30 = computeSwingConfidence(
      makeFrames(30, 1.0), makeCameraResult('front', 0.25), true,
    );
    const at45 = computeSwingConfidence(
      makeFrames(45, 1.0), makeCameraResult('front', 0.25), true,
    );

    expect(at30.components.frameCoverage).toBeGreaterThan(0.3);
    expect(at30.components.frameCoverage).toBeLessThan(at45.components.frameCoverage);
    expect(at45.components.frameCoverage).toBeLessThan(1.0);
  });

  test('at GOOD_FRAMES (60) and above scores 1.0', () => {
    const at60 = computeSwingConfidence(
      makeFrames(60, 1.0), makeCameraResult('front', 0.25), true,
    );
    const at100 = computeSwingConfidence(
      makeFrames(100, 1.0), makeCameraResult('front', 0.25), true,
    );

    expect(at60.components.frameCoverage).toBe(1.0);
    expect(at100.components.frameCoverage).toBe(1.0);
  });
});

// ── Joint visibility edge cases ──────────────────────────────────────────────

describe('joint visibility scoring', () => {
  test('mixed confidence within a single frame', () => {
    // 5 of 10 joints above threshold, 5 below
    const frames = [makeMixedFrame(5, 0.9, 0.2)];
    const camera = makeCameraResult('front', 0.25);
    const result = computeSwingConfidence(frames, camera, true);

    // avgVisibility = 5/10 = 0.5, cleanFrameRatio = 0 (not all visible)
    // score = 0.6 * 0.5 + 0.4 * 0 = 0.30
    expect(result.components.jointVisibility).toBe(0.3);
  });

  test('all joints below threshold → 0', () => {
    const frames = makeFrames(30, 0.4); // all below 0.5
    const camera = makeCameraResult('front', 0.25);
    const result = computeSwingConfidence(frames, camera, true);

    expect(result.components.jointVisibility).toBe(0);
  });

  test('out-of-bounds measurementFrameIndices are filtered out', () => {
    const frames = makeFrames(10, 0.99);
    const camera = makeCameraResult('front', 0.25);

    // Mix valid and invalid indices
    const result = computeSwingConfidence(frames, camera, true, [0, 1, 999, 5000]);

    // Only indices 0 and 1 are valid — visibility still high for those 2 frames
    expect(result.components.jointVisibility).toBeGreaterThan(0.9);
  });

  test('all measurementFrameIndices out of bounds → jointVisibility 0', () => {
    const frames = makeFrames(10, 0.99);
    const camera = makeCameraResult('front', 0.25);

    const result = computeSwingConfidence(frames, camera, true, [100, 200, 300]);

    // No valid frames → visibility = 0
    expect(result.components.jointVisibility).toBe(0);
  });
});

// ── Tier gating helpers ──────────────────────────────────────────────────────

describe('getAllowedMetricsForTier', () => {
  test('high → all', () => {
    expect(getAllowedMetricsForTier('high')).toBe('all');
  });

  test('medium → limited set with tempo, spine, shoulders, knees', () => {
    const allowed = getAllowedMetricsForTier('medium');
    expect(allowed).not.toBe('all');
    expect(allowed).not.toBe('none');
    const set = allowed as Set<string>;
    expect(set.has('tempo')).toBe(true);
    expect(set.has('spineAngle')).toBe(true);
    expect(set.has('shoulderTilt')).toBe(true);
    expect(set.has('leftKneeAngle')).toBe(true);
    expect(set.has('rightKneeAngle')).toBe(true);
    // Excluded
    expect(set.has('hipRotation')).toBe(false);
    expect(set.has('leftElbowAngle')).toBe(false);
    expect(set.has('rightElbowAngle')).toBe(false);
  });

  test('low → none', () => {
    expect(getAllowedMetricsForTier('low')).toBe('none');
  });

  test('medium returns defensive copy (mutation-safe)', () => {
    const first = getAllowedMetricsForTier('medium') as Set<string>;
    first.add('garbage');
    const second = getAllowedMetricsForTier('medium') as Set<string>;
    expect(second.has('garbage')).toBe(false);
  });
});

describe('shouldShowMetric', () => {
  const highConf: SwingConfidence = {
    overall: 0.85, tier: 'high',
    components: { jointVisibility: 0.9, cameraAngle: 0.95, phaseDetection: 1.0, frameCoverage: 0.8 },
  };
  const medConf: SwingConfidence = {
    overall: 0.6, tier: 'medium',
    components: { jointVisibility: 0.7, cameraAngle: 0.4, phaseDetection: 1.0, frameCoverage: 0.5 },
  };
  const lowConf: SwingConfidence = {
    overall: 0.3, tier: 'low',
    components: { jointVisibility: 0.4, cameraAngle: 0.3, phaseDetection: 0.3, frameCoverage: 0.2 },
  };

  test('high tier allows all metrics with sufficient weight', () => {
    const camera = makeCameraResult('front');
    expect(shouldShowMetric('hipRotation', highConf, camera)).toBe(true);  // weight 1.0
    expect(shouldShowMetric('tempo', highConf, camera)).toBe(true);        // weight 1.0
    expect(shouldShowMetric('spineAngle', highConf, camera)).toBe(true);   // weight 0.4
  });

  test('high tier blocks metrics with low camera weight', () => {
    const camera = makeCameraResult('side'); // hipRotation weight = 0.2
    expect(shouldShowMetric('hipRotation', highConf, camera)).toBe(false);
    expect(shouldShowMetric('spineAngle', highConf, camera)).toBe(true); // weight 1.0
  });

  test('medium tier only allows safe metrics', () => {
    const camera = makeCameraResult('front');
    expect(shouldShowMetric('tempo', medConf, camera)).toBe(true);
    expect(shouldShowMetric('spineAngle', medConf, camera)).toBe(true);
    expect(shouldShowMetric('shoulderTilt', medConf, camera)).toBe(true);
    expect(shouldShowMetric('hipRotation', medConf, camera)).toBe(false);
    expect(shouldShowMetric('leftElbowAngle', medConf, camera)).toBe(false);
  });

  test('low tier blocks everything', () => {
    const camera = makeCameraResult('front');
    expect(shouldShowMetric('tempo', lowConf, camera)).toBe(false);
    expect(shouldShowMetric('spineAngle', lowConf, camera)).toBe(false);
    expect(shouldShowMetric('hipRotation', lowConf, camera)).toBe(false);
  });

  test('weight exactly at threshold (0.3) passes', () => {
    // spineAngle from front = 0.4, but we test the boundary directly
    const camera: CameraAngleResult = {
      ...makeCameraResult('front', 0.25),
      weights: { ...makeCameraResult('front').weights, hipRotation: 0.3 },
    };
    expect(shouldShowMetric('hipRotation', highConf, camera)).toBe(true);
  });

  test('weight just below threshold (0.29) fails', () => {
    const camera: CameraAngleResult = {
      ...makeCameraResult('front', 0.25),
      weights: { ...makeCameraResult('front').weights, hipRotation: 0.29 },
    };
    expect(shouldShowMetric('hipRotation', highConf, camera)).toBe(false);
  });

  test('unknown metric name returns false', () => {
    const camera = makeCameraResult('front');
    expect(shouldShowMetric('nonExistentMetric', highConf, camera)).toBe(false);
  });
});
