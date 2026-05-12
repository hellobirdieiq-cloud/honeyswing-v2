import type { SwingRecord } from '@/packages/domain/clinic/SwingRecord';

const swings = new Map<string, SwingRecord>();

// Returns a swing record by id, or null if not found.
export function getSwingRecord(id: string): SwingRecord | null {
  // stub
  throw new Error('Not implemented');
}

// Inserts or replaces a swing record in the store.
export function upsertSwingRecord(swing: SwingRecord): void {
  // stub
  throw new Error('Not implemented');
}

// Returns all swing records for a given kid.
export function getSwingsByKid(kidId: string): SwingRecord[] {
  // stub
  throw new Error('Not implemented');
}

// Returns all swing records for a given clinic session.
export function getSwingsBySession(sessionId: string): SwingRecord[] {
  // stub
  throw new Error('Not implemented');
}

// Returns swing records by id list, in the same order (skips ids not found).
export function getSwingsByIds(ids: string[]): SwingRecord[] {
  // stub
  throw new Error('Not implemented');
}

// Clears all swing records from the store (test/debug only).
export function clearSwingRecords(): void {
  // stub
  throw new Error('Not implemented');
}
