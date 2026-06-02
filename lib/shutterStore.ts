// Cross-tree shutter store: lets the floating tab bar's center button trigger the
// capture flow that lives in app/(tabs)/record.tsx, and lets the bar reactively
// reflect whether a capture is in progress (● vs Stop).
//
// Mirrors the module-singleton shape of swingMotionStore.ts (module-scoped vars +
// plain functions). Adds only the minimal subscribe/getSnapshot plumbing that the
// two call sites (record.tsx + the tab bar) require — single handler slots
// (last-wins), one boolean. Not a generic event bus.

let shutterHandler: (() => void) | null = null;
let stopHandler: (() => void) | null = null;
let isRecording = false;

const listeners = new Set<() => void>();

// ─── Handler slots (set/clear from record.tsx focus-effect) ──────────────────

export function registerShutter(fn: () => void): void {
  shutterHandler = fn;
}

export function clearShutter(): void {
  shutterHandler = null;
}

export function registerStop(fn: () => void): void {
  stopHandler = fn;
}

export function clearStop(): void {
  stopHandler = null;
}

// ─── Fire (called by the tab bar's center button) — no-op if slot empty ──────

export function fireShutter(): void {
  shutterHandler?.();
}

export function fireStop(): void {
  stopHandler?.();
}

// ─── Recording boolean (single writer: record.tsx phase-sync effect) ─────────

export function setRecording(value: boolean): void {
  if (isRecording === value) return;
  isRecording = value;
  listeners.forEach((l) => l());
}

// ─── useSyncExternalStore plumbing ───────────────────────────────────────────

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRecordingSnapshot(): boolean {
  return isRecording;
}
