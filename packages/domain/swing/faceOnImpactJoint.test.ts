/**
 * faceOnImpactJoint.test.ts — pins the JOINT CHOICE of the face-on arc-bottom
 * impact detector (detectFaceOnImpact, phaseDetectionFaceOn.ts).
 *
 * Background: canonical `leftWrist` is the TRAIL wrist (canonicalTransform.ts
 * CANONICAL_TRAIL / M docstring).
 * The detector reads `leftWrist` (trail). A prior ticket suspected this was a bug
 * and proposed switching to `rightWrist` (lead). That was FALSIFIED on the real
 * `swings` population (scratchpad/leadVsTrailImpact.ts): on RH swings whose impact
 * is set by the INDEPENDENT thumb-crossing, the TRAIL arc-bottom matches true
 * impact to within Δ0–3 frames (11/13), while the LEAD arc-bottom misses by up to
 * ~60+ frames and regresses LH gating. So the trail wrist is correct.
 *
 * T1 is a GUARD (true-by-construction for the joint choice): it FAILS if anyone
 * switches detectFaceOnImpact from leftWrist→rightWrist. It does NOT itself prove
 * trail is anatomically correct — that proof is the real paired RH+LH data above.
 * T2 pins the mirror invariants the detector relies on (y unchanged, 2D speed
 * magnitude unchanged), which is the only invariance a synthetic can show
 * non-tautologically.
 *
 * Run with: npx --yes tsx packages/domain/swing/faceOnImpactJoint.test.ts
 */

import { detectFaceOnImpact } from "./phaseDetectionFaceOn";
import { toCanonicalFrame } from "./canonicalTransform";
import {
  createEmptyJoints,
  type PoseFrame,
  type NormalizedJoint,
} from "../../pose/PoseTypes";

let passed = 0;
let failed = 0;
function assert(condition: boolean, label: string): void {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ FAIL: ${label}`); failed++; }
}

// --- Fixture: two wrists, each with a fast Y-arc-bottom in its OWN high-speed band
// at a DIFFERENT frame. leftWrist (trail) bottoms at frame A=10; rightWrist (lead)
// bottoms at frame B=30. The detector reads leftWrist, so it must return A=10.
const N = 44;
const A_TRAIL = 10;
const B_LEAD = 32;
const HALF = 6; // half-width of each wrist's fast window

// A wrist that sweeps fast at constant rate across [center-HALF .. center+HALF] with
// y a tent peaking (UNIQUE max) at `center`; static at the window edge value outside.
// Constant interior speed → a wide high-speed band whose interior contains the y-max.
function wristAt(i: number, center: number): { x: number; y: number } {
  const d = i - center;
  const dc = Math.max(-HALF, Math.min(HALF, d)); // clamp x outside the window (no jump)
  const x = 0.1 + (dc + HALF) * 0.06; // fast linear sweep, Δ0.06/frame inside
  const y = Math.abs(d) <= HALF ? 0.9 - 0.06 * Math.abs(d) : 0.3; // peak 0.9 at center
  return { x, y };
}

const frames: PoseFrame[] = [];
for (let i = 0; i < N; i++) {
  const joints = createEmptyJoints();
  const lw = wristAt(i, A_TRAIL);
  const rw = wristAt(i, B_LEAD);
  joints.leftWrist = { name: "leftWrist", x: lw.x, y: lw.y, z: 0, confidence: 0.99 };
  joints.rightWrist = { name: "rightWrist", x: rw.x, y: rw.y, z: 0, confidence: 0.99 };
  frames.push({ timestampMs: i * 33, joints, frameWidth: 1, frameHeight: 1 });
}

// Local copy of the production algorithm, parameterized by joint — used ONLY to show
// the fixture genuinely discriminates (lead arc-bottom lands at B, not A).
function arcBottomJoint(fs: PoseFrame[], j: "leftWrist" | "rightWrist"): number | null {
  const n = fs.length;
  const speed = new Array<number>(n).fill(0);
  for (let f = 3; f < n; f++) {
    const a = fs[f - 3].joints[j]; const b = fs[f].joints[j];
    if (!a || !b) continue;
    speed[f] = Math.hypot(b.x - a.x, b.y - a.y);
  }
  const sorted = [...speed].sort((p, q) => p - q);
  const peak = sorted[Math.min(Math.floor(0.95 * n), n - 1)];
  if (!(peak > 0)) return null;
  const floor = 0.9 * peak;
  let best: number | null = null, bestY = -Infinity;
  for (let f = 0; f < n; f++) {
    if (speed[f] < floor) continue;
    const y = fs[f].joints[j]?.y; if (y == null) continue;
    if (y > bestY) { bestY = y; best = f; }
  }
  return best;
}

console.log("\n── T1: detectFaceOnImpact pins the TRAIL wrist (leftWrist) ──");
const result = detectFaceOnImpact(frames, 33);
const trailFrame = arcBottomJoint(frames, "leftWrist"); // canonical TRAIL wrist
const leadFrame = arcBottomJoint(frames, "rightWrist"); // canonical LEAD wrist
console.log(`  detector.frame=${result.frame}  trailArcBottom=${trailFrame}  leadArcBottom=${leadFrame}`);
// The two joints must land on different frames, else T1 cannot discriminate.
assert(trailFrame != null && leadFrame != null && trailFrame !== leadFrame,
  `fixture discriminates: trail(${trailFrame}) !== lead(${leadFrame})`);
// Production must follow the TRAIL wrist. A leftWrist→rightWrist switch would make
// detector.frame === leadFrame (${leadFrame}) and fail this assertion.
assert(result.frame === trailFrame,
  `detector tracks the TRAIL wrist (frame ${trailFrame}); a switch to rightWrist would return ${leadFrame}`);

console.log("\n── T2: mirror invariants the detector relies on ──");
const f0 = frames[A_TRAIL];
const m0 = toCanonicalFrame(f0, true);
// Under M: bilateral label swap (leftWrist→rightWrist), y unchanged, x→1−x.
const origLW = f0.joints.leftWrist!;
const mirroredAsRW = m0.joints.rightWrist!; // leftWrist maps to rightWrist slot
assert(Math.abs(mirroredAsRW.y - origLW.y) < 1e-9, "mirror leaves y unchanged");
assert(Math.abs(mirroredAsRW.x - (1 - origLW.x)) < 1e-9, "mirror sets x → 1−x");
// 2D displacement magnitude is mirror-invariant (speed is a magnitude).
const a1 = frames[A_TRAIL - 3].joints.leftWrist!, b1 = frames[A_TRAIL].joints.leftWrist!;
const rawSpeed = Math.hypot(b1.x - a1.x, b1.y - a1.y);
const ma = toCanonicalFrame(frames[A_TRAIL - 3], true).joints.rightWrist!;
const mb = toCanonicalFrame(frames[A_TRAIL], true).joints.rightWrist!;
const mirSpeed = Math.hypot(mb.x - ma.x, mb.y - ma.y);
assert(Math.abs(rawSpeed - mirSpeed) < 1e-9, "2D speed magnitude is mirror-invariant");

console.log(`\n${failed === 0 ? "✅ PASS" : "❌ FAIL"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
