/**
 * sessionInsights.test.ts — Task 14 Insight Text Validation
 *
 * Run with: npx tsx lib/sessionInsights.test.ts
 */

import {
  generateFocusInsight,
  generateImprovementInsight,
  generateConsistencyInsight,
} from './sessionInsights';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

group('generateFocusInsight');
{
  const msg = generateFocusInsight('shoulder tilt', 6);
  assert(msg.includes('shoulder tilt'), 'includes metric name');
  assert(msg.includes('6'), 'includes flag count');
  assert(msg.includes('focusing'), 'actionable language');
}

group('generateImprovementInsight');
{
  const msg = generateImprovementInsight('lead arm');
  assert(msg.includes('lead arm'), 'includes metric name');
  assert(msg.includes('better'), 'positive language');
}

group('generateConsistencyInsight');
{
  const msg = generateConsistencyInsight('tempo', 15);
  assert(msg.includes('tempo'), 'includes metric name');
  assert(msg.includes('15'), 'includes swing count');
  assert(msg.includes('solid'), 'praise language');
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
  console.log('✅ All tests passed — session insight text validated');
}
