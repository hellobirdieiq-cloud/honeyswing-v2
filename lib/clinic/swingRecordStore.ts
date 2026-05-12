import type { SwingRecord } from '@/packages/domain/clinic/SwingRecord';

const swings = new Map<string, SwingRecord>();

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyListeners(): void {
  listeners.forEach((l) => l());
}

// Returns a swing record by id, or null if not found.
export function getSwingRecord(id: string): SwingRecord | null {
  return swings.get(id) ?? null;
}

// Inserts or replaces a swing record in the store.
export function upsertSwingRecord(swing: SwingRecord): void {
  swings.set(swing.id, swing);
  notifyListeners();
}

// Returns all swing records for a given kid.
export function getSwingsByKid(kidId: string): SwingRecord[] {
  return Array.from(swings.values()).filter((s) => s.kidId === kidId);
}

// Returns all swing records for a given clinic session.
export function getSwingsBySession(sessionId: string): SwingRecord[] {
  return Array.from(swings.values()).filter((s) => s.sessionId === sessionId);
}

// Returns swing records by id list, in the same order (skips ids not found).
export function getSwingsByIds(ids: string[]): SwingRecord[] {
  return ids.flatMap((id) => {
    const s = swings.get(id);
    return s ? [s] : [];
  });
}

// Clears all swing records from the store (test/debug only).
export function clearSwingRecords(): void {
  console.warn('[swingRecordStore] clearSwingRecords called — test/debug only');
  swings.clear();
  notifyListeners();
}
