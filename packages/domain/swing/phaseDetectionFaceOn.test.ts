/**
 * phaseDetectionFaceOn.test.ts — H1 repro: trail-space vs frame-space index
 * conflation in the phase detectors.
 *
 * The pipeline assumes trail index === frame index, but buildTrailPoints
 * (analysisPipeline.ts:139) DROPS any frame missing a wrist, so a single
 * dropped-wrist frame makes trail.length < frames.length. Then:
 *
 *   Case A (face-on): the sub-detectors return FRAME indices, but the phase
 *     assembly indexes the TRAIL with them (phaseDetectionFaceOn.ts:505,507).
 *     With finish.frame = frames.length-1 >= trail.length, trail[finish] is
 *     undefined → `.timestamp` throws.
 *
 *   Case B (DTL): the detector returns TRAIL indices and stores them as
 *     phase.index, but downstream (computePhaseWindowedAngles, averageFrames,
 *     wristHinge) uses phase.index as a FRAME index. With a dropped frame, the
 *     stored index and its own timestamp refer to different frames (off by one).
 *
 * Documented intent: a phase's `index` is canonical/frame-space
 * (phaseDetectionFaceOn.ts:438-440), so `frames[phase.index].timestampMs`
 * must equal `phase.timestamp`. Both cases violate this on current code.
 *
 * Run with: npx --yes tsx packages/domain/swing/phaseDetectionFaceOn.test.ts
 */

import { detectFaceOnPhases, selectFaceOnImpact } from './phaseDetectionFaceOn';
import { detectDTLPhases } from './phaseDetectionDTL';
import type { SwingTrailPoint } from './phaseDetection';
import {
  createEmptyJoints,
  type PoseFrame,
  type NormalizedJoint,
  type JointName,
} from '../../pose/PoseTypes';

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

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type KF = { f: number; x: number; y: number };

/** Linear interpolation of a keyframed (x,y) track at frame i (clamped ends). */
function track(kfs: KF[], i: number): { x: number; y: number } {
  if (i <= kfs[0].f) return { x: kfs[0].x, y: kfs[0].y };
  const last = kfs[kfs.length - 1];
  if (i >= last.f) return { x: last.x, y: last.y };
  for (let k = 1; k < kfs.length; k++) {
    if (i <= kfs[k].f) {
      const a = kfs[k - 1];
      const b = kfs[k];
      const t = (i - a.f) / (b.f - a.f);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return { x: last.x, y: last.y };
}

function joint(name: JointName, p: { x: number; y: number }): NormalizedJoint {
  return { name, x: p.x, y: p.y, confidence: 0.9 };
}

/** Replicates analysisPipeline.buildTrailPoints: skip frames missing a wrist. */
function buildTrail(frames: PoseFrame[]): SwingTrailPoint[] {
  const points: SwingTrailPoint[] = [];
  for (const frame of frames) {
    const lw = frame.joints.leftWrist;
    const rw = frame.joints.rightWrist;
    if (!lw || !rw) continue;
    points.push({
      x: (lw.x + rw.x) / 2,
      y: (lw.y + rw.y) / 2,
      timestamp: frame.timestampMs,
      leadX: lw.x,
      leadY: lw.y,
      trailX: rw.x,
      trailY: rw.y,
    });
  }
  return points;
}

// ===========================================================================
// Case A — face-on frame-index-into-trail crash
// ===========================================================================
console.log('\n=== phaseDetectionFaceOn H1 ===');
console.log('\n── Case A: face-on assembly indexes trail with frame indices ──');
{
  const N = 60;
  const MS = 1000 / 120;

  // Lead (leftWrist) + trail (rightWrist): x rises through backswing (takeaway
  // Δx>0); rightWrist has a near-still dwell at ~frame 30 → top velocity min.
  const leadKF: KF[] = [
    { f: 0, x: 0.50, y: 0.62 }, { f: 11, x: 0.50, y: 0.62 },
    { f: 28, x: 0.64, y: 0.32 }, { f: 32, x: 0.645, y: 0.31 },
    { f: 45, x: 0.50, y: 0.72 }, { f: 59, x: 0.42, y: 0.55 },
  ];
  const trailKF: KF[] = [
    { f: 0, x: 0.54, y: 0.62 }, { f: 11, x: 0.54, y: 0.62 },
    { f: 28, x: 0.60, y: 0.34 }, { f: 32, x: 0.605, y: 0.33 },
    { f: 45, x: 0.52, y: 0.70 }, { f: 59, x: 0.46, y: 0.55 },
  ];
  const lShoKF: KF[] = [
    { f: 0, x: 0.46, y: 0.30 }, { f: 30, x: 0.50, y: 0.29 }, { f: 59, x: 0.50, y: 0.30 },
  ];
  const rShoKF: KF[] = [
    { f: 0, x: 0.58, y: 0.30 }, { f: 45, x: 0.60, y: 0.30 },
  ];

  const frames: PoseFrame[] = [];
  for (let i = 0; i < N; i++) {
    const joints = createEmptyJoints();
    // Frame 0: leftWrist missing → buildTrail drops the frame.
    if (i !== 0) joints.leftWrist = joint('leftWrist', track(leadKF, i));
    joints.rightWrist = joint('rightWrist', track(trailKF, i));
    joints.leftShoulder = joint('leftShoulder', track(lShoKF, i));
    // rightShoulder present only through impact → finish finds no plateau → lastIdx.
    if (i <= 45) joints.rightShoulder = joint('rightShoulder', track(rShoKF, i));
    frames.push({ timestampMs: i * MS, joints, frameWidth: 1, frameHeight: 1 });
  }

  const trail = buildTrail(frames);
  assert(trail.length === frames.length - 1,
    `Case A: dropped-wrist frame 0 → trail.length(${trail.length}) === frames.length-1(${frames.length - 1})`);

  let threw = false;
  let errMsg = '';
  let result: ReturnType<typeof detectFaceOnPhases> | null = null;
  try {
    result = detectFaceOnPhases({
      canonical: { frames, source: 'test' },
      trail,
      msPerFrame: MS,
      impactOverride: 45, // valid in-array frame; pins impact so top/finish/gates run
    });
  } catch (e) {
    threw = true;
    errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  if (threw) {
    console.log(`  (threw: ${errMsg})`);
  } else if (result) {
    console.log(`  (returned phases=${result.phases.length}, gate=${result.fallbackGate})`);
  }

  // Documented intent: detector returns 5 phases without throwing, and each
  // phase's stored index/timestamp refer to the same frame.
  assert(!threw, 'Case A: detectFaceOnPhases does not throw on a dropped-wrist sequence');

  if (!threw && result) {
    assert(result.fallbackGate === null && result.phases.length === 5,
      `Case A: produces 5 heuristic phases (gate=${result.fallbackGate})`);
    let invariantOk = result.phases.length === 5;
    for (const p of result.phases) {
      const f = frames[p.index];
      if (!f || f.timestampMs !== p.timestamp) invariantOk = false;
    }
    assert(invariantOk, 'Case A: frames[phase.index].timestampMs === phase.timestamp for every phase');
  }
}

// ===========================================================================
// Case B — DTL trail-index-used-as-frame-index window corruption (no crash)
// ===========================================================================
console.log('\n── Case B: DTL stores a trail index that downstream reads as a frame index ──');
{
  const N = 70;
  const MS = 20; // 50 fps; msToFrames windows stay small

  // leftWrist (lead) x: rise → local min at ~frame 31 (DTL top) → rise ≥10 frames.
  const leadKF: KF[] = [
    { f: 0, x: 0.50, y: 0.60 }, { f: 9, x: 0.50, y: 0.60 },
    { f: 28, x: 0.66, y: 0.34 }, { f: 31, x: 0.61, y: 0.30 },
    { f: 45, x: 0.73, y: 0.66 }, { f: 48, x: 0.70, y: 0.82 },
    { f: 55, x: 0.66, y: 0.70 }, { f: 69, x: 0.55, y: 0.50 },
  ];
  // rightWrist (trail): midpoint y peaks (hands lowest) at ~frame 48 → impact ≈ 51.
  const trailKF: KF[] = [
    { f: 0, x: 0.54, y: 0.60 }, { f: 9, x: 0.54, y: 0.60 },
    { f: 31, x: 0.58, y: 0.32 }, { f: 48, x: 0.56, y: 0.80 },
    { f: 69, x: 0.50, y: 0.52 },
  ];
  const lShoKF: KF[] = [{ f: 0, x: 0.46, y: 0.30 }, { f: 69, x: 0.50, y: 0.30 }];
  const rShoKF: KF[] = [{ f: 0, x: 0.58, y: 0.30 }, { f: 69, x: 0.60, y: 0.30 }];
  const lHipKF: KF[] = [{ f: 0, x: 0.46, y: 0.55 }, { f: 69, x: 0.48, y: 0.55 }];
  const rHipKF: KF[] = [{ f: 0, x: 0.56, y: 0.55 }, { f: 69, x: 0.54, y: 0.55 }];

  const frames: PoseFrame[] = [];
  for (let i = 0; i < N; i++) {
    const joints = createEmptyJoints();
    if (i !== 0) joints.leftWrist = joint('leftWrist', track(leadKF, i)); // frame 0 dropped
    joints.rightWrist = joint('rightWrist', track(trailKF, i));
    joints.leftShoulder = joint('leftShoulder', track(lShoKF, i));
    joints.rightShoulder = joint('rightShoulder', track(rShoKF, i));
    joints.leftHip = joint('leftHip', track(lHipKF, i));
    joints.rightHip = joint('rightHip', track(rHipKF, i));
    // knees/ankles/nose omitted → detectDTLTrueAddress returns null → address falls
    // back to the takeaway trail index (keeps the case on top/impact).
    frames.push({ timestampMs: i * MS, joints, frameWidth: 1, frameHeight: 1 });
  }

  const trail = buildTrail(frames);
  assert(trail.length === frames.length - 1,
    `Case B: dropped-wrist frame 0 → trail.length(${trail.length}) === frames.length-1(${frames.length - 1})`);

  const result = detectDTLPhases({ canonical: { frames, source: 'test' }, trail, msPerFrame: MS });
  console.log(`  (returned phases=${result.phases.length}, gate=${result.fallbackGate})`);

  assert(result.fallbackGate === null && result.phases.length === 5,
    `Case B: produces 5 heuristic phases (gate=${result.fallbackGate})`);

  if (result.phases.length === 5) {
    const top = result.phases.find(p => p.phase === 'top')!;
    const impact = result.phases.find(p => p.phase === 'impact')!;

    // Documented intent: index is frame-space → frames[index].timestampMs === timestamp.
    const topFrame = frames[top.index];
    const impactFrame = frames[impact.index];
    console.log(`  (top: index=${top.index} frames[index].ts=${topFrame?.timestampMs} phase.ts=${top.timestamp})`);
    console.log(`  (impact: index=${impact.index} frames[index].ts=${impactFrame?.timestampMs} phase.ts=${impact.timestamp})`);

    assert(topFrame != null && topFrame.timestampMs === top.timestamp,
      'Case B: frames[topPhase.index].timestampMs === topPhase.timestamp');
    assert(impactFrame != null && impactFrame.timestampMs === impact.timestamp,
      'Case B: frames[impactPhase.index].timestampMs === impactPhase.timestamp');

    // The pipeline reads frames[impact.index ± 2] as the impact angle window.
    // Intent: that window is centred on the frame the detector meant (the one
    // whose timestampMs === phase.timestamp). On current code phase.index points
    // one frame early, so the window is mis-centred.
    const intendedCenter = frames.findIndex(f => f.timestampMs === impact.timestamp);
    assert(intendedCenter === impact.index,
      `Case B: impact angle-window center (frames[${impact.index}]) matches the meant frame (${intendedCenter})`);
  }
}

// ===========================================================================
// Case C — delta-reject impact gate (selectFaceOnImpact)
// |delta| = |impact_thumb − impact_arcbottom|. Reject thumb → arc-bottom when
// |delta| > impactRejectDeltaFrames (15). 6 < |delta| ≤ 15 keeps thumb but
// downgrades reliability (unchanged). |delta| ≤ 6 keeps thumb at high reliability.
// ===========================================================================
console.log('\n── Case C: delta-reject impact gate ──');
{
  // Helper: build a take-last thumb result (structural — ThumbCrossingResult shape).
  const thumbAt = (frame: number) => ({
    frame, coverage: 1, nCrossings: 1, reason: 'ok' as const,
  });
  const select = (thumbFrame: number, arcBottomFrame: number) =>
    selectFaceOnImpact({
      arcBottomFrame,
      thumb: thumbAt(thumbFrame),
      isLeftHanded: false,
      hasPreCanonical: true,
      isOverride: false,
    });

  // (a) |delta| > 15 → reject → arc-bottom (mirrors 120ef93c: thumb 90 vs arc-bottom 114).
  {
    const s = select(90, 114); // delta = -24, |delta| = 24 > 15
    assert(s.impactSource === 'arc_bottom', 'Case C(a): |delta|=24 → impactSource=arc_bottom');
    assert(s.impactFallbackReason === 'cross_check_mismatch',
      `Case C(a): fallback reason = cross_check_mismatch (got ${s.impactFallbackReason})`);
    assert(s.impactIdx === 114, `Case C(a): impactIdx = arc-bottom 114 (got ${s.impactIdx})`);
  }

  // (b) 6 < |delta| ≤ 15 → thumb KEPT, reliability downgraded medium (unchanged behavior).
  {
    const s = select(120, 110); // delta = 10
    assert(s.impactSource === 'thumb_crossing', 'Case C(b): |delta|=10 → impactSource=thumb_crossing');
    assert(s.impactIdx === 120, `Case C(b): impactIdx = thumb 120 (got ${s.impactIdx})`);
    assert(s.impactReliability === 'medium', `Case C(b): reliability downgraded medium (got ${s.impactReliability})`);
    assert(s.impactCrossCheckMismatch === true, 'Case C(b): cross_check_mismatch flag set (downgrade)');
  }

  // (c) |delta| ≤ 6 → thumb KEPT, high reliability (no-op regression).
  {
    const s = select(112, 110); // delta = 2
    assert(s.impactSource === 'thumb_crossing', 'Case C(c): |delta|=2 → impactSource=thumb_crossing');
    assert(s.impactIdx === 112, `Case C(c): impactIdx = thumb 112 (got ${s.impactIdx})`);
    assert(s.impactReliability === 'high', `Case C(c): reliability high (got ${s.impactReliability})`);
    assert(s.impactCrossCheckMismatch === false, 'Case C(c): no cross-check mismatch');
  }

  // (d) reject routes to arc-bottom DIRECTLY — never to the (rejected) thumb frame. The
  // rejected thumb is still recorded in telemetry (impactThumb) but is NOT the chosen impact.
  {
    const s = select(60, 130); // delta = -70, |delta| = 70 > 15
    assert(s.impactIdx === 130 && s.impactIdx === s.impactArcbottom,
      `Case C(d): rejected → impactIdx = arc-bottom 130 (got ${s.impactIdx})`);
    assert(s.impactThumb === 60 && s.impactIdx !== s.impactThumb,
      'Case C(d): rejected thumb frame recorded but not selected (no walk-back)');
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All phaseDetectionFaceOn tests passed');
}
