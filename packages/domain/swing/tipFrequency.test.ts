/**
 * tipFrequency.test.ts — Task 7 Comprehensive Validation
 *
 * Run with: npx tsx packages/domain/swing/tipFrequency.test.ts
 *
 * Covers:
 *   - Core tier transitions (full → shortened → suppressed)
 *   - 50-swing roadmap acceptance criteria
 *   - Sliding window behavior for multi-hour sessions
 *   - Age tier limit switching
 *   - Edge cases (empty tips, unknown metrics, zero-limit)
 *   - processSwingTips integration with shouldShowMetric gate
 *   - Debug output shape stability
 *   - Adversarial / boundary inputs
 */

import {
  tipFrequencyLimiter,
  processSwingTips,
  getFrequencyDebugInfo,
  METRIC_LIMITS,
  DEFAULT_LIMIT,
  type RawCoachingTip,
  type SwingConfidence,
  type CameraAngleResult,
  type ShouldShowMetricFn,
  type TipDecision,
  type AgeTier,
} from './tipFrequency';

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
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_CONFIDENCE: SwingConfidence = {
  overall: 0.65,
  tier: 'medium',
  components: { jointVisibility: 0.8, phaseDetection: 1.0, frameCoverage: 1.0, cameraAngle: 0.3 },
};

// Neutral "unknown" camera result (mirrors cameraAngle.ts unknownResult()).
// Inert in this suite: only threaded to the injected shouldShowMetricFn.
const MOCK_CAMERA: CameraAngleResult = {
  angle: 'unknown',
  shoulderSpread: 0,
  hipSpread: 0,
  avgSpread: 0,
  footIndexNorm: null,
  weights: {
    spineAngle: 0,
    leftElbowAngle: 0,
    rightElbowAngle: 0,
    leftKneeAngle: 0,
    rightKneeAngle: 0,
    hipSpreadDelta: 0,
    shoulderTilt: 0,
    tempo: 0,
  },
};

const alwaysShow: ShouldShowMetricFn = () => true;
const neverShow: ShouldShowMetricFn = () => false;

function selectiveShow(...allowed: string[]): ShouldShowMetricFn {
  const set = new Set(allowed);
  return (metric) => set.has(metric);
}

function makeTip(metricKey: string): RawCoachingTip {
  return { metricKey };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n=== Task 7: Tip Frequency Limiter — Full Validation ===');

// ── 1. Core tier transitions ──

group('1. Core tier transitions');
tipFrequencyLimiter.reset();
{
  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('shoulderTilt'),
    'full',
    'First mention → full',
  );
  tipFrequencyLimiter.recordShown('shoulderTilt');

  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('shoulderTilt'),
    'shortened',
    'Second mention → shortened',
  );
  tipFrequencyLimiter.recordShown('shoulderTilt');

  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('shoulderTilt'),
    'shortened',
    'Third mention → still shortened (under limit=3)',
  );
  tipFrequencyLimiter.recordShown('shoulderTilt'); // count=3

  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('shoulderTilt'),
    'suppressed',
    'Fourth mention → suppressed (at limit=3)',
  );
}

// ── 2. Zero-limit metrics ──

group('2. Zero-limit metrics always suppressed');
tipFrequencyLimiter.reset();
{
  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('spineAngle'),
    'suppressed',
    'spineAngle (youth limit=0) suppressed on first mention',
  );
  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('clubfaceAngle'),
    'suppressed',
    'clubfaceAngle (youth limit=0) suppressed on first mention',
  );
}

// ── 3. Independent metric tracking ──

group('3. Independent metric tracking');
tipFrequencyLimiter.reset();
{
  tipFrequencyLimiter.recordShown('grip');
  tipFrequencyLimiter.recordShown('grip');

  assertEq(tipFrequencyLimiter.getTipDisplayTier('grip'), 'shortened', 'grip (2x) → shortened');
  assertEq(tipFrequencyLimiter.getTipDisplayTier('tempo'), 'full', 'tempo (0x) → full');
  assertEq(tipFrequencyLimiter.getTipDisplayTier('balance'), 'full', 'balance (0x) → full');
}

// ── 4. Reset clears all state ──

group('4. Reset clears all state');
{
  tipFrequencyLimiter.recordShown('grip');
  tipFrequencyLimiter.recordShown('grip');
  tipFrequencyLimiter.reset();
  assertEq(tipFrequencyLimiter.getTipDisplayTier('grip'), 'full', 'grip → full after reset');

  const stats = tipFrequencyLimiter.getSessionStats();
  assertEq(stats.swingsProcessed, 0, 'swingsProcessed reset to 0');
  assertEq(stats.tipsShown, 0, 'tipsShown reset to 0');
  assertEq(stats.tipsSuppressed, 0, 'tipsSuppressed reset to 0');
  assertEq(stats.tipsBlockedByConfidence, 0, 'tipsBlockedByConfidence reset to 0');
}

// ── 5. Unknown metric gets default limit ──

group('5. Unknown metric → default limit');
tipFrequencyLimiter.reset();
{
  const decision = tipFrequencyLimiter.getTipDecision('totallyNewMetric');
  assertEq(decision.limit, DEFAULT_LIMIT, `unknown metric limit = ${DEFAULT_LIMIT}`);
  assertEq(decision.tier, 'full', 'unknown metric first mention = full');

  // Show it DEFAULT_LIMIT times
  for (let i = 0; i < DEFAULT_LIMIT; i++) {
    tipFrequencyLimiter.recordShown('totallyNewMetric');
  }
  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('totallyNewMetric'),
    'suppressed',
    `unknown metric suppressed at count=${DEFAULT_LIMIT}`,
  );
}

// ── 6. processSwingTips integration ──

group('6. processSwingTips — full pipeline');
tipFrequencyLimiter.reset();
{
  const tips = [makeTip('grip'), makeTip('shoulderTilt'), makeTip('spineAngle')];

  // First pass
  const p1 = processSwingTips(tips, alwaysShow, MOCK_CONFIDENCE, MOCK_CAMERA);
  assertEq(p1.length, 2, 'pass 1: spineAngle filtered (limit=0), 2 remain');
  assertEq(p1[0].decision.tier, 'full', 'pass 1: grip = full');
  assertEq(p1[1].decision.tier, 'full', 'pass 1: shoulderTilt = full');

  // Second pass
  const p2 = processSwingTips(tips, alwaysShow, MOCK_CONFIDENCE, MOCK_CAMERA);
  assertEq(p2.length, 2, 'pass 2: still 2 tips');
  assertEq(p2[0].decision.tier, 'shortened', 'pass 2: grip = shortened');
  assertEq(p2[1].decision.tier, 'shortened', 'pass 2: shoulderTilt = shortened');
}

// ── 7. shouldShowMetric gate blocks before frequency check ──

group('7. shouldShowMetric gate');
tipFrequencyLimiter.reset();
{
  const tips = [makeTip('grip'), makeTip('shoulderTilt')];

  // All blocked by confidence gate
  const p = processSwingTips(tips, neverShow, MOCK_CONFIDENCE, MOCK_CAMERA);
  assertEq(p.length, 0, 'all tips blocked when shouldShowMetric=false');

  const stats = tipFrequencyLimiter.getSessionStats();
  assertEq(stats.tipsBlockedByConfidence, 2, 'blockedByConfidence incremented');

  // Selective gate: only grip passes
  tipFrequencyLimiter.reset();
  const p2 = processSwingTips(tips, selectiveShow('grip'), MOCK_CONFIDENCE, MOCK_CAMERA);
  assertEq(p2.length, 1, 'only grip passes selective gate');
  assertEq(p2[0].metricKey, 'grip', 'passed tip is grip');
}

// ── 8. Empty tips array ──

group('8. Edge case: empty tips array');
tipFrequencyLimiter.reset();
{
  const p = processSwingTips([], alwaysShow, MOCK_CONFIDENCE, MOCK_CAMERA);
  assertEq(p.length, 0, 'empty input → empty output');
  assertEq(tipFrequencyLimiter.getSessionStats().swingsProcessed, 1, 'swing still counted');
}

// ── 9. Age tier switching ──

group('9. Age tier switching');
tipFrequencyLimiter.reset();
{
  // Youth: spineAngle limit=0
  tipFrequencyLimiter.setAgeTier('youth');
  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('spineAngle'),
    'suppressed',
    'youth: spineAngle suppressed',
  );

  // Teen: spineAngle limit=3
  tipFrequencyLimiter.setAgeTier('teen');
  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('spineAngle'),
    'full',
    'teen: spineAngle allowed',
  );

  // Adult: shoulderTilt limit=8 (more generous)
  tipFrequencyLimiter.setAgeTier('adult');
  const decision = tipFrequencyLimiter.getTipDecision('shoulderTilt');
  assertEq(decision.limit, 8, 'adult: shoulderTilt limit=8');

  // Restore default
  tipFrequencyLimiter.setAgeTier('youth');
}

// ── 10. Age tier limit tables are complete ──

group('10. Age tier limit tables comprehensive');
{
  const tiers: AgeTier[] = ['youth', 'teen', 'adult'];
  const coreMetrics = [
    'grip', 'posture', 'tempo', 'balance', 'armExtension',
    'shoulderTilt', 'hipSpreadDelta', 'kneeFlex', 'elbow',
  ];

  for (const tier of tiers) {
    for (const metric of coreMetrics) {
      const limit = METRIC_LIMITS[tier][metric];
      assert(
        typeof limit === 'number' && limit >= 0,
        `${tier}.${metric} = ${limit} (valid)`,
      );
    }
  }

  // Youth should be most conservative
  for (const metric of coreMetrics) {
    assert(
      METRIC_LIMITS['youth'][metric] <= METRIC_LIMITS['adult'][metric],
      `youth.${metric} (${METRIC_LIMITS['youth'][metric]}) ≤ adult.${metric} (${METRIC_LIMITS['adult'][metric]})`,
    );
  }
}

// ── 11. Sliding window behavior ──

group('11. Sliding window for multi-hour sessions');
tipFrequencyLimiter.reset();
{
  // Use a very short window (1 minute) to simulate expiration
  tipFrequencyLimiter.setWindowMinutes(1);

  // Show shoulderTilt 3x (at limit for youth)
  tipFrequencyLimiter.recordShown('shoulderTilt');
  tipFrequencyLimiter.recordShown('shoulderTilt');
  tipFrequencyLimiter.recordShown('shoulderTilt');
  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('shoulderTilt'),
    'suppressed',
    'at limit → suppressed',
  );

  // Manually expire timestamps by monkeypatching Date.now
  // (simulate 2 minutes passing)
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60 * 1000;

  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('shoulderTilt'),
    'full',
    'after window expires → full again (sliding window works)',
  );

  // Restore
  Date.now = realNow;
  tipFrequencyLimiter.setWindowMinutes(60);
}

// ── 14. TipDecision has correct shape ──

group('14. TipDecision shape validation');
tipFrequencyLimiter.reset();
{
  const d = tipFrequencyLimiter.getTipDecision('grip');
  assert(typeof d.metricKey === 'string', 'metricKey is string');
  assert(['full', 'shortened', 'suppressed'].includes(d.tier), 'tier is valid');
  assert(typeof d.shownInWindow === 'number' && d.shownInWindow >= 0, 'shownInWindow ≥ 0');
  assert(typeof d.limit === 'number' && d.limit >= 0, 'limit ≥ 0');
  assert(typeof d.reason === 'string' && d.reason.length > 0, 'reason is non-empty string');
}

// ── 15. Debug output shape stability ──

group('15. getFrequencyDebugInfo shape stability');
tipFrequencyLimiter.reset();
{
  processSwingTips([makeTip('grip')], alwaysShow, MOCK_CONFIDENCE, MOCK_CAMERA);

  const debug = getFrequencyDebugInfo();
  assert('tipFrequency' in debug, 'top-level key is tipFrequency');

  const tf = debug.tipFrequency;
  const requiredKeys = [
    'windowMin', 'ageTier', 'swings', 'shown',
    'suppressed', 'blockedByConfidence', 'sessionMs', 'counts',
  ];
  for (const key of requiredKeys) {
    assert(key in tf, `tipFrequency.${key} exists`);
  }

  assert(typeof tf.windowMin === 'number', 'windowMin is number');
  assert(typeof tf.ageTier === 'string', 'ageTier is string');
  assert(typeof tf.swings === 'number', 'swings is number');
  assert(typeof tf.sessionMs === 'number' && (tf.sessionMs as number) >= 0, 'sessionMs ≥ 0');
  assert(typeof tf.counts === 'object' && tf.counts !== null, 'counts is object');
}

// ── 17. Stats tracking across multiple swings ──

group('17. Stats tracking accuracy');
tipFrequencyLimiter.reset();
{
  const tips = [makeTip('grip'), makeTip('spineAngle')]; // 1 passable, 1 limit=0

  processSwingTips(tips, alwaysShow, MOCK_CONFIDENCE, MOCK_CAMERA);
  processSwingTips(tips, alwaysShow, MOCK_CONFIDENCE, MOCK_CAMERA);
  processSwingTips(tips, neverShow, MOCK_CONFIDENCE, MOCK_CAMERA); // all blocked

  const stats = tipFrequencyLimiter.getSessionStats();
  assertEq(stats.swingsProcessed, 3, '3 swings processed');
  assertEq(stats.tipsShown, 2, '2 tips shown (grip x2)');
  // Since 0732840, Gate 1.75 (isMetricEligible) drops limit-0 metrics like
  // spineAngle@youth with a bare continue BEFORE Gate 2's recordSuppressed():
  // tipsSuppressed counts frequency-limit suppressions only; eligibility
  // skips are uncounted (semantics accepted in Batch 3, Option 1).
  assertEq(stats.tipsSuppressed, 0, '0 suppressed (spineAngle x2 dropped at eligibility gate, uncounted)');
  assertEq(stats.tipsBlockedByConfidence, 2, '2 blocked by confidence (swing 3)');
}

// ── 18. Window minutes configuration ──

group('18. Window configuration');
{
  tipFrequencyLimiter.setWindowMinutes(30);
  assertEq(tipFrequencyLimiter.windowMinutes, 30, 'windowMinutes=30 set');

  // Minimum clamp to 1 minute
  tipFrequencyLimiter.setWindowMinutes(0);
  assertEq(tipFrequencyLimiter.windowMinutes, 1, 'windowMinutes=0 clamped to 1');

  tipFrequencyLimiter.setWindowMinutes(-5);
  assertEq(tipFrequencyLimiter.windowMinutes, 1, 'negative clamped to 1');

  // Restore
  tipFrequencyLimiter.setWindowMinutes(60);
}

// ── 19. Roadmap acceptance: 50-swing session ──

group('19. ROADMAP ACCEPTANCE: 50-swing session');
tipFrequencyLimiter.reset();
tipFrequencyLimiter.setAgeTier('youth');
{
  const allMetricKeys = Object.keys(METRIC_LIMITS['youth']).filter(
    (k) => METRIC_LIMITS['youth'][k] > 0,
  );
  const shownCounts: Record<string, number> = {};

  for (let swing = 0; swing < 50; swing++) {
    const tips = allMetricKeys.map((k) => makeTip(k));
    const processed = processSwingTips(tips, alwaysShow, MOCK_CONFIDENCE, MOCK_CAMERA);
    for (const tip of processed) {
      shownCounts[tip.metricKey] = (shownCounts[tip.metricKey] ?? 0) + 1;
    }
  }

  // tempo carries a positive limit but is hard-gated by isMetricEligible
  // ("no System B representation (no cue()), must be suppressed" — 0732840),
  // so it can never be shown: pin that, and exclude it from full-utilization.
  assertEq(shownCounts['tempo'] ?? 0, 0, 'tempo: shown 0x (hard-gated by isMetricEligible)');

  // Every eligible metric must exactly use up its limit
  for (const metric of allMetricKeys.filter((k) => k !== 'tempo')) {
    const limit = METRIC_LIMITS['youth'][metric];
    const shown = shownCounts[metric] ?? 0;
    assert(shown <= limit, `${metric}: shown ${shown} ≤ limit ${limit}`);
    assert(shown === limit, `${metric}: shown ${shown} === limit ${limit} (fully utilized)`);
  }

  // Specific roadmap check
  const shoulderShown = shownCounts['shoulderTilt'] ?? 0;
  assert(shoulderShown <= 3, `shoulderTilt shown ${shoulderShown}x ≤ 3 (ROADMAP CRITERION)`);

  // Print summary
  console.log('\n  50-swing session summary:');
  const sorted = Object.entries(shownCounts).sort((a, b) => b[1] - a[1]);
  for (const [metric, count] of sorted) {
    const limit = METRIC_LIMITS['youth'][metric];
    console.log(`    ${metric}: ${count}/${limit}${count === limit ? ' ✓' : ''}`);
  }
}

// ── 20. Roadmap acceptance: teen 50-swing session ──

group('20. Teen 50-swing session');
tipFrequencyLimiter.reset();
tipFrequencyLimiter.setAgeTier('teen');
{
  const teenMetrics = Object.keys(METRIC_LIMITS['teen']).filter(
    (k) => METRIC_LIMITS['teen'][k] > 0,
  );
  const shownCounts: Record<string, number> = {};

  for (let swing = 0; swing < 50; swing++) {
    const tips = teenMetrics.map((k) => makeTip(k));
    const processed = processSwingTips(tips, alwaysShow, MOCK_CONFIDENCE, MOCK_CAMERA);
    for (const tip of processed) {
      shownCounts[tip.metricKey] = (shownCounts[tip.metricKey] ?? 0) + 1;
    }
  }

  for (const metric of teenMetrics) {
    const limit = METRIC_LIMITS['teen'][metric];
    const shown = shownCounts[metric] ?? 0;
    assert(shown <= limit, `teen.${metric}: shown ${shown} ≤ limit ${limit}`);
  }

  // Teen allows spineAngle (limit=3) — verify it fires
  assert(
    (shownCounts['spineAngle'] ?? 0) > 0,
    `teen: spineAngle fires (shown ${shownCounts['spineAngle'] ?? 0}x)`,
  );

  tipFrequencyLimiter.setAgeTier('youth'); // restore
}

// ── 21. Boundary: exactly at limit ──

group('21. Boundary: behavior at exact limit');
tipFrequencyLimiter.reset();
{
  // hipSpreadDelta limit=2 (youth)
  tipFrequencyLimiter.recordShown('hipSpreadDelta');
  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('hipSpreadDelta'),
    'shortened',
    'count=1 < limit=2 → shortened',
  );

  tipFrequencyLimiter.recordShown('hipSpreadDelta');
  assertEq(
    tipFrequencyLimiter.getTipDisplayTier('hipSpreadDelta'),
    'suppressed',
    'count=2 === limit=2 → suppressed',
  );
}

// ── 22. Large volume stress test ──

group('22. Stress test: 200 swings');
tipFrequencyLimiter.reset();
{
  let totalShown = 0;
  let totalSuppressed = 0;

  for (let i = 0; i < 200; i++) {
    const tips = [makeTip('grip'), makeTip('shoulderTilt')];
    const processed = processSwingTips(tips, alwaysShow, MOCK_CONFIDENCE, MOCK_CAMERA);
    totalShown += processed.length;
    totalSuppressed += tips.length - processed.length;
  }

  const stats = tipFrequencyLimiter.getSessionStats();
  assertEq(stats.swingsProcessed, 200, '200 swings processed');
  assert(totalShown > 0, `tips shown: ${totalShown}`);
  assert(totalSuppressed > 0, `tips suppressed: ${totalSuppressed}`);

  // grip limit=20, shoulderTilt limit=3 → max 23 tips across 200 swings
  assert(totalShown <= 23, `total shown ${totalShown} ≤ 23 (grip=20 + shoulder=3)`);
  assertEq(totalShown, 23, `total shown ${totalShown} === 23 (fully utilized)`);
}

// ── 23. ProcessedCoachingTip type completeness ──

group('23. ProcessedCoachingTip has all required fields');
tipFrequencyLimiter.reset();
{
  const tips = [makeTip('grip')];
  const processed = processSwingTips(tips, alwaysShow, MOCK_CONFIDENCE, MOCK_CAMERA);
  const tip = processed[0];

  assert(typeof tip.metricKey === 'string', 'has metricKey');
  assert(typeof tip.decision === 'object' && tip.decision !== null, 'has decision');
  assert(['full', 'shortened'].includes(tip.decision.tier), 'decision has valid tier');
  assert(typeof tip.decision.reason === 'string', 'decision has reason');
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
  console.log('✅ All tests passed — Task 7 validated');
  console.log('   Sliding window, age tiers, gating pipeline all verified');
}
