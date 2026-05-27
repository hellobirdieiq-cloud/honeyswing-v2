/**
 * frameDriftGuard.ts — Phase 8 of the RTMW migration.
 *
 * Silent-correctness sensor: compares the camera's recorded frame count
 * against the expected count for the recorded duration at CAPTURE_FPS.
 * Drift events are durably logged to AsyncStorage. The sensor never blocks
 * the swing flow — "flag-but-persist". Phase 9 corpus replay validates the
 * 10% threshold.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const DRIFT_THRESHOLD = 0.10;

// IEEE-754 float epsilon for boundary symmetry: prevents ratios at the
// boundary (e.g. 264/240 = 1.1 + ~3e-16) from flagging due to
// representation noise.
const FLOAT_EPS = 1e-9;

const STORAGE_KEY = 'frameDriftLog:v1';
const MAX_ENTRIES = 100;

export type StorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export interface DriftResult {
  driftRatio: number;
  flagged: boolean;
}

export interface DriftRecord {
  swingId: string;
  recordedFrameCount: number;
  expectedFrameCount: number;
  driftRatio: number;
  flagged: boolean;
  recordedAtIso: string;
}

let __storage: StorageAdapter = AsyncStorage;
let __writeChain: Promise<unknown> = Promise.resolve();

export function computeDrift(
  recordedFrameCount: number,
  recordedDurationMs: number,
  expectedFps: number,
): DriftResult {
  if (
    !Number.isFinite(recordedFrameCount) ||
    !Number.isFinite(recordedDurationMs) ||
    !Number.isFinite(expectedFps) ||
    recordedDurationMs <= 0 ||
    recordedFrameCount < 0 ||
    expectedFps <= 0
  ) {
    return { driftRatio: 0, flagged: false };
  }
  const expected = (expectedFps * recordedDurationMs) / 1000;
  const driftRatio = recordedFrameCount / expected;
  const flagged = Math.abs(driftRatio - 1.0) > DRIFT_THRESHOLD + FLOAT_EPS;
  return { driftRatio, flagged };
}

export function recordDriftEvent(
  swingId: string,
  recordedFrameCount: number,
  recordedDurationMs: number,
  expectedFps: number,
): Promise<DriftResult> {
  const next = __writeChain.then(async (): Promise<DriftResult> => {
    const result = computeDrift(
      recordedFrameCount,
      recordedDurationMs,
      expectedFps,
    );
    try {
      const raw = await __storage.getItem(STORAGE_KEY);
      let log: DriftRecord[] = [];
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) log = parsed as DriftRecord[];
        } catch {
          log = [];
        }
      }
      const record: DriftRecord = {
        swingId,
        recordedFrameCount,
        expectedFrameCount: (expectedFps * recordedDurationMs) / 1000,
        driftRatio: result.driftRatio,
        flagged: result.flagged,
        recordedAtIso: new Date().toISOString(),
      };
      log.push(record);
      if (log.length > MAX_ENTRIES) {
        log = log.slice(log.length - MAX_ENTRIES);
      }
      await __storage.setItem(STORAGE_KEY, JSON.stringify(log));
    } catch (err) {
      console.warn('[frameDriftGuard] persist failed:', err);
    }
    return result;
  });
  __writeChain = next.catch(() => {});
  return next;
}

export async function getDriftLog(): Promise<DriftRecord[]> {
  try {
    const raw = await __storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as DriftRecord[];
  } catch {
    return [];
  }
}

export function __setStorageForTesting(adapter: StorageAdapter): void {
  __storage = adapter;
}
