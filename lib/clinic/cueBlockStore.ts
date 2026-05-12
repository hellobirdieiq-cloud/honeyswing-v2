import type { CueBlockRecord } from '@/packages/domain/clinic/CueBlock';

const cueBlocks = new Map<string, CueBlockRecord>();

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyListeners(): void {
  listeners.forEach((l) => l());
}

// Returns a cue block by id, or null if not found.
export function getCueBlock(id: string): CueBlockRecord | null {
  return cueBlocks.get(id) ?? null;
}

// Inserts or replaces a cue block in the store.
export function upsertCueBlock(block: CueBlockRecord): void {
  cueBlocks.set(block.id, block);
  notifyListeners();
}

// Returns all cue blocks for a given kid.
export function getCueBlocksByKid(kidId: string): CueBlockRecord[] {
  return Array.from(cueBlocks.values()).filter((b) => b.kidId === kidId);
}

// Returns all cue blocks for a given clinic session.
export function getCueBlocksBySession(sessionId: string): CueBlockRecord[] {
  return Array.from(cueBlocks.values()).filter((b) => b.sessionId === sessionId);
}

// Returns the most recently created cue block in the current session, or null.
export function getActiveCueBlock(sessionId: string): CueBlockRecord | null {
  const inSession = Array.from(cueBlocks.values()).filter(
    (b) => b.sessionId === sessionId,
  );
  if (inSession.length === 0) return null;
  return inSession.reduce((latest, b) =>
    b.recordedAt > latest.recordedAt ? b : latest,
  );
}

// Clears all cue blocks from the store (test/debug only).
export function clearCueBlocks(): void {
  console.warn('[cueBlockStore] clearCueBlocks called — test/debug only');
  cueBlocks.clear();
  notifyListeners();
}
