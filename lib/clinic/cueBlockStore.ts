import type { CueBlockRecord } from '@/packages/domain/clinic/CueBlock';

const cueBlocks = new Map<string, CueBlockRecord>();

// Returns a cue block by id, or null if not found.
export function getCueBlock(id: string): CueBlockRecord | null {
  // stub
  throw new Error('Not implemented');
}

// Inserts or replaces a cue block in the store.
export function upsertCueBlock(block: CueBlockRecord): void {
  // stub
  throw new Error('Not implemented');
}

// Returns all cue blocks for a given kid.
export function getCueBlocksByKid(kidId: string): CueBlockRecord[] {
  // stub
  throw new Error('Not implemented');
}

// Returns all cue blocks for a given clinic session.
export function getCueBlocksBySession(sessionId: string): CueBlockRecord[] {
  // stub
  throw new Error('Not implemented');
}

// Returns the most recently created cue block in the current session, or null.
export function getActiveCueBlock(sessionId: string): CueBlockRecord | null {
  // stub
  throw new Error('Not implemented');
}

// Clears all cue blocks from the store (test/debug only).
export function clearCueBlocks(): void {
  // stub
  throw new Error('Not implemented');
}
