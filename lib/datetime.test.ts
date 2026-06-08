/**
 * datetime.test.ts — parseDbTimestamp gateway
 *
 * Run with: npx tsx lib/datetime.test.ts
 *
 * Proves every DB timestamp form resolves to the correct UTC instant, that the
 * offset-less (false) branch is exercised through the PUBLIC API, and that real
 * non-UTC offsets are honored.
 */

import { parseDbTimestamp } from './datetime';

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

// 2026-06-06T22:03:28Z in ms since epoch.
const TARGET = 1780783408000;

// ---------------------------------------------------------------------------
// All forms of the same instant resolve identically
// ---------------------------------------------------------------------------

group('Same instant across zone forms → 2026-06-06T22:03:28.000Z');
{
  assertEq(parseDbTimestamp('2026-06-06T22:03:28+00:00').getTime(), TARGET, '+00:00 offset');
  assertEq(parseDbTimestamp('2026-06-06T22:03:28Z').getTime(), TARGET, 'Z marker');
  assertEq(parseDbTimestamp('2026-06-06T22:03:28').getTime(), TARGET, 'offset-less → treated as UTC');
  assertEq(parseDbTimestamp('2026-06-06T22:03:28-00:00').getTime(), TARGET, '-00:00 offset');
  assertEq(parseDbTimestamp('2026-06-06T22:03:28+0000').getTime(), TARGET, '+0000 (no colon)');
}

// ---------------------------------------------------------------------------
// Fractional seconds preserved
// ---------------------------------------------------------------------------

group('Fractional seconds');
{
  assertEq(
    parseDbTimestamp('2026-06-06T22:03:28.724Z').getTime(),
    TARGET + 724,
    '.724Z keeps the millisecond component',
  );
}

// ---------------------------------------------------------------------------
// Real non-UTC offset is honored (not only Z / +00:00)
// ---------------------------------------------------------------------------

group('Non-UTC offset');
{
  assertEq(
    parseDbTimestamp('2026-06-06T18:03:28-04:00').getTime(),
    TARGET,
    '18:03:28-04:00 is the same instant as 22:03:28Z',
  );
}

// ---------------------------------------------------------------------------
// Offset-less (false) branch — verified through the PUBLIC contract.
// If the `+ 'Z'` guard is deleted, an offset-less string would be parsed as
// device-local and this would fail (on any device not at UTC).
// ---------------------------------------------------------------------------

group('Offset-less guard (public-contract check)');
{
  assert(
    parseDbTimestamp('2026-06-06T22:03:28').getTime() ===
      parseDbTimestamp('2026-06-06T22:03:28Z').getTime(),
    'offset-less string equals its explicit-Z equivalent',
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
