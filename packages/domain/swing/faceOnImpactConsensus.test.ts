/**
 * faceOnImpactConsensus.test.ts — unit tests for the ported xCross CONSENSUS impact pipeline
 * (faceOnImpactConsensus.ts). Synthetic, deterministic; mirrors the standalone-tsx test style
 * used by phaseDetectionFaceOn.test.ts / faceOnImpactJoint.test.ts.
 *
 * Covers the four areas the PR1 plan calls out:
 *   1. detectXCross — sustained neg→pos crossing + sub-frame interpolation + conf/sustain gates.
 *   2. nearestAnchorCrossing — decoy rejection (early crossing outside the radius is skipped).
 *   3. consensus degradation — 3/2/0 available signals (median / avg / null).
 *   4. thumb refine — fires within ±refineRadius of the consensus anchor and wins FINAL.
 *
 * Run with: npx --yes tsx packages/domain/swing/faceOnImpactConsensus.test.ts
 */

import {
  createEmptyJoints,
  type JointName,
  type PoseFrame,
} from "../../pose/PoseTypes";
import {
  computeFaceOnImpactConsensus,
  detectXCross,
  median,
  nearestAnchorCrossing,
  rollingMedian5,
  type ImpactXRow,
  type XCrossing,
} from "./faceOnImpactConsensus";

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
function approx(a: number | null, b: number, eps = 1e-6): boolean {
  return a !== null && Number.isFinite(a) && Math.abs(a - b) < eps;
}

// ── synthetic RH swing builder ──────────────────────────────────────────────
// RH ⇒ leadSide=left. Window is the whole [0, N-1]. The wrist x rises through the feet midpoint
// (0.5) at f=16; the arc-y peaks at f=16; the thumb dx crosses 0 at f=16 — so a fully-populated
// swing should converge FINAL≈16. Toggles let us starve signals to test degradation.
type JSpec = Partial<Record<JointName, { x: number; y: number; c?: number }>>;
function frame(f: number, spec: JSpec): PoseFrame {
  const joints = createEmptyJoints();
  for (const k of Object.keys(spec) as JointName[]) {
    const s = spec[k]!;
    joints[k] = { name: k, x: s.x, y: s.y, confidence: s.c ?? 0.9 };
  }
  return { timestampMs: f * 33, joints, frameWidth: 1080, frameHeight: 1920 };
}
const N = 31;
function buildSeq(opts: { ankles: boolean; thumbs: boolean; gated: boolean }): PoseFrame[] {
  const frames: PoseFrame[] = [];
  for (let f = 0; f < N; f++) {
    const wristX = 0.4 + 0.01 * f; // crosses 0.56 (g=0.06 vs midpoint 0.5) at f=16
    const yArc = 0.2 + 0.03 * Math.min(f, 16) - 0.01 * Math.max(0, f - 16); // peak at f=16
    const wristY = opts.gated ? yArc : 0.1; // ungated ⇒ wrist ABOVE shoulder (gate fails)
    const spec: JSpec = {
      leftShoulder: { x: 0.5, y: 0.3 },
      rightShoulder: { x: 0.5, y: 0.3 },
      leftElbow: { x: 0.5, y: 0.4 },
      leftWrist: { x: wristX, y: wristY, c: 0.9 },
      rightWrist: { x: 0.5, y: wristY, c: 0.7 },
    };
    if (opts.ankles) {
      spec.leftAnkle = { x: 0.45, y: 0.95 };
      spec.rightAnkle = { x: 0.55, y: 0.95 };
    }
    if (opts.thumbs) {
      spec.leftThumb = { x: 0.5, y: wristY };
      spec.leftThumbTip = { x: 0.34 + 0.01 * f, y: wristY }; // dx = tip−base crosses 0 at f=16
    }
    frames.push(frame(f, spec));
  }
  return frames;
}

// ── 1. detectXCross ─────────────────────────────────────────────────────────
console.log("\n── detectXCross: sustained neg→pos crossing + sub-frame ──");
{
  const gs = [-0.2, -0.1, -0.02, 0.1, 0.2, 0.2];
  const rows: ImpactXRow[] = gs.map((g, i) => ({ frame: i, g, wristConf: 0.9, selWrist: "lead" }));
  const r = detectXCross(rows); // L=0.06 default
  // crossing between f=2 (g=-0.02) and f=3 (g=0.1): sub = 2 + (0.06−(−0.02))/(0.1−(−0.02)) = 2.6667
  assert(r.crossFrame === 3, `crossFrame === 3 (got ${r.crossFrame})`);
  assert(approx(r.cross, 2 + 0.08 / 0.12, 1e-4), `sub-frame ≈ 2.6667 (got ${r.cross})`);
  assert(r.crossings.length === 1, `exactly one crossing (got ${r.crossings.length})`);
}
{
  // conf gate: drop the b-frame confidence below the floor → no crossing.
  const gs = [-0.2, -0.02, 0.1, 0.2];
  const rows: ImpactXRow[] = gs.map((g, i) => ({
    frame: i,
    g,
    wristConf: i === 2 ? 0.5 : 0.9,
    selWrist: "lead",
  }));
  const r = detectXCross(rows);
  assert(r.crossFrame === null, `conf < floor at crossing ⇒ rejected (got ${r.crossFrame})`);
}
{
  // sustain gate: g pops positive for a single frame then falls back → not sustained.
  const gs = [-0.1, 0.1, -0.1, -0.1];
  const rows: ImpactXRow[] = gs.map((g, i) => ({ frame: i, g, wristConf: 0.9, selWrist: "lead" }));
  const r = detectXCross(rows);
  assert(r.crossFrame === null, `single-frame pop ⇒ not sustained (got ${r.crossFrame})`);
}

// ── 2. nearestAnchorCrossing ────────────────────────────────────────────────
console.log("\n── nearestAnchorCrossing: decoy rejection ──");
{
  const mk = (frameN: number): XCrossing => ({ frame: frameN, sub: frameN, wrist: "lead", conf: 0.9 });
  const crossings = [mk(3), mk(20)]; // an early decoy + the real one
  assert(nearestAnchorCrossing(crossings, 18, 11)?.frame === 20, "anchor 18 → picks 20, not 3");
  assert(nearestAnchorCrossing(crossings, 5, 11)?.frame === 3, "anchor 5 → picks 3");
  assert(nearestAnchorCrossing(crossings, 50, 11) === null, "anchor 50 → none in ±11");
  assert(nearestAnchorCrossing(crossings, null, 11) === null, "null anchor → null");
}

// ── helpers: median / rollingMedian5 ────────────────────────────────────────
console.log("\n── median / rollingMedian5 ──");
{
  assert(median([16, 10, 16]) === 16, "median([16,10,16]) === 16");
  assert(median([10, 16]) === 13, "median([10,16]) === 13 (mean of two)");
  assert(Number.isNaN(median([])), "median([]) === NaN");
  const rm = rollingMedian5([1, 1, 1, 10, 1, 1, 1]);
  assert(approx(rm[3], 1), `rollingMedian5 rejects a lone teleport spike (got ${rm[3]})`);
}

// ── 3 + 4. computeFaceOnImpactConsensus end-to-end ──────────────────────────
console.log("\n── consensus end-to-end: full signals → thumb wins FINAL≈16 ──");
{
  const r = computeFaceOnImpactConsensus({
    frames: buildSeq({ ankles: true, thumbs: true, gated: true }),
    lo: 0,
    hi: N - 1,
    isLeftHanded: false,
  });
  assert(r.footPick.frame === 5, `footPick = 5 (got ${r.footPick.frame})`);
  assert(r.s2.frame === 10, `S2 arm-vertical = 10 (got ${r.s2.frame})`);
  assert(r.s3.frame === 16, `S3 wrist-lowest = 16 (got ${r.s3.frame})`);
  assert(r.provAnchor === 10, `provAnchor = median(5,10,16) = 10 (got ${r.provAnchor})`);
  assert(approx(r.xCross, 16, 1e-6), `xCross sub-frame ≈ 16 (got ${r.xCross})`);
  assert(r.s1.frame === 16, `S1 xCross (nearest-anchor) = 16 (got ${r.s1.frame})`);
  assert(r.consensus === 16, `consensus = median(16,10,16) = 16 (got ${r.consensus})`);
  assert(r.thumb.qualifies, "thumb refine qualifies within ±6 of anchor");
  assert(approx(r.final, 16, 1e-6), `FINAL ≈ 16 from thumb (got ${r.final})`);
  assert(r.source === "thumb", `source = thumb (got ${r.source})`);
  assert(r.lowReliability === false, "lowReliability false (3 signals)");
  assert(r.signFlip === 1, "RH nominal signFlip = +1");
}
console.log("\n── consensus degradation: no ankles/thumbs → 2 signals, consensus wins ──");
{
  const r = computeFaceOnImpactConsensus({
    frames: buildSeq({ ankles: false, thumbs: false, gated: true }),
    lo: 0,
    hi: N - 1,
    isLeftHanded: false,
  });
  assert(r.s1.frame === null, "no ankles ⇒ S1 xCross unavailable");
  assert(r.s2.frame === 10 && r.s3.frame === 16, "S2/S3 still resolve");
  assert(r.consensus === 13, `consensus = avg(10,16) = 13 (got ${r.consensus})`);
  assert(r.source === "consensus", `source = consensus (no thumb) (got ${r.source})`);
  assert(approx(r.final, 13), `FINAL = 13 (got ${r.final})`);
  assert(r.lowReliability === false, "lowReliability false (2 signals)");
}
console.log("\n── lowReliability: ungated + no ankles/thumbs → 0 signals ──");
{
  const r = computeFaceOnImpactConsensus({
    frames: buildSeq({ ankles: false, thumbs: false, gated: false }),
    lo: 0,
    hi: N - 1,
    isLeftHanded: false,
  });
  assert(r.s1.frame === null && r.s2.frame === null && r.s3.frame === null, "0 signals available");
  assert(r.consensus === null, "consensus null");
  assert(r.final === null && r.source === "none", "FINAL null, source none");
  assert(r.lowReliability === true, "lowReliability true");
}
console.log("\n── signFlipOverride: forcing the wrong sign kills the crossing ──");
{
  const r = computeFaceOnImpactConsensus({
    frames: buildSeq({ ankles: true, thumbs: true, gated: true }),
    lo: 0,
    hi: N - 1,
    isLeftHanded: false,
    signFlipOverride: -1, // g = −(wristX−mid): never rises through +L ⇒ no xCross
  });
  assert(r.xCross === null, `wrong-sign override ⇒ no xCross crossing (got ${r.xCross})`);
  assert(r.signFlip === -1, "override reflected in signFlip");
}

console.log(`\n${failed === 0 ? "✅ PASS" : "❌ FAIL"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
