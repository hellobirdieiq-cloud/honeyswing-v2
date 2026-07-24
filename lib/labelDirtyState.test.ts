/**
 * labelDirtyState.test.ts — derived-dirty contract for the full-swing label
 * bar. The owner-mandated case: move-away-and-back yields NOT-dirty.
 */

import { diffLabelStamps, isStampModified } from './labelDirtyState';

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

console.log('\n=== diffLabelStamps: derived dirty vs saved snapshot ===');

const SAVED = { takeaway: 40, top: 90, impact: 140 };

// Clean: current exactly mirrors the snapshot.
{
  const d = diffLabelStamps({ takeaway: 40, top: 90, impact: 140 }, SAVED);
  assert(!d.isDirty && d.pendingCount === 0, 'current === snapshot → clean');
}

// MOVE-AWAY-AND-BACK (owner-mandated): stamp moves off its saved frame, then
// back — final state must be indistinguishable from never having moved.
{
  const start = { takeaway: 40, top: 90, impact: 140 };
  const moved = { ...start, top: 95 };
  const back = { ...moved, top: 90 };
  const dMoved = diffLabelStamps(moved, SAVED);
  const dBack = diffLabelStamps(back, SAVED);
  assert(dMoved.isDirty && dMoved.dirtyKeys.join() === 'top', 'moved stamp → dirty on that key only');
  assert(isStampModified('top', moved, SAVED), 'moved stamp → chip modified (amber)');
  assert(!dBack.isDirty && dBack.pendingCount === 0, 'MOVE-AWAY-AND-BACK → NOT dirty (no residue)');
  assert(!isStampModified('top', back, SAVED), 'move-away-and-back → chip back to clean (green)');
}

// Presence: an added stamp the snapshot lacks is dirty…
{
  const d = diffLabelStamps({ ...SAVED, follow_through: 200 }, SAVED);
  assert(d.isDirty && d.dirtyKeys.join() === 'follow_through', 'added never-saved stamp → dirty');
  // …but the chip does NOT render amber (keeps standard stamped treatment).
  assert(
    !isStampModified('follow_through', { ...SAVED, follow_through: 200 }, SAVED),
    'never-saved stamp is not "modified" (keeps stamped treatment)',
  );
}

// Absence: a saved stamp missing from current (post-reset) is dirty.
{
  const d = diffLabelStamps({}, SAVED);
  assert(d.isDirty && d.pendingCount === 3, 'wiped current vs 3 saved → dirty ×3 (Discard restores)');
}

// undefined values are absent, not stamps.
{
  const d = diffLabelStamps({ takeaway: 40, top: undefined, impact: 140 }, { takeaway: 40, impact: 140 });
  assert(!d.isDirty, 'undefined value treated as absent on both sides');
}

// No snapshot (never saved): stamps are dirty vs the empty snapshot; none amber.
{
  const d0 = diffLabelStamps({}, null);
  const d1 = diffLabelStamps({ impact: 100 }, null);
  assert(!d0.isDirty, 'no stamps + no snapshot → clean');
  assert(d1.isDirty && d1.pendingCount === 1, 'fresh stamp + no snapshot → dirty (1)');
  assert(!isStampModified('impact', { impact: 100 }, null), 'no snapshot → never amber');
}

// Mixed: one moved + one added → pendingCount 2.
{
  const d = diffLabelStamps({ takeaway: 40, top: 95, impact: 140, follow_through: 200 }, SAVED);
  assert(d.pendingCount === 2, 'moved + added → pendingCount 2 (Save Labels (2))');
}

console.log(`\n${'═'.repeat(55)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(55)}`);
if (failed > 0) {
  console.log('⚠️  SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('✅ All labelDirtyState tests passed');
}
