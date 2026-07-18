/**
 * operatorRegrade.test.ts — P-101 phase-override injection seam.
 *
 * Every expected value derives from the composed pipeline functions:
 *   - calculateTempo needs all 5 named phases; segments top−takeaway /
 *     impact−top; ratio 2dp; non-positive segment → null (tempoAnalysis.ts)
 *   - isTempoTrustworthy: all-fallback → false; segment < 120ms → false;
 *     ratio outside [0.5, 10] → false (tempoAnalysis.ts)
 *   - scoreSwing: tempo-only; null tempo → {score: null, honeyBoom: false};
 *     green band [2.0, 4.3] → 100 + honeyBoom (scoring.ts)
 *   - timestamp ladder: frames[idx].timestampMs → own/any detected anchor +
 *     stepMs·Δindex → bare stepMs·idx → drop (operatorRegrade.ts)
 *
 * Run with: npx --yes tsx packages/domain/swing/operatorRegrade.test.ts
 */

import { regradeFromOperatorPhases } from "./operatorRegrade";
import { calculateTempo } from "./tempoAnalysis";
import { scoreSwing } from "./scoring";
import type { DetectedPhase, SwingPhase, SwingTrailPoint } from "./phaseDetection";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trailPoint(timestamp: number): SwingTrailPoint {
  return { x: 0.5, y: 0.5, timestamp, leadX: 0.52, leadY: 0.5, trailX: 0.48, trailY: 0.5 };
}

function phase(
  name: SwingPhase,
  index: number,
  timestamp: number,
  source: "heuristic" | "fallback" = "heuristic",
): DetectedPhase {
  return { phase: name, label: name, point: trailPoint(timestamp), index, timestamp, source };
}

/** 10ms/frame timebase: frame i ↔ 10·i ms. */
function framesOf(count: number): { timestampMs: number }[] {
  return Array.from({ length: count }, (_, i) => ({ timestampMs: i * 10 }));
}

/** Detected set on the 10ms timebase: TA f20/200ms, TOP f80/800ms,
 *  DSW f95/950ms, IMP f110/1100ms, FIN f140/1400ms.
 *  backswing 600ms, downswing 300ms, ratio 2.0 → green band, score 100. */
function detectedSet(source: "heuristic" | "fallback" = "heuristic"): DetectedPhase[] {
  return [
    phase("takeaway", 20, 200, source),
    phase("top", 80, 800, source),
    phase("downswing", 95, 950, source),
    phase("impact", 110, 1100, source),
    phase("follow_through", 140, 1400, source),
  ];
}

const FRAMES = framesOf(200);

// ---------------------------------------------------------------------------
// T1. Parity — zero overrides reproduce the pipeline verbatim
// ---------------------------------------------------------------------------

group("T1. Zero overrides → pipeline parity");
{
  const detected = detectedSet();
  const r = regradeFromOperatorPhases({ detectedPhases: detected, operatorFrames: {}, frames: FRAMES });
  const direct = calculateTempo(detected);
  const directScore = scoreSwing({
    angles: {
      spineAngle: null, leftElbowAngle: null, rightElbowAngle: null,
      leftKneeAngle: null, rightKneeAngle: null, hipSpreadDelta: null,
      shoulderTilt: null, spineDrift: null,
    },
    tempo: direct,
  });
  assertEq(JSON.stringify(r.tempo), JSON.stringify(direct), "T1: tempo deep-equals calculateTempo(detected)");
  assertEq(r.score, directScore.score, "T1: score equals scoreSwing on same tempo");
  assertEq(r.honeyBoom, directScore.honeyBoom, "T1: honeyBoom matches");
  assertEq(r.overriddenPhases.length, 0, "T1: no overridden phases");
  assertEq(r.effectivePhases.length, 5, "T1: all 5 detected phases kept");
}

// ---------------------------------------------------------------------------
// T2. Single override with frames — segments shift to frames[idx].timestampMs
// ---------------------------------------------------------------------------

group("T2. Single top override via frames timebase");
{
  // top moved f80 → f50 (500ms): backswing 300ms, downswing 600ms, ratio 0.5
  const r = regradeFromOperatorPhases({
    detectedPhases: detectedSet(),
    operatorFrames: { top: 50 },
    frames: FRAMES,
  });
  assertEq(r.tempo?.backswingMs, 300, "T2: backswing = frames[50] − takeaway");
  assertEq(r.tempo?.downswingMs, 600, "T2: downswing = impact − frames[50]");
  assertEq(r.tempo?.tempoRatio, 0.5, "T2: ratio 0.50");
  assertEq(r.score, 60, "T2: ratio 0.5 → TEMPO_SCORE_LOW_3 (60, ratio<1.0 band)");
  assertEq(JSON.stringify(r.overriddenPhases), JSON.stringify(["top"]), "T2: top marked overridden");
}

// ---------------------------------------------------------------------------
// T3. Override synthesizes a phase missing from detected
// ---------------------------------------------------------------------------

group("T3. Stamp completes a 4-phase detected set");
{
  const partial = detectedSet().filter((p) => p.phase !== "downswing");
  const r = regradeFromOperatorPhases({
    detectedPhases: partial,
    operatorFrames: { downswing: 95 },
    frames: FRAMES,
  });
  assertEq(r.effectivePhases.length, 5, "T3: 5-set completed");
  assert(r.tempo != null, "T3: tempo non-null");
  assertEq(r.score, 100, "T3: green ratio 2.0 → 100");
}

// ---------------------------------------------------------------------------
// T4. Operator stamps rescue an all-fallback set (source mapping)
// ---------------------------------------------------------------------------

group("T4. All-fallback detected + operator stamp");
{
  const allFallback = detectedSet("fallback");
  const direct = regradeFromOperatorPhases({
    detectedPhases: allFallback,
    operatorFrames: {},
    frames: FRAMES,
  });
  assertEq(direct.tempo, null, "T4: zero stamps → all-fallback still withheld");
  assertEq(direct.score, null, "T4: withheld score null");

  const oneStamp = regradeFromOperatorPhases({
    detectedPhases: allFallback,
    operatorFrames: { top: 80 },
    frames: FRAMES,
  });
  assert(oneStamp.tempo != null, "T4: one stamp defeats the all-fallback gate");
  assertEq(oneStamp.score, 100, "T4: same green tempo now scored");

  const allStamped = regradeFromOperatorPhases({
    detectedPhases: allFallback,
    operatorFrames: { takeaway: 20, top: 80, downswing: 95, impact: 110, follow_through: 140 },
    frames: FRAMES,
  });
  assert(allStamped.tempo != null, "T4: fully stamped set passes");
}

// ---------------------------------------------------------------------------
// T5. <5 merged phases → withheld
// ---------------------------------------------------------------------------

group("T5. Sub-5 merged set");
{
  const r = regradeFromOperatorPhases({
    detectedPhases: [],
    operatorFrames: { top: 80, impact: 110 },
    frames: FRAMES,
  });
  assertEq(r.tempo, null, "T5: tempo null");
  assertEq(r.score, null, "T5: score null");
  assertEq(r.honeyBoom, false, "T5: honeyBoom false");
}

// ---------------------------------------------------------------------------
// T6. Timestamp ladder — anchor stepMs math, relative fallback, drop
// ---------------------------------------------------------------------------

group("T6. Timestamp derivation without frames");
{
  // Own-detected anchor: top detected f80/800ms, stamped f50, stepMs 10
  // → 800 + 10·(50−80) = 500ms.
  const anchored = regradeFromOperatorPhases({
    detectedPhases: detectedSet(),
    operatorFrames: { top: 50 },
    stepMs: 10,
  });
  assertEq(anchored.tempo?.backswingMs, 300, "T6: own-anchor math (800 + 10·(50−80) = 500)");
  assertEq(anchored.tempo?.downswingMs, 600, "T6: downswing from anchored timestamp");

  // Empty detected → bare stepMs·idx, internally consistent.
  const relative = regradeFromOperatorPhases({
    detectedPhases: [],
    operatorFrames: { takeaway: 20, top: 80, downswing: 95, impact: 110, follow_through: 140 },
    stepMs: 10,
  });
  assertEq(relative.tempo?.tempoRatio, 2, "T6: relative timebase ratio 2.0");
  assertEq(relative.score, 100, "T6: relative timebase scored green");

  // Neither frames nor stepMs → stamped phase dropped → <5 → withheld.
  const dropped = regradeFromOperatorPhases({
    detectedPhases: detectedSet().filter((p) => p.phase !== "top"),
    operatorFrames: { top: 50 },
  });
  assertEq(dropped.tempo, null, "T6: underivable timestamp drops phase → withheld");
}

// ---------------------------------------------------------------------------
// T7. Trust gates pass through
// ---------------------------------------------------------------------------

group("T7. Broken stamps still gated");
{
  // top f105/1050ms: downswing = 1100−1050 = 50ms < TEMPO_MIN_PHASE_MS
  const shortSeg = regradeFromOperatorPhases({
    detectedPhases: detectedSet(),
    operatorFrames: { top: 105 },
    frames: FRAMES,
  });
  assertEq(shortSeg.tempo, null, "T7: 50ms downswing withheld (< 120ms gate)");
  assertEq(shortSeg.score, null, "T7: score withheld");

  // impact stamped BEFORE top: negative downswing → calculateTempo null
  const inverted = regradeFromOperatorPhases({
    detectedPhases: detectedSet(),
    operatorFrames: { impact: 60 },
    frames: FRAMES,
  });
  assertEq(inverted.tempo, null, "T7: impact-before-top → null (non-positive segment)");
}

// ---------------------------------------------------------------------------
// T8. Index clamping
// ---------------------------------------------------------------------------

group("T8. Out-of-range stamp clamps to last frame");
{
  const r = regradeFromOperatorPhases({
    detectedPhases: detectedSet(),
    operatorFrames: { follow_through: 9999 },
    frames: FRAMES,
  });
  // clamped to frame 199 → 1990ms; tempo segments unchanged (FIN not in ratio)
  assertEq(r.tempo?.totalSwingMs, 1990 - 200, "T8: finish clamped to frames[199]");
  assertEq(r.tempo?.tempoRatio, 2, "T8: ratio unaffected by finish stamp");
}

// ---------------------------------------------------------------------------
// T9. honeyBoom ⇔ green band
// ---------------------------------------------------------------------------

group("T9. honeyBoom tracks the green band");
{
  const green = regradeFromOperatorPhases({
    detectedPhases: detectedSet(),
    operatorFrames: {},
    frames: FRAMES,
  });
  assertEq(green.honeyBoom, true, "T9: ratio 2.0 (green edge) → honeyBoom");

  // top f60/600ms: backswing 400, downswing 500, ratio 0.8 → not green
  const notGreen = regradeFromOperatorPhases({
    detectedPhases: detectedSet(),
    operatorFrames: { top: 60 },
    frames: FRAMES,
  });
  assertEq(notGreen.honeyBoom, false, "T9: ratio 0.8 → no honeyBoom");
  assertEq(notGreen.score, 60, "T9: 0.8 lands LOW_3 (60)");
}

// ---------------------------------------------------------------------------
// T10. Reopen-from-history simulation (owner-required): Auto view recompute
// from the detected snapshot, never the (rewritten) row values
// ---------------------------------------------------------------------------

group("T10. History reopen — Auto from detected, not row");
{
  // Operator moved top f80→f50 and saved: row now holds the Yours values
  // (ratio 0.5, score 60). The row phases column keeps the ORIGINAL detected
  // set. The Auto view must recompute X from detected (ratio 2.0, score 100)
  // and never echo the row's Yours values.
  const detected = detectedSet();
  const yours = regradeFromOperatorPhases({
    detectedPhases: detected,
    operatorFrames: { top: 50 },
    frames: FRAMES,
  });
  const rowScore = yours.score; // what the row holds post-save under (a)
  const auto = regradeFromOperatorPhases({
    detectedPhases: detected,
    operatorFrames: {},
    frames: FRAMES,
  });
  assertEq(auto.score, 100, "T10: Auto recompute equals original detected compute");
  assert(auto.score !== rowScore, "T10: Auto differs from the rewritten row value");
  assertEq(auto.tempo?.tempoRatio, 2, "T10: Auto ratio from detected timestamps");

  // Fallback path: row phases missing → synthesize Auto from the
  // operator_labels.detected snapshot (frame indices only, labels IGNORED).
  const detectedSnapshot: Partial<Record<SwingPhase, number>> = {
    takeaway: 20, top: 80, downswing: 95, impact: 110, follow_through: 140,
  };
  const autoFromSnapshot = regradeFromOperatorPhases({
    detectedPhases: [],
    operatorFrames: detectedSnapshot, // detected snapshot, NOT labels.phases
    stepMs: 10,
  });
  assertEq(autoFromSnapshot.score, 100, "T10: snapshot-fallback Auto matches original");
  assertEq(autoFromSnapshot.tempo?.tempoRatio, 2, "T10: snapshot-fallback ratio 2.0");
}

// ---------------------------------------------------------------------------

console.log(`\n═══════════════════════════════════════════════════════`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`═══════════════════════════════════════════════════════`);
if (failed > 0) {
  console.log("⚠️  SOME TESTS FAILED");
  process.exit(1);
}
