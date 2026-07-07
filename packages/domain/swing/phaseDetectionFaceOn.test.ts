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
import type { FaceOnImpactConsensus } from './faceOnImpactConsensus';
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
      leadX: rw.x,   // canonical LEAD = right* (CANONICAL_LEAD); TRAIL = left*
      leadY: rw.y,
      trailX: lw.x,
      trailY: lw.y,
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

  // Lead (leftWrist) + trail (rightWrist): x rises through backswing (takeaway Δx>0).
  // The live top is now the canonical-x extreme of the lead landmarks; rightShoulder.x
  // peaks at ~frame 30 (then recedes) → X-extreme top ≈ 30, well clear of impact (45).
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
    { f: 0, x: 0.58, y: 0.30 }, { f: 30, x: 0.66, y: 0.29 }, { f: 45, x: 0.58, y: 0.30 },
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
// Case C — consensus is the PRIMARY impact; the arc-bottom cross-check is a FLAG, never a
// rejection (PR2 cutover). selectFaceOnImpact reads ONLY consensus.final; impactIdx = round(final).
// |delta| = |round(final) − arcBottom|: > crossCheckThresholdFrames (6) downgrades reliability to
// medium but KEEPS the consensus — there is no delta-reject (that would un-fix 9d1606a6, delta 23).
// ===========================================================================
console.log('\n── Case C: consensus is primary; cross-check is a flag, not a rejection ──');
{
  // Minimal fixture — the selector only reads consensus.final.
  const consensusWith = (final: number | null) => ({ final }) as unknown as FaceOnImpactConsensus;
  const select = (final: number, arcBottomFrame: number) =>
    selectFaceOnImpact({
      arcBottomFrame,
      consensus: consensusWith(final),
      isLeftHanded: false,
      hasPreCanonical: true,
      isOverride: false,
    });

  // (a) |delta| ≤ 6 → consensus, high reliability, no mismatch.
  {
    const s = select(112, 110); // delta 2
    assert(s.impactSource === 'consensus', 'Case C(a): impactSource=consensus');
    assert(s.impactIdx === 112, `Case C(a): impactIdx = round(final) 112 (got ${s.impactIdx})`);
    assert(s.impactReliability === 'high', `Case C(a): high reliability (|delta|=2) (got ${s.impactReliability})`);
    assert(s.impactCrossCheckMismatch === false, 'Case C(a): no cross-check mismatch');
  }

  // (b) 6 < |delta| → consensus KEPT, mismatch flag set, reliability downgraded medium.
  {
    const s = select(120, 110); // delta 10
    assert(s.impactSource === 'consensus', 'Case C(b): |delta|=10 stays consensus (flag, not reject)');
    assert(s.impactIdx === 120, `Case C(b): impactIdx 120 (got ${s.impactIdx})`);
    assert(s.impactReliability === 'medium', `Case C(b): downgraded medium (got ${s.impactReliability})`);
    assert(s.impactCrossCheckMismatch === true, 'Case C(b): cross-check mismatch flag set');
  }

  // (c) LARGE |delta| (>15 — what the OLD selector rejected) STILL stays consensus. The cross-check
  // never rejects. Encodes 9d1606a6: consensus 125 vs arc-bottom 102, delta 23 → kept, medium.
  {
    const s = select(125, 102); // delta 23
    assert(s.impactSource === 'consensus', 'Case C(c): |delta|=23 still consensus (no delta-reject)');
    assert(s.impactIdx === 125, `Case C(c): impactIdx = 125, NOT arc-bottom 102 (got ${s.impactIdx})`);
    assert(s.impactReliability === 'medium', `Case C(c): medium on mismatch (got ${s.impactReliability})`);
    assert(s.impactArcbottom === 102 && s.impactDelta === 23,
      `Case C(c): arc-bottom + delta recorded for provenance (got ${s.impactArcbottom}/${s.impactDelta})`);
  }

  // (d) sub-frame final rounds to the nearest integer impactIdx; the sub-frame value is recorded.
  {
    const s = select(124.6, 100);
    assert(s.impactIdx === 125, `Case C(d): round(124.6) = 125 (got ${s.impactIdx})`);
    assert(s.impactConsensusFinal === 124.6, 'Case C(d): sub-frame final recorded verbatim');
  }
}

// ===========================================================================
// Case D — per-reason arc-bottom FALLBACK (PR2). The consensus is the primary; arc-bottom is used
// only when the consensus cannot/should-not run, and every fallback carries reliability.impact=low
// so downstream can suppress a confident score. The consensus final is still recorded for provenance.
// ===========================================================================
console.log('\n── Case D: per-reason arc-bottom fallback (reliability low) ──');
{
  const consensusWith = (final: number | null) => ({ final }) as unknown as FaceOnImpactConsensus;
  const base = {
    arcBottomFrame: 130,
    consensus: consensusWith(150),
    isLeftHanded: false,
    hasPreCanonical: true,
    isOverride: false,
  };

  // (a) LH → CONSENSUS (gate removed) — LH runs the validated xCross consensus exactly like RH.
  //     consensus 150 vs arc-bottom 130 → cross-check mismatch (Δ20 > 6) downgrades high→medium.
  {
    const s = selectFaceOnImpact({ ...base, isLeftHanded: true });
    assert(s.impactSource === 'consensus' && s.impactFallbackReason === undefined,
      `Case D(a): LH → consensus (got ${s.impactSource}/${s.impactFallbackReason})`);
    assert(s.impactIdx === 150, `Case D(a): impactIdx = consensus 150 (got ${s.impactIdx})`);
    assert(s.impactReliability === 'medium', `Case D(a): reliability medium on mismatch (got ${s.impactReliability})`);
    assert(s.impactConsensusFinal === 150, 'Case D(a): consensus final recorded');
  }

  // (b) no pre-canonical (consensus null) → arc-bottom, no_precanonical, low.
  {
    const s = selectFaceOnImpact({ ...base, consensus: null, hasPreCanonical: false });
    assert(s.impactSource === 'arc_bottom' && s.impactFallbackReason === 'no_precanonical',
      `Case D(b): no preCanonical → arc_bottom/no_precanonical (got ${s.impactFallbackReason})`);
    assert(s.impactReliability === 'low', `Case D(b): reliability low (got ${s.impactReliability})`);
  }

  // (c) consensus ran but resolved nothing (final null = 0 geometric signals) → arc-bottom, no_signals, low.
  {
    const s = selectFaceOnImpact({ ...base, consensus: consensusWith(null) });
    assert(s.impactSource === 'arc_bottom' && s.impactFallbackReason === 'no_signals',
      `Case D(c): final null → arc_bottom/no_signals (got ${s.impactFallbackReason})`);
    assert(s.impactReliability === 'low', `Case D(c): reliability low (got ${s.impactReliability})`);
  }

  // (d) test-override seam → arc-bottom, override, low.
  {
    const s = selectFaceOnImpact({ ...base, isOverride: true });
    assert(s.impactSource === 'arc_bottom' && s.impactFallbackReason === 'override',
      `Case D(d): override → arc_bottom/override (got ${s.impactFallbackReason})`);
    assert(s.impactReliability === 'low', `Case D(d): reliability low (got ${s.impactReliability})`);
  }
}

// ---------------------------------------------------------------------------
// ===========================================================================
// Case D2 — finish rolling window at 120fps (even W)
//
// W = msToFrames(83ms rolling window): 5 at 60fps (odd) but 10 at 120fps
// (even). The interior window span is 2·floor(W/2)+1 = W+1 for even W, so the
// pre-fix `count === W` gate could never match an interior 120fps window —
// the whole rolling series nulled out and finish pinned to lastIdx with low
// reliability. Same real-time motion at both rates must find the same
// real-time plateau.
// ===========================================================================
console.log('\n── Case D2: finish plateau detected at 120fps (even rolling window) ──');
{
  // scale=2 → 120 frames @120fps; scale=1 → 60 frames @60fps.
  const buildFinishFixture = (scale: 1 | 2) => {
    const N = 60 * scale;
    const MS = 1000 / (60 * scale);
    const s = (f: number) => f * scale;
    const leadKF: KF[] = [
      { f: s(0), x: 0.50, y: 0.62 }, { f: s(11), x: 0.50, y: 0.62 },
      { f: s(28), x: 0.64, y: 0.32 }, { f: s(32), x: 0.645, y: 0.31 },
      { f: s(45), x: 0.50, y: 0.72 }, { f: s(59), x: 0.42, y: 0.55 },
    ];
    const trailKF: KF[] = [
      { f: s(0), x: 0.54, y: 0.62 }, { f: s(11), x: 0.54, y: 0.62 },
      { f: s(28), x: 0.60, y: 0.34 }, { f: s(32), x: 0.605, y: 0.33 },
      { f: s(45), x: 0.52, y: 0.70 }, { f: s(59), x: 0.46, y: 0.55 },
    ];
    const lShoKF: KF[] = [
      { f: s(0), x: 0.46, y: 0.30 }, { f: s(30), x: 0.50, y: 0.29 }, { f: s(59), x: 0.50, y: 0.30 },
    ];
    // rightShoulder present through the END: recedes to impact, then rises
    // and PLATEAUS from s(52) — the finish signal the rolling window reads.
    const rShoKF: KF[] = [
      { f: s(0), x: 0.58, y: 0.30 }, { f: s(30), x: 0.66, y: 0.29 }, { f: s(45), x: 0.58, y: 0.30 },
      { f: s(52), x: 0.72, y: 0.30 }, { f: s(59), x: 0.72, y: 0.30 },
    ];
    const frames: PoseFrame[] = [];
    for (let i = 0; i < N; i++) {
      const joints = createEmptyJoints();
      joints.leftWrist = joint('leftWrist', track(leadKF, i));
      joints.rightWrist = joint('rightWrist', track(trailKF, i));
      joints.leftShoulder = joint('leftShoulder', track(lShoKF, i));
      joints.rightShoulder = joint('rightShoulder', track(rShoKF, i));
      frames.push({ timestampMs: i * MS, joints, frameWidth: 1, frameHeight: 1 });
    }
    return { frames, trail: buildTrail(frames), MS, impactOverride: s(45), N };
  };

  // 120fps (even W=10): pre-fix this pinned finish to lastIdx / reliability low.
  {
    const fx = buildFinishFixture(2);
    const r = detectFaceOnPhases({
      canonical: { frames: fx.frames, source: 'test' },
      trail: fx.trail,
      msPerFrame: fx.MS,
      impactOverride: fx.impactOverride,
    });
    const ft = r.phases.find((p) => p.phase === 'follow_through');
    assert(r.fallbackGate === null && r.phases.length === 5,
      `D2 @120fps: 5 heuristic phases (gate=${r.fallbackGate})`);
    assert(ft != null && ft.index === 109,
      `D2 @120fps: finish lands on the plateau (got ${ft?.index}, want 109; pre-fix pinned near lastIdx ${fx.N - 1})`);
    const rel = (r.ruleDebug as { reliability?: { finish?: string } }).reliability?.finish;
    assert(rel === 'high', `D2 @120fps: finish reliability high (got ${rel}; pre-fix low)`);
  }

  // 60fps (odd W=5): identical real-time motion — behavior unchanged by the fix.
  {
    const fx = buildFinishFixture(1);
    const r = detectFaceOnPhases({
      canonical: { frames: fx.frames, source: 'test' },
      trail: fx.trail,
      msPerFrame: fx.MS,
      impactOverride: fx.impactOverride,
    });
    const ft = r.phases.find((p) => p.phase === 'follow_through');
    assert(r.fallbackGate === null && r.phases.length === 5,
      `D2 @60fps: 5 heuristic phases (gate=${r.fallbackGate})`);
    assert(ft != null && ft.index === 54,
      `D2 @60fps: finish at 54 — the same real-time instant as the 120fps pick (109/2≈54.5) (got ${ft?.index})`);
    const rel = (r.ruleDebug as { reliability?: { finish?: string } }).reliability?.finish;
    assert(rel === 'high', `D2 @60fps: finish reliability high (got ${rel})`);
  }
}

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All phaseDetectionFaceOn tests passed');
}
