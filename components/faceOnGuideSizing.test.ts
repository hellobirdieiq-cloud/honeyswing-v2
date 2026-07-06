/**
 * faceOnGuideSizing.test.ts — pins the per-age-tier guide fraction map.
 *
 * Guards two invariants:
 *   1. Every AgeTier has a fraction (a new tier without a guide size is a
 *      compile error via Record, but this also catches runtime holes).
 *   2. adult === 0.57 — behavior-preservation pin: the adult guide must render
 *      exactly as the pre-tier single-fraction build did.
 *   3. Fractions are sane (0 < f <= 1) and monotonically increase with tier
 *      age, so a mistyped tune can't render a junior guide taller than adult.
 *
 * Run with: npx --yes tsx components/faceOnGuideSizing.test.ts
 */

import { GUIDE_HEIGHT_FRACTION_BY_TIER } from './faceOnGuideSizing';
import type { AgeTier } from '@/packages/domain/swing/tipFrequency';

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

const ALL_TIERS: AgeTier[] = ['junior', 'youth', 'teen', 'adult'];

console.log('\n── coverage ──');
for (const tier of ALL_TIERS) {
  const f = GUIDE_HEIGHT_FRACTION_BY_TIER[tier];
  assert(typeof f === 'number' && f > 0 && f <= 1, `${tier} has a fraction in (0, 1] (got ${f})`);
}
assert(
  Object.keys(GUIDE_HEIGHT_FRACTION_BY_TIER).length === ALL_TIERS.length,
  'map has exactly the four known tiers',
);

console.log('\n── behavior-preservation pin ──');
assert(
  GUIDE_HEIGHT_FRACTION_BY_TIER.adult === 0.57,
  'adult === 0.57 (pre-tier GUIDE_HEIGHT_FRACTION)',
);

console.log('\n── ordering ──');
for (let i = 1; i < ALL_TIERS.length; i++) {
  const younger = ALL_TIERS[i - 1];
  const older = ALL_TIERS[i];
  assert(
    GUIDE_HEIGHT_FRACTION_BY_TIER[younger] < GUIDE_HEIGHT_FRACTION_BY_TIER[older],
    `${younger} (${GUIDE_HEIGHT_FRACTION_BY_TIER[younger]}) < ${older} (${GUIDE_HEIGHT_FRACTION_BY_TIER[older]})`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
