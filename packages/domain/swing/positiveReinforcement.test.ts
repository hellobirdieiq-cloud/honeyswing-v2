/**
 * positiveReinforcement.test.ts — Task 8 Comprehensive Validation
 *
 * Run with: npx tsx packages/domain/swing/positiveReinforcement.test.ts
 *
 * Covers:
 *   - General positive cards (confidence + no corrections gating)
 *   - Card pool rotation (no immediate repeats, exhaustion reset)
 *   - Improvement template rotation
 *   - Improvement detection (flagging, crossing threshold, clearing, re-flagging)
 *   - Multiple simultaneous improvements
 *   - Priority: improvement over general
 *   - NaN / undefined score handling
 *   - ProcessSwingResult shape contract
 *   - Reset behavior
 *   - Debug info shape + counters
 *   - Multi-swing session scenarios (50-swing, 100-swing, all-bad, all-good)
 *   - Singleton export
 *   - Constants validation
 */

import {
  PositiveReinforcementEngine,
  positiveReinforcementEngine,
  _testExports,
  type ConfidenceInput,
  type MetricScore,
  type ProcessSwingResult,
} from './positiveReinforcement';

const {
  GENERAL_CARDS,
  IMPROVEMENT_TEMPLATES,
  METRIC_FRIENDLY_NAMES,
  CONFIDENCE_THRESHOLD,
  GOOD_SCORE_THRESHOLD,
} = _testExports;

// ---------------------------------------------------------------------------
// Test harness (matches Task 7 pattern)
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

function assertIncludes(arr: readonly string[], item: string, label: string): void {
  assert(arr.includes(item), `${label} (${JSON.stringify(item)} not in array)`);
}

function assertNotNull<T>(val: T | null | undefined, label: string): void {
  assert(val !== null && val !== undefined, `${label} (got ${JSON.stringify(val)})`);
}

function assertNull<T>(val: T | null, label: string): void {
  assert(val === null, `${label} (expected null, got ${JSON.stringify(val)})`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const highConfidence: ConfidenceInput = { tier: 'high', overall: 85 };
const mediumConfidence: ConfidenceInput = { tier: 'medium', overall: 65 };
const lowConfidence: ConfidenceInput = { tier: 'low', overall: 30 };
const borderlineConfidence: ConfidenceInput = { tier: 'high', overall: 75 };

const goodScores: MetricScore[] = [
  { metricKey: 'tempo', score: 90 },
  { metricKey: 'spineAngle', score: 85 },
  { metricKey: 'shoulderTilt', score: 88 },
];

const mixedScores: MetricScore[] = [
  { metricKey: 'tempo', score: 90 },
  { metricKey: 'spineAngle', score: 60 },
  { metricKey: 'shoulderTilt', score: 45 },
];

const badScores: MetricScore[] = [
  { metricKey: 'tempo', score: 50 },
  { metricKey: 'spineAngle', score: 40 },
  { metricKey: 'shoulderTilt', score: 30 },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// =========================================================================
// ProcessSwingResult shape
// =========================================================================

group('ProcessSwingResult shape');

{
  const engine = new PositiveReinforcementEngine();
  const result = engine.processSwing(highConfidence, goodScores, 0);
  assert('card' in result, 'result has card property');
  assert('improvements' in result, 'result has improvements property');
  assert(Array.isArray(result.improvements), 'improvements is array');
}

{
  const engine = new PositiveReinforcementEngine();
  const result = engine.processSwing(lowConfidence, badScores, 3);
  assertNull(result.card, 'card is null when no positive fires');
  assertEq(result.improvements.length, 0, 'improvements empty when none');
}

{
  const engine = new PositiveReinforcementEngine();
  const result = engine.processSwing(highConfidence, goodScores, 0);
  assertNotNull(result.card, 'card is not null on positive');
  assertEq(result.card!.type, 'general', 'card type is general');
  assert(typeof result.card!.message === 'string', 'card message is string');
  assert(result.card!.message.length > 0, 'card message is non-empty');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 50 }], 1);
  const result = engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 90 }], 1);
  assertEq(result.card!.type, 'improvement', 'improvement card type');
  assertEq(result.card!.metricKey, 'tempo', 'improvement card metricKey');
}

{
  const engine = new PositiveReinforcementEngine();
  const result = engine.processSwing(highConfidence, goodScores, 0);
  assertEq(result.card!.metricKey, undefined, 'general card has no metricKey');
}

// =========================================================================
// General positive cards — gating
// =========================================================================

group('General positive cards — gating');

{
  const engine = new PositiveReinforcementEngine();
  const result = engine.processSwing(highConfidence, goodScores, 0);
  assertNotNull(result.card, 'fires when high confidence + 0 corrections');
  assertEq(result.card!.type, 'general', 'type is general');
  assertIncludes(GENERAL_CARDS as unknown as string[], result.card!.message, 'message from pool');
}

{
  const engine = new PositiveReinforcementEngine();
  const result = engine.processSwing(borderlineConfidence, goodScores, 0);
  assertNotNull(result.card, 'fires at borderline confidence (exactly 75)');
}

{
  const engine = new PositiveReinforcementEngine();
  const result = engine.processSwing(highConfidence, goodScores, 1);
  assertNull(result.card, 'does NOT fire when 1 correction survived');
}

{
  const engine = new PositiveReinforcementEngine();
  const result = engine.processSwing(highConfidence, goodScores, 5);
  assertNull(result.card, 'does NOT fire when 5 corrections survived');
}

{
  const engine = new PositiveReinforcementEngine();
  const result = engine.processSwing(mediumConfidence, goodScores, 0);
  assertNull(result.card, 'does NOT fire when confidence is medium');
}

{
  const engine = new PositiveReinforcementEngine();
  const result = engine.processSwing(lowConfidence, goodScores, 0);
  assertNull(result.card, 'does NOT fire when confidence is low');
}

{
  const engine = new PositiveReinforcementEngine();
  const weird: ConfidenceInput = { tier: 'high', overall: 70 };
  const result = engine.processSwing(weird, goodScores, 0);
  assertNull(result.card, 'does NOT fire when tier=high but overall < 75');
}

{
  const engine = new PositiveReinforcementEngine();
  const weird: ConfidenceInput = { tier: 'medium', overall: 80 };
  const result = engine.processSwing(weird, goodScores, 0);
  assertNull(result.card, 'does NOT fire when overall >= 75 but tier != high');
}

{
  const engine = new PositiveReinforcementEngine();
  const justBelow: ConfidenceInput = { tier: 'high', overall: 74 };
  const result = engine.processSwing(justBelow, goodScores, 0);
  assertNull(result.card, 'does NOT fire at overall=74 (below threshold)');
}

{
  const engine = new PositiveReinforcementEngine();
  const result = engine.processSwing(highConfidence, [], 0);
  assertNotNull(result.card, 'fires with empty metric scores');
  assertEq(result.card!.type, 'general', 'empty scores → general card');
}

// =========================================================================
// General card rotation
// =========================================================================

group('General card rotation');

{
  const engine = new PositiveReinforcementEngine();
  const seen: string[] = [];
  const halfPool = Math.floor(GENERAL_CARDS.length / 2);
  let noRepeats = true;

  for (let i = 0; i < halfPool; i++) {
    const result = engine.processSwing(highConfidence, goodScores, 0);
    if (seen.includes(result.card!.message)) noRepeats = false;
    seen.push(result.card!.message);
  }
  assert(noRepeats, `no immediate repeat in first ${halfPool} cards`);
}

{
  const engine = new PositiveReinforcementEngine();
  const seen = new Set<string>();
  // Coupon collector with exclusion: pickFromPool draws uniformly from the
  // pool minus the floor(N/2) most recent indices, so with N=10 a fixed
  // unseen card is missed per draw with prob (available-1)/available —
  // 9/10 · 8/9 · 7/8 · 6/7 · 5/6 during warm-up (= 1/2), then 4/5 per draw.
  // Union bound over N cards: P(fail) <= 5 · 0.8^(K-5). K = N·3 = 30 gave
  // ~1.9% flake; K = N·30 = 300 bounds failure at ~1e-28.
  for (let i = 0; i < GENERAL_CARDS.length * 30; i++) {
    const result = engine.processSwing(highConfidence, goodScores, 0);
    if (result.card) seen.add(result.card.message);
  }
  assertEq(seen.size, GENERAL_CARDS.length, 'eventually uses all cards in pool');
}

{
  const engine = new PositiveReinforcementEngine();
  let allGeneral = true;
  for (let i = 0; i < GENERAL_CARDS.length + 5; i++) {
    const result = engine.processSwing(highConfidence, goodScores, 0);
    if (!result.card || result.card.type !== 'general') allGeneral = false;
  }
  assert(allGeneral, 'pool resets gracefully when exhausted');
}

// =========================================================================
// Improvement template rotation
// =========================================================================

group('Improvement template rotation');

{
  const engine = new PositiveReinforcementEngine();
  const seen: string[] = [];

  for (let i = 0; i < IMPROVEMENT_TEMPLATES.length * 4; i++) {
    engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 50 }], 1);
    const result = engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 90 }], 1);
    if (result.card) seen.push(result.card.message);
  }
  const unique = new Set(seen);
  assertEq(unique.size, IMPROVEMENT_TEMPLATES.length, 'all improvement templates eventually used');
}

// =========================================================================
// Improvement detection
// =========================================================================

group('Improvement detection');

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'spineAngle', score: 60 }], 1);
  const result = engine.processSwing(highConfidence, [{ metricKey: 'spineAngle', score: 85 }], 1);
  assertNotNull(result.card, 'detects improvement when flagged metric crosses threshold');
  assertEq(result.card!.type, 'improvement', 'type is improvement');
  assertEq(result.card!.metricKey, 'spineAngle', 'metricKey is spineAngle');
  assert(result.card!.message.includes('posture'), 'message uses friendly name "posture"');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 50 }], 2);
  const result = engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 90 }], 2);
  assertNotNull(result.card, 'improvement fires even when corrections survived');
  assertEq(result.card!.type, 'improvement', 'type is improvement despite corrections');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(lowConfidence, [{ metricKey: 'tempo', score: 50 }], 0);
  const result = engine.processSwing(lowConfidence, [{ metricKey: 'tempo', score: 90 }], 0);
  assertNotNull(result.card, 'improvement fires even with low confidence');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 85 }], 1);
  const result = engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 90 }], 1);
  assertNull(result.card, 'does NOT detect improvement if never flagged');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 50 }], 1);
  const result = engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 70 }], 1);
  assertNull(result.card, 'does NOT detect improvement if score stays below 80');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 50 }], 1);
  const result = engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 80 }], 1);
  assertNotNull(result.card, 'improvement at exact threshold (score = 80)');
  assertEq(result.card!.type, 'improvement', 'type is improvement at threshold');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 50 }], 1);
  const r1 = engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 85 }], 1);
  assertEq(r1.card!.type, 'improvement', 'first improvement detected');

  const r2 = engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 90 }], 1);
  assertNull(r2.card, 'improvement clears flag — no double detection');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 50 }], 1);
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 85 }], 1);
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 40 }], 1);
  const result = engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 90 }], 1);
  assertEq(result.card!.type, 'improvement', 'metric can be re-flagged and re-improved');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'xyzUnknown', score: 50 }], 1);
  const result = engine.processSwing(highConfidence, [{ metricKey: 'xyzUnknown', score: 85 }], 1);
  assert(result.card!.message.includes('xyzUnknown'), 'unknown metric key falls back to raw key');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'shoulderTilt', score: 50 }], 1);
  const result = engine.processSwing(highConfidence, [{ metricKey: 'shoulderTilt', score: 85 }], 1);
  assert(result.card!.message.includes('shoulder tilt'), 'uses friendly name for known metrics');
}

// =========================================================================
// Multiple simultaneous improvements
// =========================================================================

group('Multiple simultaneous improvements');

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, badScores, 3);
  const result = engine.processSwing(highConfidence, goodScores, 0);
  assertNotNull(result.card, 'card fires on multi-improvement');
  assertEq(result.card!.type, 'improvement', 'type is improvement');
  assertEq(result.card!.metricKey, 'tempo', 'first improved metric wins');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, badScores, 3);
  const result = engine.processSwing(highConfidence, goodScores, 0);
  assert(result.improvements.includes('tempo'), 'improvements includes tempo');
  assert(result.improvements.includes('spineAngle'), 'improvements includes spineAngle');
  assert(result.improvements.includes('shoulderTilt'), 'improvements includes shoulderTilt');
  assertEq(result.improvements.length, 3, 'all 3 improvements exposed');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, badScores, 3);
  const partial: MetricScore[] = [
    { metricKey: 'tempo', score: 85 },
    { metricKey: 'spineAngle', score: 35 },
    { metricKey: 'shoulderTilt', score: 88 },
  ];
  const result = engine.processSwing(highConfidence, partial, 1);
  assertEq(result.improvements.length, 2, 'partial improvement: 2 improved');
  assertEq(result.improvements[0], 'tempo', 'partial: first is tempo');
  assertEq(result.improvements[1], 'shoulderTilt', 'partial: second is shoulderTilt');
  assertEq(result.card!.metricKey, 'tempo', 'partial: first wins the card');
}

// =========================================================================
// Priority: improvement over general
// =========================================================================

group('Priority: improvement over general');

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 50 }], 1);
  const result = engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 90 }], 0);
  assertEq(result.card!.type, 'improvement', 'improvement wins over general when both qualify');
}

// =========================================================================
// NaN and bad scores
// =========================================================================

group('NaN and bad scores');

{
  const engine = new PositiveReinforcementEngine();
  const scoresWithNaN: MetricScore[] = [
    { metricKey: 'tempo', score: NaN },
    { metricKey: 'spineAngle', score: 85 },
  ];
  const result = engine.processSwing(highConfidence, scoresWithNaN, 0);
  assertNotNull(result.card, 'NaN scores filtered — still fires general');
  assert(!engine.getFlaggedMetrics().has('tempo'), 'NaN score does not flag metric');
}

{
  const engine = new PositiveReinforcementEngine();
  const scoresWithUndef: MetricScore[] = [
    { metricKey: 'tempo', score: undefined as unknown as number },
    { metricKey: 'spineAngle', score: 85 },
  ];
  const result = engine.processSwing(highConfidence, scoresWithUndef, 0);
  assertNotNull(result.card, 'undefined scores filtered — still fires');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: NaN }], 0);
  assertEq(engine.getFlaggedMetrics().size, 0, 'NaN score does not flag any metric');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 50 }], 1);
  const result = engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: NaN }], 1);
  assertNull(result.card, 'NaN score does not trigger improvement');
  assertEq(result.improvements.length, 0, 'NaN score: no improvements');
}

// =========================================================================
// Reset
// =========================================================================

group('Reset');

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, badScores, 3);
  assert(engine.getFlaggedMetrics().size > 0, 'flagged metrics exist before reset');
  engine.reset();
  assertEq(engine.getFlaggedMetrics().size, 0, 'flagged metrics cleared after reset');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, goodScores, 0);
  const debugBefore = engine.buildDebugInfo();
  assertEq(debugBefore.sessionPositiveCount, 1, 'session count = 1 before reset');
  engine.reset();
  const debugAfter = engine.buildDebugInfo();
  assertEq(debugAfter.sessionPositiveCount, 0, 'session positive count = 0 after reset');
  assertEq(debugAfter.sessionImprovementCount, 0, 'session improvement count = 0 after reset');
}

{
  const engine = new PositiveReinforcementEngine();
  for (let i = 0; i < 5; i++) {
    engine.processSwing(highConfidence, goodScores, 0);
  }
  engine.reset();
  const result = engine.processSwing(highConfidence, goodScores, 0);
  assertNotNull(result.card, 'card still fires after reset');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 50 }], 1);
  engine.reset();
  const result = engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 90 }], 1);
  assertNull(result.card, 'after reset, no false improvement detection');
}

// =========================================================================
// Debug info
// =========================================================================

group('Debug info');

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, goodScores, 0);
  const debug = engine.buildDebugInfo();
  assertEq(debug.positiveCardShown, true, 'general: positiveCardShown = true');
  assertEq(debug.positiveCardType, 'general', 'general: positiveCardType = general');
  assert(typeof debug.positiveCardMessage === 'string', 'general: message is string');
  assertEq(debug.improvementDetected.length, 0, 'general: no improvements');
  assertEq(debug.sessionPositiveCount, 1, 'general: sessionPositiveCount = 1');
  assertEq(debug.sessionImprovementCount, 0, 'general: sessionImprovementCount = 0');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(lowConfidence, badScores, 3);
  const debug = engine.buildDebugInfo();
  assertEq(debug.positiveCardShown, false, 'no card: positiveCardShown = false');
  assertEq(debug.positiveCardType, null, 'no card: positiveCardType = null');
  assertEq(debug.positiveCardMessage, null, 'no card: positiveCardMessage = null');
  assertEq(debug.improvementDetected.length, 0, 'no card: no improvements');
  assertEq(debug.sessionPositiveCount, 0, 'no card: sessionPositiveCount = 0');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 50 }], 1);
  engine.processSwing(highConfidence, [{ metricKey: 'tempo', score: 90 }], 1);
  const debug = engine.buildDebugInfo();
  assertEq(debug.positiveCardShown, true, 'improvement: positiveCardShown = true');
  assertEq(debug.positiveCardType, 'improvement', 'improvement: type = improvement');
  assertEq(debug.improvementDetected.length, 1, 'improvement: 1 detected');
  assertEq(debug.improvementDetected[0], 'tempo', 'improvement: detected tempo');
  assertEq(debug.sessionImprovementCount, 1, 'improvement: sessionImprovementCount = 1');
}

{
  const engine = new PositiveReinforcementEngine();
  for (let i = 0; i < 4; i++) {
    engine.processSwing(highConfidence, goodScores, 0);
  }
  const debug = engine.buildDebugInfo();
  assertEq(debug.sessionPositiveCount, 4, 'counters accumulate: 4 positives');
}

{
  const engine = new PositiveReinforcementEngine();
  const debug = engine.buildDebugInfo();
  assertEq(debug.positiveCardShown, false, 'before any processSwing: shown = false');
  assertEq(debug.positiveCardType, null, 'before any processSwing: type = null');
  assertEq(debug.positiveCardMessage, null, 'before any processSwing: message = null');
  assertEq(debug.sessionPositiveCount, 0, 'before any processSwing: count = 0');
}

{
  const engine = new PositiveReinforcementEngine();
  engine.processSwing(highConfidence, goodScores, 0);
  engine.processSwing(lowConfidence, badScores, 3);
  const debug = engine.buildDebugInfo();
  assertEq(debug.positiveCardShown, false, 'reflects last swing (no card), not first');
  assertEq(debug.sessionPositiveCount, 1, 'but counter still has the 1 from swing 1');
}

{
  const engine = new PositiveReinforcementEngine();
  const result = engine.processSwing(highConfidence, goodScores, 0);
  const debug = engine.buildDebugInfo();
  assertEq(debug.positiveCardShown, result.card !== null, 'zero-arg matches processSwing result (shown)');
  assertEq(debug.positiveCardType, result.card?.type ?? null, 'zero-arg matches processSwing result (type)');
  assertEq(debug.positiveCardMessage, result.card?.message ?? null, 'zero-arg matches processSwing result (message)');
}

// =========================================================================
// Multi-swing session scenarios
// =========================================================================

group('Session scenarios');

{
  const engine = new PositiveReinforcementEngine();
  let positiveCount = 0;
  for (let i = 0; i < 50; i++) {
    const isGoodSwing = i % 5 >= 2;
    const scores = isGoodSwing ? goodScores : mixedScores;
    const corrections = isGoodSwing ? 0 : 2;
    const conf = isGoodSwing ? highConfidence : mediumConfidence;
    const result = engine.processSwing(conf, scores, corrections);
    if (result.card) positiveCount++;
  }
  assert(positiveCount >= 25, `50-swing 60% good: positives >= 25 (got ${positiveCount})`);
  assert(positiveCount <= 40, `50-swing 60% good: positives <= 40 (got ${positiveCount})`);
}

{
  const engine = new PositiveReinforcementEngine();
  let improvements = 0;
  let generals = 0;
  for (let i = 0; i < 100; i++) {
    const inBadStreak = Math.floor(i / 5) % 2 === 0;
    const scores: MetricScore[] = [
      { metricKey: 'tempo', score: inBadStreak ? 50 : 90 },
      { metricKey: 'spineAngle', score: inBadStreak ? 45 : 88 },
    ];
    const corrections = inBadStreak ? 2 : 0;
    const conf = inBadStreak ? mediumConfidence : highConfidence;
    const result = engine.processSwing(conf, scores, corrections);
    if (result.card?.type === 'improvement') improvements++;
    if (result.card?.type === 'general') generals++;
  }
  assert(improvements > 0, `100-swing alternating: improvements > 0 (got ${improvements})`);
  assert(generals > 0, `100-swing alternating: generals > 0 (got ${generals})`);
}

{
  const engine = new PositiveReinforcementEngine();
  let positiveCount = 0;
  for (let i = 0; i < 20; i++) {
    const result = engine.processSwing(lowConfidence, badScores, 3);
    if (result.card) positiveCount++;
  }
  assertEq(positiveCount, 0, 'all-bad session: zero positive cards');
}

{
  const engine = new PositiveReinforcementEngine();
  let positiveCount = 0;
  for (let i = 0; i < 20; i++) {
    const result = engine.processSwing(highConfidence, goodScores, 0);
    if (result.card) positiveCount++;
  }
  assertEq(positiveCount, 20, 'all-great session: positive card every swing');
}

{
  const engine = new PositiveReinforcementEngine();
  for (let i = 0; i < 50; i++) {
    const result = engine.processSwing(highConfidence, badScores, 3);
    assertNull(result.card, `steady bad swing ${i + 1}: no card`);
  }
}

// =========================================================================
// Singleton export
// =========================================================================

group('Singleton export');

assert(positiveReinforcementEngine instanceof PositiveReinforcementEngine, 'singleton is instance of class');
assert(typeof positiveReinforcementEngine.processSwing === 'function', 'singleton has processSwing');
assert(typeof positiveReinforcementEngine.reset === 'function', 'singleton has reset');
assert(typeof positiveReinforcementEngine.buildDebugInfo === 'function', 'singleton has buildDebugInfo');

// =========================================================================
// Constants validation
// =========================================================================

group('Constants validation');

assert(GENERAL_CARDS.length >= 5, `general cards pool >= 5 (got ${GENERAL_CARDS.length})`);
assert(IMPROVEMENT_TEMPLATES.length >= 2, `improvement templates >= 2 (got ${IMPROVEMENT_TEMPLATES.length})`);

{
  let allHavePlaceholder = true;
  for (const template of IMPROVEMENT_TEMPLATES) {
    if (!template.includes('{metric}')) allHavePlaceholder = false;
  }
  assert(allHavePlaceholder, 'all improvement templates contain {metric}');
}

assertEq(CONFIDENCE_THRESHOLD, 75, 'confidence threshold = 75 (roadmap spec)');
assertEq(GOOD_SCORE_THRESHOLD, 80, 'good score threshold = 80 (matches TIP_SCORE_THRESHOLD)');

{
  const required = ['tempo', 'spineAngle', 'shoulderTilt', 'hipSpreadDelta', 'elbow', 'kneeFlex'];
  let allPresent = true;
  for (const key of required) {
    if (!METRIC_FRIENDLY_NAMES[key]) allPresent = false;
  }
  assert(allPresent, 'friendly names cover all core metrics');
}

{
  let allNonEmpty = true;
  for (const card of GENERAL_CARDS) {
    if (card.length === 0) allNonEmpty = false;
  }
  assert(allNonEmpty, 'no general card is empty string');
}

{
  let allNonEmpty = true;
  for (const template of IMPROVEMENT_TEMPLATES) {
    if (template.length === 0) allNonEmpty = false;
  }
  assert(allNonEmpty, 'no improvement template is empty string');
}

// =========================================================================
// Summary
// =========================================================================

console.log(`\n${'═'.repeat(50)}`);
console.log(`  ${passed + failed} assertions | ${passed} passed | ${failed} failed`);
console.log(`${'═'.repeat(50)}`);

if (failed > 0) {
  console.log('\n⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASSED');
}
