/**
 * metricDefinitions.test.ts — Tests for METRIC_DEFINITIONS structure and cue functions
 *
 * Run with: npx tsx packages/domain/swing/metricDefinitions.test.ts
 */

import { METRIC_DEFINITIONS, type MetricKey } from './metricDefinitions';
import type { AgeTier } from './tipFrequency';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let currentGroup = '';

function group(name: string): void {
  currentGroup = name;
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
// Section A — Structure validation
// ---------------------------------------------------------------------------

console.log('\n=== Metric Definitions Tests ===');

group('A1. METRIC_DEFINITIONS has exactly 6 keys');
{
  const keys = Object.keys(METRIC_DEFINITIONS);
  assertEq(keys.length, 6, '6 keys');
  const expected: MetricKey[] = [
    'spineAngle', 'leftElbowAngle', 'rightElbowAngle',
    'leftKneeAngle', 'rightKneeAngle', 'shoulderTilt',
  ];
  for (const key of expected) {
    assert(key in METRIC_DEFINITIONS, `${key} exists`);
  }
}

group('A2. Each entry has required fields with correct types');
{
  for (const [key, def] of Object.entries(METRIC_DEFINITIONS)) {
    assert(Array.isArray(def.segments), `${key}: segments is array`);
    assert(typeof def.ideal === 'number', `${key}: ideal is number`);
    assert(typeof def.underTolerance === 'number' && def.underTolerance > 0, `${key}: underTolerance > 0`);
    assert(typeof def.overTolerance === 'number' && def.overTolerance > 0, `${key}: overTolerance > 0`);
    assert(typeof def.label === 'string' && def.label.length > 0, `${key}: label is non-empty string`);
    assert(typeof def.cue === 'function', `${key}: cue is function`);
  }
}

group('A3. Ideal and tolerance values match repo code (SCR-0b-1: asymmetric)');
{
  assertEq(METRIC_DEFINITIONS.spineAngle.ideal, 35, 'spineAngle ideal = 35');
  assertEq(METRIC_DEFINITIONS.spineAngle.underTolerance, 20, 'spineAngle underTolerance = 20');
  assertEq(METRIC_DEFINITIONS.spineAngle.overTolerance, 13.33, 'spineAngle overTolerance = 13.33');
  assertEq(METRIC_DEFINITIONS.leftElbowAngle.ideal, 165, 'leftElbowAngle ideal = 165');
  assertEq(METRIC_DEFINITIONS.leftElbowAngle.underTolerance, 40, 'leftElbowAngle underTolerance = 40');
  assertEq(METRIC_DEFINITIONS.leftElbowAngle.overTolerance, 26.67, 'leftElbowAngle overTolerance = 26.67');
  assertEq(METRIC_DEFINITIONS.rightElbowAngle.ideal, 165, 'rightElbowAngle ideal = 165');
  assertEq(METRIC_DEFINITIONS.rightElbowAngle.underTolerance, 40, 'rightElbowAngle underTolerance = 40');
  assertEq(METRIC_DEFINITIONS.rightElbowAngle.overTolerance, 26.67, 'rightElbowAngle overTolerance = 26.67');
  assertEq(METRIC_DEFINITIONS.leftKneeAngle.ideal, 155, 'leftKneeAngle ideal = 155');
  assertEq(METRIC_DEFINITIONS.leftKneeAngle.underTolerance, 35, 'leftKneeAngle underTolerance = 35');
  assertEq(METRIC_DEFINITIONS.leftKneeAngle.overTolerance, 23.33, 'leftKneeAngle overTolerance = 23.33');
  assertEq(METRIC_DEFINITIONS.rightKneeAngle.ideal, 155, 'rightKneeAngle ideal = 155');
  assertEq(METRIC_DEFINITIONS.rightKneeAngle.underTolerance, 35, 'rightKneeAngle underTolerance = 35');
  assertEq(METRIC_DEFINITIONS.rightKneeAngle.overTolerance, 23.33, 'rightKneeAngle overTolerance = 23.33');
  // 48 per Meister 2011 peak-backswing anchor (2d01e27; was 0 pre-fix)
  assertEq(METRIC_DEFINITIONS.shoulderTilt.ideal, 48, 'shoulderTilt ideal = 48');
  assertEq(METRIC_DEFINITIONS.shoulderTilt.underTolerance, 25, 'shoulderTilt underTolerance = 25');
  assertEq(METRIC_DEFINITIONS.shoulderTilt.overTolerance, 16.67, 'shoulderTilt overTolerance = 16.67');
}

group('A4. Label values');
{
  assertEq(METRIC_DEFINITIONS.spineAngle.label, 'Spine tilt', 'spineAngle label');
  assertEq(METRIC_DEFINITIONS.leftElbowAngle.label, 'Trail arm', 'leftElbowAngle label (canonical left* = trail)');
  assertEq(METRIC_DEFINITIONS.rightElbowAngle.label, 'Lead arm', 'rightElbowAngle label (canonical right* = lead)');
  assertEq(METRIC_DEFINITIONS.leftKneeAngle.label, 'Trail knee', 'leftKneeAngle label (canonical left* = trail)');
  assertEq(METRIC_DEFINITIONS.rightKneeAngle.label, 'Lead knee', 'rightKneeAngle label (canonical right* = lead)');
  assertEq(METRIC_DEFINITIONS.shoulderTilt.label, 'Shoulders', 'shoulderTilt label');
}

group('A5. Segments are non-empty with valid joint name pairs');
{
  for (const [key, def] of Object.entries(METRIC_DEFINITIONS)) {
    assert(def.segments.length > 0, `${key}: segments non-empty`);
    for (const seg of def.segments) {
      assertEq(seg.length, 2, `${key}: segment has 2 elements`);
      assert(typeof seg[0] === 'string' && seg[0].length > 0, `${key}: seg[0] is string`);
      assert(typeof seg[1] === 'string' && seg[1].length > 0, `${key}: seg[1] is string`);
    }
  }
}

// ---------------------------------------------------------------------------
// Section B — Cue functions
// ---------------------------------------------------------------------------

group('B1. spineAngle cues');
{
  const { cue, ideal } = METRIC_DEFINITIONS.spineAngle;
  // v > ideal → junior
  assertEq(cue(ideal + 10, ideal, 'junior'), 'Try standing a bit taller', 'above ideal, junior');
  // v > ideal → adult
  assertEq(cue(ideal + 10, ideal, 'adult'), 'You\'re leaning too far forward at address \u2014 stand a bit taller', 'above ideal, adult');
  // v < ideal → junior
  assertEq(cue(ideal - 10, ideal, 'junior'), 'Bend forward just a little', 'below ideal, junior');
  // v < ideal → adult
  assertEq(cue(ideal - 10, ideal, 'adult'), 'A bit more forward tilt at setup \u2014 you\'re standing too upright', 'below ideal, adult');
  // v === ideal → falls to else (v <= i)
  assertEq(cue(ideal, ideal, 'junior'), 'Bend forward just a little', 'at ideal, junior (else branch)');
  // junior vs adult differ
  assert(cue(ideal + 10, ideal, 'junior') !== cue(ideal + 10, ideal, 'adult'), 'junior/adult differ (above)');
  assert(cue(ideal - 10, ideal, 'junior') !== cue(ideal - 10, ideal, 'adult'), 'junior/adult differ (below)');
}

group('B2. leftElbowAngle cues');
{
  const { cue, ideal } = METRIC_DEFINITIONS.leftElbowAngle;
  // v < ideal → junior
  assertEq(cue(ideal - 20, ideal, 'junior'), 'Keep your back arm straighter', 'below ideal, junior');
  // v < ideal → adult
  assertEq(cue(ideal - 20, ideal, 'adult'), 'Your trail arm is too bent through the swing \u2014 try to keep it straighter', 'below ideal, adult');
  // v >= ideal → junior
  assertEq(cue(ideal + 10, ideal, 'junior'), 'Bend your back arm a tiny bit', 'above ideal, junior');
  // v >= ideal → adult
  assertEq(cue(ideal + 10, ideal, 'adult'), 'Your trail arm is locking out \u2014 keep a slight bend through impact', 'above ideal, adult');
  // v === ideal → falls to else (v >= i)
  assertEq(cue(ideal, ideal, 'junior'), 'Bend your back arm a tiny bit', 'at ideal, junior (else branch)');
  assert(cue(ideal - 20, ideal, 'junior') !== cue(ideal - 20, ideal, 'adult'), 'junior/adult differ');
}

group('B3. rightElbowAngle cues');
{
  const { cue, ideal } = METRIC_DEFINITIONS.rightElbowAngle;
  assertEq(cue(ideal - 20, ideal, 'junior'), 'Stretch your front arm out more', 'below ideal, junior');
  assertEq(cue(ideal - 20, ideal, 'adult'), 'Your lead elbow is too bent at the top \u2014 extend it more', 'below ideal, adult');
  assertEq(cue(ideal + 10, ideal, 'junior'), 'Let your front arm bend a little', 'above ideal, junior');
  assertEq(cue(ideal + 10, ideal, 'adult'), 'Your lead arm is too straight \u2014 let it fold naturally at the top', 'above ideal, adult');
  assertEq(cue(ideal, ideal, 'junior'), 'Let your front arm bend a little', 'at ideal, junior (else branch)');
  assert(cue(ideal - 20, ideal, 'junior') !== cue(ideal - 20, ideal, 'adult'), 'junior/adult differ');
}

group('B4. leftKneeAngle cues');
{
  const { cue, ideal } = METRIC_DEFINITIONS.leftKneeAngle;
  assertEq(cue(ideal - 20, ideal, 'junior'), 'Stand a little taller in your legs', 'below ideal, junior');
  assertEq(cue(ideal - 20, ideal, 'adult'), 'Too much knee bend at setup \u2014 stay athletic, not crouched', 'below ideal, adult');
  assertEq(cue(ideal + 10, ideal, 'junior'), 'Bend your back knee a tiny bit', 'above ideal, junior');
  assertEq(cue(ideal + 10, ideal, 'adult'), 'Soften your trail knee at address \u2014 a little flex helps your turn', 'above ideal, adult');
  assertEq(cue(ideal, ideal, 'junior'), 'Bend your back knee a tiny bit', 'at ideal, junior (else branch)');
  assert(cue(ideal - 20, ideal, 'junior') !== cue(ideal - 20, ideal, 'adult'), 'junior/adult differ');
}

group('B5. rightKneeAngle cues');
{
  const { cue, ideal } = METRIC_DEFINITIONS.rightKneeAngle;
  assertEq(cue(ideal - 20, ideal, 'junior'), 'Stand a little taller in your legs', 'below ideal, junior');
  assertEq(cue(ideal - 20, ideal, 'adult'), 'Your lead knee is too bent at setup \u2014 straighten up a little', 'below ideal, adult');
  assertEq(cue(ideal + 10, ideal, 'junior'), 'Bend your front knee a tiny bit', 'above ideal, junior');
  assertEq(cue(ideal + 10, ideal, 'adult'), 'Soften your lead knee at address \u2014 stay ready to rotate', 'above ideal, adult');
  assertEq(cue(ideal, ideal, 'junior'), 'Bend your front knee a tiny bit', 'at ideal, junior (else branch)');
  assert(cue(ideal - 20, ideal, 'junior') !== cue(ideal - 20, ideal, 'adult'), 'junior/adult differ');
}

group('B6. shoulderTilt cues (branches on v > 0, not v vs ideal)');
{
  const { cue, ideal } = METRIC_DEFINITIONS.shoulderTilt;
  // v > 0 → junior
  assertEq(cue(10, ideal, 'junior'), 'Try to keep your shoulders even', 'v>0, junior');
  // v > 0 → adult
  assertEq(cue(10, ideal, 'adult'), 'Your lead shoulder is too high at the top \u2014 try to level them', 'v>0, adult');
  // v <= 0 → junior
  assertEq(cue(-10, ideal, 'junior'), 'Try to keep your shoulders even', 'v<=0, junior');
  // v <= 0 → adult
  assertEq(cue(-10, ideal, 'adult'), 'Your trail shoulder is too high at the top \u2014 try to level them', 'v<=0, adult');
  // v === 0 → falls to else (v <= 0)
  assertEq(cue(0, ideal, 'junior'), 'Try to keep your shoulders even', 'v=0, junior (else branch)');
  // junior text is same for both branches
  assertEq(cue(10, ideal, 'junior'), cue(-10, ideal, 'junior'), 'junior: same text both branches');
  // adult text differs between branches
  assert(cue(10, ideal, 'adult') !== cue(-10, ideal, 'adult'), 'adult: different text per branch');
}

group('B7. All cue functions return strings for all age tiers');
{
  const tiers: AgeTier[] = ['junior', 'youth', 'teen', 'adult'];
  for (const [key, def] of Object.entries(METRIC_DEFINITIONS)) {
    for (const tier of tiers) {
      const result = def.cue(def.ideal + 5, def.ideal, tier);
      assert(typeof result === 'string' && result.length > 0, `${key} cue(above, ${tier}) returns non-empty string`);
    }
  }
}

// ---------------------------------------------------------------------------
// Section C — Cross-validation with scoring.ts
// ---------------------------------------------------------------------------

group('C1. ANGLE_METRIC_KEYS ⊆ METRIC_DEFINITIONS (subset, not equality — shoulderTilt stays in METRIC_DEFINITIONS as diagnostic surface)');
{
  // These are the keys used by scoring.ts ANGLE_METRIC_KEYS
  const angleMetricKeys: MetricKey[] = [
    'spineAngle', 'leftElbowAngle', 'rightElbowAngle',
    'leftKneeAngle', 'rightKneeAngle',
  ];
  for (const key of angleMetricKeys) {
    assert(key in METRIC_DEFINITIONS, `${key} exists in METRIC_DEFINITIONS`);
  }
}

group('C2. Ideals accessible for scoring match definitions');
{
  const expectedIdeals: Record<MetricKey, number> = {
    spineAngle: 35,
    leftElbowAngle: 165,
    rightElbowAngle: 165,
    leftKneeAngle: 155,
    rightKneeAngle: 155,
    shoulderTilt: 48, // Meister 2011 anchor (2d01e27)
  };
  for (const [key, ideal] of Object.entries(expectedIdeals)) {
    assertEq(
      METRIC_DEFINITIONS[key as MetricKey].ideal,
      ideal,
      `${key} ideal = ${ideal} (scoring cross-check)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All metric definitions tests passed');
}
