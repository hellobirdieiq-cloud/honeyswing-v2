/**
 * eventBus.ts — EVB: Event Emission Framework (v9 seq 56)
 *
 * Typed event bus with in-memory pub/sub + AsyncStorage-backed offline queue
 * + async drain to Supabase `public.events`. Offline-first: emit() is
 * non-blocking; the queue drains opportunistically on drain() and on a 5-min
 * periodic timer.
 *
 * Session lifecycle: session.started auto-fires on lazy init. session.ended
 * currently fires only when emitted explicitly via endSession(); automatic
 * AppState-driven emission is deferred to a follow-up that wires from app
 * bootstrap code (see design §D8).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from './storageKeys';

// Lazy require for ./supabase — that module transitively loads @clerk/expo
// which can't run under the plain tsx test runner. Declaring require here
// so tsc accepts it under strict mode.
declare function require(id: string): unknown;

// ---------------------------------------------------------------------------
// D1 Event catalog — payload types
// ---------------------------------------------------------------------------

export type SwingRecordedPayload = {
  swingId: string;
  userId: string;
  score: number | null;
  honeyBoom: boolean;
  tempoRatio: number | null;
  confidenceTier: 'low' | 'medium' | 'high';
  cameraAngle: string;
  captureValidity: string | null;
  sessionSwingNumber: number;
  coachCode: string | null;
  isLeftHanded: boolean;
  ageTier: string | null;
  appVersion: string;
};

export type SessionStartedPayload = {
  sessionId: string;
  startedAt: string;
};

export type SessionEndedPayload = {
  sessionId: string;
  endedAt: string;
  swingCount: number;
  durationMs: number;
};

export type TipShownPayload = {
  swingId: string | null;
  metricKey: string;
  tier: 'full' | 'shortened' | 'suppressed';
  displayContext:
    | 'visual_coach'
    | 'positive_reinforcement'
    | 'session_insight'
    | 'record_overlay';
};

export type FeedbackShownPayload = {
  swingId: string;
  metricKey: string;
  tipId: string;
};

export type FeedbackConfirmedPayload = {
  swingId: string;
  metricKey: string;
  tipId: string;
  latencyMs: number;
};

export type FeedbackRejectedPayload = {
  swingId: string;
  metricKey: string;
  tipId: string;
  latencyMs: number;
};

export type AchievementUnlockedPayload = {
  achievementId: string;
  unlockedAt: string;
  context: Record<string, unknown>;
};

export type ErrorCapturedPayload = {
  scope: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
};

export type EventRecord =
  | { type: 'swing.recorded'; payload: SwingRecordedPayload }
  | { type: 'session.started'; payload: SessionStartedPayload }
  | { type: 'session.ended'; payload: SessionEndedPayload }
  | { type: 'tip.shown'; payload: TipShownPayload }
  | { type: 'feedback.shown'; payload: FeedbackShownPayload }
  | { type: 'feedback.confirmed'; payload: FeedbackConfirmedPayload }
  | { type: 'feedback.rejected'; payload: FeedbackRejectedPayload }
  | { type: 'achievement.unlocked'; payload: AchievementUnlockedPayload }
  | { type: 'error.captured'; payload: ErrorCapturedPayload };

export type EventType = EventRecord['type'];

export type PayloadFor<T extends EventType> = Extract<
  EventRecord,
  { type: T }
>['payload'];

export type Unsubscribe = () => void;

export type DrainResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  remaining: number;
};

// ---------------------------------------------------------------------------
// Internal envelope
// ---------------------------------------------------------------------------

type QueuedEvent = {
  id: string;
  type: EventType;
  payload: unknown;
  emittedAt: string;
  userId: string | null;
  sessionId: string | null;
  appVersion: string;
  attempts: number;
};

export type EventRow = {
  idempotency_key: string;
  user_id: string;
  type: string;
  payload: unknown;
  session_id: string | null;
  app_version: string;
  emitted_at: string;
};

// ---------------------------------------------------------------------------
// Adapters (overridable for tests)
// ---------------------------------------------------------------------------

export type StorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type SupabaseAdapter = {
  upsertEvents(rows: EventRow[]): Promise<{ error: { message: string } | null }>;
  getUserId(): Promise<string | null>;
};

let storage: StorageAdapter = AsyncStorage;

let supabaseAdapter: SupabaseAdapter | null = null;

function getSupabaseAdapter(): SupabaseAdapter {
  if (supabaseAdapter) return supabaseAdapter;
  try {
    const mod = require('./supabase') as {
      supabase: {
        from(table: string): {
          upsert(
            rows: EventRow[],
            options: { onConflict: string; ignoreDuplicates: boolean },
          ): Promise<{ error: { message: string } | null }>;
        };
      };
      getUserId(): Promise<string | null>;
    };
    supabaseAdapter = {
      async upsertEvents(rows) {
        const { error } = await mod.supabase
          .from('events')
          .upsert(rows, {
            onConflict: 'idempotency_key',
            ignoreDuplicates: true,
          });
        return { error: error ? { message: error.message } : null };
      },
      async getUserId() {
        return mod.getUserId();
      },
    };
  } catch {
    // Test environment without ./supabase; fail drain gracefully.
    supabaseAdapter = {
      async upsertEvents() {
        return { error: { message: 'supabase unavailable' } };
      },
      async getUserId() {
        return null;
      },
    };
  }
  return supabaseAdapter;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const APP_VERSION = '1.9.4';
const QUEUE_CAP = 500;
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;
const DRAIN_INTERVAL_MS = 5 * 60 * 1000;

type InternalHandler = (payload: unknown) => void;
type AnyHandler = (event: EventRecord) => void;

let queue: QueuedEvent[] = [];
let handlers: Map<EventType, Set<InternalHandler>> = new Map();
let anyHandlers: Set<AnyHandler> = new Set();

let isInitialized = false;
let initPromise: Promise<void> | null = null;

let isDraining = false;
let drainPromise: Promise<DrainResult> | null = null;

let sessionId: string | null = null;
let sessionStartMs = 0;
let sessionSwingCount = 0;

let drainTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomUUID(): string {
  // RFC 4122 v4. Math.random is not cryptographically strong but is
  // sufficient for client-side idempotency keys — collision probability
  // over realistic volumes is negligible.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function loadQueue(): Promise<void> {
  try {
    const raw = await storage.getItem(STORAGE_KEYS.eventQueue);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    const fromDisk = parsed as QueuedEvent[];
    const existingIds = new Set(queue.map((e) => e.id));
    const merged = [...fromDisk.filter((e) => !existingIds.has(e.id)), ...queue];
    queue = merged.slice(-QUEUE_CAP);
  } catch (err) {
    console.warn('[eventBus] loadQueue failed:', err);
  }
}

async function persistQueue(): Promise<void> {
  try {
    await storage.setItem(STORAGE_KEYS.eventQueue, JSON.stringify(queue));
  } catch (err) {
    console.warn('[eventBus] persistQueue failed:', err);
  }
}

function fanOut(record: EventRecord): void {
  const set = handlers.get(record.type);
  if (set) {
    for (const h of set) {
      try {
        h(record.payload);
      } catch (err) {
        console.warn(`[eventBus] handler threw for ${record.type}:`, err);
      }
    }
  }
  for (const h of anyHandlers) {
    try {
      h(record);
    } catch (err) {
      console.warn('[eventBus] onAny handler threw:', err);
    }
  }
}

async function enqueue(record: EventRecord): Promise<void> {
  const userId = await getSupabaseAdapter().getUserId();
  const envelope: QueuedEvent = {
    id: randomUUID(),
    type: record.type,
    payload: record.payload,
    emittedAt: new Date().toISOString(),
    userId,
    sessionId,
    appVersion: APP_VERSION,
    attempts: 0,
  };
  queue.push(envelope);
  if (queue.length > QUEUE_CAP) {
    const dropped = queue.length - QUEUE_CAP;
    queue = queue.slice(-QUEUE_CAP);
    console.warn(
      `[eventBus] queue cap ${QUEUE_CAP} reached; dropped ${dropped} oldest`,
    );
  }
  await persistQueue();
}

function startSession(): void {
  sessionId = randomUUID();
  sessionStartMs = Date.now();
  sessionSwingCount = 0;
  emitInternal({
    type: 'session.started',
    payload: {
      sessionId,
      startedAt: new Date(sessionStartMs).toISOString(),
    },
  });
}

function emitInternal(record: EventRecord): void {
  fanOut(record);
  enqueue(record).catch((err) =>
    console.warn('[eventBus] enqueue failed:', err),
  );
}

function initializeIfNeeded(): void {
  if (isInitialized) return;
  isInitialized = true;
  initPromise = (async () => {
    await loadQueue();
  })();
  // Session fires synchronously so test 16 (session.started auto-fires on
  // init) observes it immediately via onAny(). It's emitted via
  // emitInternal which fan-outs sync and enqueues async; any in-flight
  // loadQueue dedupes by event id when it completes.
  startSession();
  try {
    drainTimer = setInterval(() => {
      void drain().catch((err) =>
        console.warn('[eventBus] periodic drain failed:', err),
      );
    }, DRAIN_INTERVAL_MS);
  } catch {
    // Non-fatal: setInterval missing in exotic runtimes.
  }
}

// ---------------------------------------------------------------------------
// D2 Public API
// ---------------------------------------------------------------------------

export function emit<T extends EventType>(type: T, payload: PayloadFor<T>): void {
  initializeIfNeeded();
  if (type === 'swing.recorded') sessionSwingCount++;
  emitInternal({ type, payload } as EventRecord);
}

export function on<T extends EventType>(
  type: T,
  handler: (payload: PayloadFor<T>) => void,
): Unsubscribe {
  initializeIfNeeded();
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler as InternalHandler);
  return () => {
    handlers.get(type)?.delete(handler as InternalHandler);
  };
}

export function onAny(handler: (event: EventRecord) => void): Unsubscribe {
  initializeIfNeeded();
  anyHandlers.add(handler);
  return () => {
    anyHandlers.delete(handler);
  };
}

export async function drain(): Promise<DrainResult> {
  initializeIfNeeded();
  if (isDraining && drainPromise) return drainPromise;
  isDraining = true;
  drainPromise = (async () => {
    try {
      if (initPromise) {
        try {
          await initPromise;
        } catch {
          // loadQueue already logs; continue with in-memory state.
        }
      }
      const eligible = queue.filter((e) => e.attempts < MAX_ATTEMPTS && e.userId);
      const batch = eligible.slice(0, BATCH_SIZE);
      if (batch.length === 0) {
        return {
          attempted: 0,
          succeeded: 0,
          failed: 0,
          remaining: queue.length,
        };
      }
      const rows: EventRow[] = batch.map((e) => ({
        idempotency_key: e.id,
        user_id: e.userId!,
        type: e.type,
        payload: e.payload,
        session_id: e.sessionId,
        app_version: e.appVersion,
        emitted_at: e.emittedAt,
      }));
      const { error } = await getSupabaseAdapter().upsertEvents(rows);
      const batchIds = new Set(batch.map((e) => e.id));
      if (error) {
        queue = queue.map((e) =>
          batchIds.has(e.id) ? { ...e, attempts: e.attempts + 1 } : e,
        );
        await persistQueue();
        return {
          attempted: batch.length,
          succeeded: 0,
          failed: batch.length,
          remaining: queue.length,
        };
      }
      queue = queue.filter((e) => !batchIds.has(e.id));
      await persistQueue();
      return {
        attempted: batch.length,
        succeeded: batch.length,
        failed: 0,
        remaining: queue.length,
      };
    } finally {
      isDraining = false;
      drainPromise = null;
    }
  })();
  return drainPromise;
}

/**
 * Emit a session.ended event for the current session, if one is open.
 * Intended to be called by app bootstrap code that owns AppState (see §D8
 * — EVB does not import react-native, so the AppState listener must be
 * wired externally).
 */
export function endSession(): void {
  if (!sessionId) return;
  const now = Date.now();
  emitInternal({
    type: 'session.ended',
    payload: {
      sessionId,
      endedAt: new Date(now).toISOString(),
      swingCount: sessionSwingCount,
      durationMs: now - sessionStartMs,
    },
  });
  sessionId = null;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export function __resetForTesting(): void {
  queue = [];
  handlers = new Map();
  anyHandlers = new Set();
  isInitialized = false;
  initPromise = null;
  isDraining = false;
  drainPromise = null;
  sessionId = null;
  sessionStartMs = 0;
  sessionSwingCount = 0;
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
}

export function __setStorageForTesting(adapter: StorageAdapter): void {
  storage = adapter;
}

export function __setSupabaseForTesting(adapter: SupabaseAdapter): void {
  supabaseAdapter = adapter;
}

export function __whenReady(): Promise<void> {
  return initPromise ?? Promise.resolve();
}

export function __getQueueForTesting(): ReadonlyArray<Readonly<QueuedEvent>> {
  return queue;
}
