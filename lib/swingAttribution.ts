/**
 * Swing attribution — resolved from a snapshot of the active profile taken at
 * the moment recording BEGINS (button-press), never re-read later.
 *
 * The wrong-kid bug came from reading the active profile + handedness at PERSIST
 * time (5–45s after capture, after video extraction). If the active kid was
 * switched in that window, the swing was attributed to the new kid with the new
 * handedness. Snapshotting at button-press and threading the snapshot through
 * analysis + persistence removes that race; this pure helper is the single seam
 * that turns the snapshot into the persisted attribution.
 */

export type ActiveProfileSnapshot = {
  id: string;
  isLeftHanded: boolean;
};

export type SwingAttribution = {
  playerProfileId: string;
  isLeftHanded: boolean;
};

/**
 * Resolve the attribution from the button-press snapshot. Returns `null` when
 * there is no active profile — the caller MUST hard-block (no recording, no
 * save) rather than fall back to a stale/default profile.
 */
export function resolveAttribution(
  snapshot: ActiveProfileSnapshot | null | undefined,
): SwingAttribution | null {
  if (!snapshot || !snapshot.id) return null;
  return { playerProfileId: snapshot.id, isLeftHanded: snapshot.isLeftHanded };
}
