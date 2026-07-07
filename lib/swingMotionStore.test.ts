/**
 * swingMotionStore.test.ts — swing-id subscription + capture-token guard.
 *
 * Run with: npx tsx lib/swingMotionStore.test.ts
 *
 * The token guard is the stale-id race fix: a slow swing-A insert that
 * resolves after the user recorded swing B must NOT assign or notify (B's
 * mounted result screen would otherwise adopt A's id and the session-insight
 * rpc would write against the wrong swing).
 *
 * Module-level store state is shared across groups — each group re-derives
 * its own token and ends with clearCurrentSwingMotion().
 */

import type { PoseFrame } from '../packages/pose/PoseTypes';
import {
  clearCurrentSwingMotion,
  getCurrentCaptureToken,
  getCurrentSwingId,
  setCurrentSwingId,
  setCurrentSwingMotion,
  subscribeCurrentSwingId,
} from './swingMotionStore';

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
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

const motion = () => ({
  frames: [] as PoseFrame[],
  recordedAt: 1,
  source: 'live-camera' as const,
  isLeftHanded: false,
});

// ---------------------------------------------------------------------------
// Subscription basics
// ---------------------------------------------------------------------------

group('setCurrentSwingId notifies subscribers and updates the snapshot');
{
  const seen: (string | null)[] = [];
  const unsubscribe = subscribeCurrentSwingId((id) => seen.push(id));
  setCurrentSwingId('swing-1');
  assert(seen.length === 1 && seen[0] === 'swing-1', 'listener received swing-1');
  assert(getCurrentSwingId() === 'swing-1', 'snapshot reads swing-1');
  unsubscribe();
  clearCurrentSwingMotion();
}

group('clearCurrentSwingMotion notifies null');
{
  setCurrentSwingId('swing-2');
  const seen: (string | null)[] = [];
  const unsubscribe = subscribeCurrentSwingId((id) => seen.push(id));
  clearCurrentSwingMotion();
  assert(seen.length === 1 && seen[0] === null, 'listener received null');
  assert(getCurrentSwingId() === null, 'snapshot reads null');
  unsubscribe();
}

group('unsubscribe stops delivery; other listeners still notified');
{
  const a: (string | null)[] = [];
  const b: (string | null)[] = [];
  const unsubA = subscribeCurrentSwingId((id) => a.push(id));
  const unsubB = subscribeCurrentSwingId((id) => b.push(id));
  setCurrentSwingId('swing-3');
  unsubA();
  setCurrentSwingId('swing-4');
  assert(a.length === 1 && a[0] === 'swing-3', 'unsubscribed listener saw only swing-3');
  assert(
    b.length === 2 && b[0] === 'swing-3' && b[1] === 'swing-4',
    'active listener saw both ids',
  );
  unsubB();
  clearCurrentSwingMotion();
}

// ---------------------------------------------------------------------------
// Capture-token guard (stale-id race)
// ---------------------------------------------------------------------------

group('same-token resolve lands: assigns and notifies');
{
  setCurrentSwingMotion(motion());
  const token = getCurrentCaptureToken();
  const seen: (string | null)[] = [];
  const unsubscribe = subscribeCurrentSwingId((id) => seen.push(id));
  setCurrentSwingId('swing-5', token);
  assert(seen.length === 1 && seen[0] === 'swing-5', 'listener received swing-5');
  assert(getCurrentSwingId() === 'swing-5', 'snapshot reads swing-5');
  unsubscribe();
  clearCurrentSwingMotion();
}

group('late resolve from a superseded capture (new capture) does not notify');
{
  setCurrentSwingMotion(motion()); // capture A claims the store
  const staleToken = getCurrentCaptureToken();
  setCurrentSwingMotion(motion()); // capture B supersedes A
  const seen: (string | null)[] = [];
  const unsubscribe = subscribeCurrentSwingId((id) => seen.push(id));
  setCurrentSwingId('swing-A', staleToken); // A's insert resolves late
  assert(seen.length === 0, 'listener NOT called');
  assert(getCurrentSwingId() === null, 'id unchanged (null)');
  unsubscribe();
  clearCurrentSwingMotion();
}

group('late resolve after clearCurrentSwingMotion does not notify');
{
  setCurrentSwingMotion(motion());
  const staleToken = getCurrentCaptureToken();
  clearCurrentSwingMotion(); // user reset / new recording armed
  const seen: (string | null)[] = [];
  const unsubscribe = subscribeCurrentSwingId((id) => seen.push(id));
  setCurrentSwingId('swing-A', staleToken);
  assert(seen.length === 0, 'listener NOT called');
  assert(getCurrentSwingId() === null, 'id unchanged (null)');
  unsubscribe();
  clearCurrentSwingMotion();
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
  console.log('✅ All tests passed — swing-id subscription + token guard validated');
}
