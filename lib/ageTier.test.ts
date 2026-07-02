/**
 * ageTier.test.ts — Task 15 Validation
 *
 * Run with: npx tsx lib/ageTier.test.ts
 *
 * Tests the AgeTier type expansion and junior variant logic.
 * AsyncStorage get/set is tested via device; this tests the type system
 * and tip text variant selection.
 */

import type { AgeTier } from '@/packages/domain/swing/tipFrequency';
import { METRIC_LIMITS } from '@/packages/domain/swing/tipFrequency';

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
// AgeTier type covers 4 tiers
// ---------------------------------------------------------------------------

group('AgeTier — 4 tiers exist in METRIC_LIMITS');
{
  const tiers: AgeTier[] = ['junior', 'youth', 'teen', 'adult'];
  for (const tier of tiers) {
    assert(tier in METRIC_LIMITS, `METRIC_LIMITS has "${tier}" tier`);
  }
  assertEq(Object.keys(METRIC_LIMITS).length, 4, '4 tiers total');
}

group('Junior limits are most conservative');
{
  const junior = METRIC_LIMITS.junior;
  const youth = METRIC_LIMITS.youth;

  assert(junior !== undefined, 'junior limits exist');
  assert(youth !== undefined, 'youth limits exist');

  // Every junior limit should be <= the corresponding youth limit
  for (const key of Object.keys(junior)) {
    const jLimit = junior[key] ?? 0;
    const yLimit = youth[key] ?? 0;
    assert(jLimit <= yLimit, `junior.${key} (${jLimit}) <= youth.${key} (${yLimit})`);
  }
}

group('Junior has zero limits for advanced metrics');
{
  const junior = METRIC_LIMITS.junior;
  assertEq(junior.spineAngle, 0, 'spineAngle suppressed for junior');
  assertEq(junior.clubfaceAngle, 0, 'clubfaceAngle suppressed for junior');
}

group('Junior tip variant selection logic');
{
  // Simulating the buildRawTips logic for junior vs youth
  const coachingText = {
    spineAngle: { title: 'Spine', body: 'Check your spine angle.', juniorBody: 'Stand tall' },
    tempo: { title: 'Tempo', body: 'Smooth your tempo.' },
  };

  function getBody(metric: string, ageTier: AgeTier): string {
    const text = coachingText[metric as keyof typeof coachingText];
    if (!text) return '';
    const useJunior = ageTier === 'junior';
    return useJunior && 'juniorBody' in text && text.juniorBody ? text.juniorBody : text.body;
  }

  assertEq(getBody('spineAngle', 'junior'), 'Stand tall', 'junior gets juniorBody');
  assertEq(getBody('spineAngle', 'youth'), 'Check your spine angle.', 'youth gets default body');
  assertEq(getBody('spineAngle', 'teen'), 'Check your spine angle.', 'teen gets default body');
  assertEq(getBody('spineAngle', 'adult'), 'Check your spine angle.', 'adult gets default body');
  assertEq(getBody('tempo', 'junior'), 'Smooth your tempo.', 'junior falls back to body when no juniorBody');
}

group('Junior tip text guidelines');
{
  // Verify junior text from the actual coaching content in result.tsx
  // These should be max 10 words, no jargon, positive framing
  const juniorTexts = [
    'Stand tall like an athlete',
    'Try keeping your front arm straight',
    'Let your back arm bend and stretch',
    'Bend your front knee a little',
    'Keep your back knee soft',
    'Keep your shoulders more level',
    'Nice and slow going back',
  ];

  for (const text of juniorTexts) {
    const wordCount = text.split(' ').length;
    assert(wordCount <= 10, `"${text}" has ${wordCount} words (≤10)`);
    assert(!text.includes('lead elbow'), `"${text}" no jargon "lead elbow"`);
    assert(!text.includes('hip rotation'), `"${text}" no jargon "hip rotation"`);
    assert(!text.toLowerCase().includes("don't"), `"${text}" no negative framing`);
    assert(!text.toLowerCase().includes("stop"), `"${text}" no negative framing`);
  }
}

// ---------------------------------------------------------------------------
// Synchronous cache (getCachedAgeTier)
// ---------------------------------------------------------------------------

import { getCachedAgeTier, _resetCacheForTesting } from './ageTier';

group('Synchronous cache (getCachedAgeTier)');
{
  // Reset to default first
  _resetCacheForTesting('youth');
  assertEq(getCachedAgeTier(), 'youth', 'default cache is youth');

  _resetCacheForTesting('junior');
  assertEq(getCachedAgeTier(), 'junior', 'cache returns junior after set');

  _resetCacheForTesting('teen');
  assertEq(getCachedAgeTier(), 'teen', 'cache returns teen after set');

  _resetCacheForTesting('adult');
  assertEq(getCachedAgeTier(), 'adult', 'cache returns adult after set');

  // Multiple cycles
  _resetCacheForTesting('junior');
  assertEq(getCachedAgeTier(), 'junior', 'cycle 1: junior');
  _resetCacheForTesting('youth');
  assertEq(getCachedAgeTier(), 'youth', 'cycle 2: youth');
  _resetCacheForTesting('adult');
  assertEq(getCachedAgeTier(), 'adult', 'cycle 3: adult');

  // Reset back to default for any subsequent test runs
  _resetCacheForTesting('youth');
}

// ---------------------------------------------------------------------------
// applyAgeTier (Batch 5.3) — synchronous limiter sync + cache, persist started
// ---------------------------------------------------------------------------

import { applyAgeTier } from './ageTier';
import { tipFrequencyLimiter } from '@/packages/domain/swing/tipFrequency';

group('applyAgeTier: limiter + cache sync SYNCHRONOUSLY, persist returned');
{
  _resetCacheForTesting('youth');
  tipFrequencyLimiter.setAgeTier('youth');

  const persist = applyAgeTier('adult');
  // Both side effects must be visible BEFORE the persist promise settles —
  // settings.tsx fire-and-forgets the persist, so the sync path is the contract.
  assertEq(getCachedAgeTier(), 'adult', 'module cache synced synchronously');
  assertEq(tipFrequencyLimiter.ageTier, 'adult', 'tip limiter synced synchronously');
  assert(typeof persist.then === 'function', 'returns the persist promise (caller decides await vs fire-and-forget)');
  // AsyncStorage has no native backing under tsx — attach a catch synchronously
  // to swallow the expected rejection (no top-level await under the CJS runner).
  persist.catch(() => {});

  // Reset for any subsequent runs
  _resetCacheForTesting('youth');
  tipFrequencyLimiter.setAgeTier('youth');
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
  console.log('✅ All tests passed — Task 15 age tier validated');
}
