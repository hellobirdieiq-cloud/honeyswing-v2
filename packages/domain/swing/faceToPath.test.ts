/**
 * faceToPath.test.ts — Tests for computeFaceToPath.
 *
 * Run with: npx --yes tsx packages/domain/swing/faceToPath.test.ts
 */
import { computeFaceToPath, type BallFlightLabel } from "./faceToPath";
import type { LeadWristHinge, WristHingeCategory } from "./wristHinge";
import type { SyntheticClubheadPath, ClubheadPathCategory } from "./syntheticClubheadPath";

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

function makeHinge(category: WristHingeCategory): LeadWristHinge {
  return {
    hingeAtTopDeg: 0,
    hingeAtImpactDeg: category === "cupped" ? 30 : category === "bowed" ? -30 : 0,
    deltaTransitionDeg: 0,
    category,
    framesUsedTop: 7,
    framesUsedImpact: 7,
    confidence: 1,
  };
}

function makePath(category: ClubheadPathCategory): SyntheticClubheadPath {
  return {
    pathAngleAtImpactDeg: category === "in-to-out" ? 20 : category === "out-to-in" ? -20 : 0,
    category,
    samples: [],
    framesUsed: 11,
    confidence: 1,
  };
}

// 3×3 expected table — keep separate from production lookup to catch typos.
const EXPECTED: Record<WristHingeCategory, Record<ClubheadPathCategory, BallFlightLabel>> = {
  cupped: { "in-to-out": "push", square: "fade", "out-to-in": "slice" },
  flat:   { "in-to-out": "push-draw", square: "straight", "out-to-in": "pull-fade" },
  bowed:  { "in-to-out": "hook", square: "draw", "out-to-in": "pull" },
};

console.log("\n=== Face-to-Path Module Tests ===");

group("3×3 ball flight matrix");
const hingeCats: WristHingeCategory[] = ["cupped", "flat", "bowed"];
const pathCats: ClubheadPathCategory[] = ["in-to-out", "square", "out-to-in"];
for (const h of hingeCats) {
  for (const p of pathCats) {
    const r = computeFaceToPath(makeHinge(h), makePath(p));
    assertEq(r.ballFlightLabel, EXPECTED[h][p], `${h} × ${p} → ${EXPECTED[h][p]}`);
  }
}

group("face category mapping");
assertEq(computeFaceToPath(makeHinge("cupped"), makePath("square")).faceCategory, "open", "cupped → open");
assertEq(computeFaceToPath(makeHinge("flat"), makePath("square")).faceCategory, "square", "flat → square");
assertEq(computeFaceToPath(makeHinge("bowed"), makePath("square")).faceCategory, "closed", "bowed → closed");

group("path category passthrough");
for (const p of pathCats) {
  const r = computeFaceToPath(makeHinge("flat"), makePath(p));
  assertEq(r.pathCategory, p, `path passthrough: ${p}`);
}

group("faceToPathDelta sign");
// face open vs path out-to-in → face very open to path
assertEq(
  computeFaceToPath(makeHinge("cupped"), makePath("out-to-in")).faceToPathDelta,
  "open",
  "open face × out-to-in path → open relative",
);
// face closed vs path in-to-out → face very closed to path
assertEq(
  computeFaceToPath(makeHinge("bowed"), makePath("in-to-out")).faceToPathDelta,
  "closed",
  "closed face × in-to-out path → closed relative",
);
// matched
assertEq(
  computeFaceToPath(makeHinge("flat"), makePath("square")).faceToPathDelta,
  "square",
  "square face × square path → square relative",
);
// "matched" off-axis: open face + in-to-out path → delta zero (face open by +1, path in-to-out by +1 → 0)
assertEq(
  computeFaceToPath(makeHinge("cupped"), makePath("in-to-out")).faceToPathDelta,
  "square",
  "open face × in-to-out path → matched (delta = 0)",
);

console.log(`\n${"═".repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(55)}`);
if (failed > 0) {
  process.exit(1);
}
