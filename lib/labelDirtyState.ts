/**
 * labelDirtyState.ts — PURE dirty-state derivation for the full-swing label
 * bar (unsaved-change visibility).
 *
 * CONTRACT (owner-specified): dirty is DERIVED from equality with the
 * last-saved snapshot — never from an edit-history flag. The comparison runs
 * over the FULL partial map including key presence/absence:
 *   - a stamp added that the snapshot lacks        → dirty
 *   - a stamp moved off its saved frame            → dirty
 *   - a saved stamp missing from current (reset)   → dirty
 *   - every current stamp equal to its saved frame → clean
 * Consequence: moving a stamp away and back to its saved frame is
 * indistinguishable from never having moved it — chip color, Save
 * enablement, and the Reset/Discard morph all read this ONE result.
 *
 * `undefined` values are treated as absent on both sides (the label map uses
 * `Record<string, number | undefined>`).
 */

export type LabelDirtyState = {
  isDirty: boolean;
  /** Keys whose current value differs from the snapshot (added, moved, or
   *  removed) — pendingCount = dirtyKeys.length. */
  dirtyKeys: string[];
  pendingCount: number;
};

function normalize(
  map: Record<string, number | undefined> | Partial<Record<string, number>> | null,
): Map<string, number> {
  const out = new Map<string, number>();
  if (map) {
    for (const [k, v] of Object.entries(map)) {
      if (v != null) out.set(k, v);
    }
  }
  return out;
}

export function diffLabelStamps(
  current: Record<string, number | undefined>,
  saved: Partial<Record<string, number>> | null,
): LabelDirtyState {
  const cur = normalize(current);
  const snap = normalize(saved);
  const keys = new Set<string>([...cur.keys(), ...snap.keys()]);
  const dirtyKeys: string[] = [];
  for (const k of keys) {
    if (cur.get(k) !== snap.get(k)) dirtyKeys.push(k);
  }
  return { isDirty: dirtyKeys.length > 0, dirtyKeys, pendingCount: dirtyKeys.length };
}

/**
 * Per-chip "modified, unsaved" predicate: the chip carries a SAVED value and
 * its current stamp differs. Newly stamped never-saved phases deliberately do
 * NOT count (they keep the standard stamped treatment).
 */
export function isStampModified(
  key: string,
  current: Record<string, number | undefined>,
  saved: Partial<Record<string, number>> | null,
): boolean {
  const cur = current[key];
  const snap = saved?.[key as keyof typeof saved] as number | undefined;
  return cur != null && snap != null && cur !== snap;
}
