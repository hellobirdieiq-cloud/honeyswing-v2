/**
 * swingStore.ts — STO: Swing Store Abstraction (v9 seq 57)
 *
 * Typed, read-only facade over public.swings. Consolidates supabase reads so
 * consumers don't re-implement Supabase JSON-path quirks. Read-only by
 * design: writes stay in persistSwing.ts, count queries stay in
 * swingLimit.ts, video URL updates stay in uploadSwingVideo.ts.
 *
 * Scope (v1): getSwingById + getGripHistory — one method per current
 * migration target. No opt-in accessors, no generic projection DSL, no
 * caching. Future Phase D consumers add narrow methods as they land.
 */

// Lazy require for ./supabase — that module transitively loads @clerk/expo
// which can't run under the plain tsx test runner. Matches lib/eventBus.ts:21.
declare function require(id: string): unknown;

// ---------------------------------------------------------------------------
// Record types — mirror the live public.swings default projection (R5).
// Columns excluded from v1: motion_frames, trail_points, angles, tempo,
// phases, feedback, analysis_tier, video_url. Add opt-in
// accessors only when a consumer needs them.
// ---------------------------------------------------------------------------

export type SwingRecord = {
  id: string;
  user_id: string;
  created_at: string;
  score: number | null;
  honey_boom: boolean;
  frame_count: number | null;
  duration_ms: number | null;
  pose_success_rate: number | null;
  capture_validity: string | null;
  phase_source: string | null;
  failure_reason: string | null;
  backswing_ms: number | null;
  downswing_ms: number | null;
  tempo_ratio: number | null;
  impact_frame_index: number | null;
  app_version: string | null;
  coach_name: string | null;
  analysis_version: string | null;
  video_storage_path: string | null;
  video_uploaded_at: string | null;
  swing_debug: Record<string, unknown> | null;
};

export type GripHistoryRecord = {
  id: string;
  created_at: string;
  grip_overall: string | null;
  grip_failed: string | null;
};

export type SwingHistoryRecord = {
  id: string;
  created_at: string;
  tempo_ratio: number | null;
};

// ---------------------------------------------------------------------------
// Adapter (overridable for tests) — mirrors lib/eventBus.ts:160-209
// ---------------------------------------------------------------------------

export type SwingStoreAdapter = {
  fetchSwingById(id: string): Promise<{
    data: SwingRecord | null;
    error: { message: string } | null;
  }>;
  fetchGripHistory(
    userId: string,
    sinceIso: string,
  ): Promise<{
    data: GripHistoryRecord[] | null;
    error: { message: string } | null;
  }>;
  fetchSwingHistory(
    userId: string,
    sinceIso: string,
  ): Promise<{
    data: SwingHistoryRecord[] | null;
    error: { message: string } | null;
  }>;
  getUserId(): Promise<string | null>;
};

const SWING_RECORD_COLUMNS =
  'id, user_id, created_at, score, honey_boom, frame_count, duration_ms, ' +
  'pose_success_rate, capture_validity, phase_source, failure_reason, ' +
  'backswing_ms, downswing_ms, tempo_ratio, impact_frame_index, app_version, ' +
  'coach_name, analysis_version, video_storage_path, video_uploaded_at, swing_debug';

const GRIP_HISTORY_COLUMNS =
  'id, created_at, ' +
  'grip_overall:swing_debug->grip_cloud->>overall, ' +
  'grip_failed:swing_debug->grip_cloud->>analysis_failed';

const SWING_HISTORY_COLUMNS = 'id, created_at, tempo_ratio';

type SupabaseError = { message: string };
type SupabaseResult<T> = { data: T; error: SupabaseError | null };

// Narrow hand-rolled chain interface — only the methods STO's two queries
// invoke. Matches the minimal-typing approach in lib/eventBus.ts:173-181.
type QueryChain = {
  select(cols: string): QueryChain;
  eq(col: string, val: string): QueryChain;
  gte(col: string, val: string): QueryChain;
  not(col: string, op: 'is', val: null): QueryChain;
  or(filters: string): QueryChain;
  order(col: string, opts: { ascending: boolean }): QueryChain;
  maybeSingle(): Promise<SupabaseResult<unknown>>;
  then<R>(
    onFulfilled: (value: SupabaseResult<unknown>) => R | PromiseLike<R>,
    onRejected?: (reason: unknown) => R | PromiseLike<R>,
  ): Promise<R>;
};

let adapter: SwingStoreAdapter | null = null;

function getAdapter(): SwingStoreAdapter {
  if (adapter) return adapter;
  try {
    const mod = require('./supabase') as {
      supabase: { from(table: string): QueryChain };
      getUserId(): Promise<string | null>;
    };
    adapter = {
      async fetchSwingById(id) {
        const { data, error } = await mod.supabase
          .from('swings')
          .select(SWING_RECORD_COLUMNS)
          .eq('id', id)
          .maybeSingle();
        return {
          data: (data as SwingRecord | null) ?? null,
          error: error ? { message: error.message } : null,
        };
      },
      async fetchGripHistory(userId, sinceIso) {
        // Business-logic scoping, not auth: RLS already enforces auth via
        // (auth.jwt() ->> 'sub') = user_id. The explicit .eq('user_id', ...)
        // here narrows results to the current user's OWN swings, excluding
        // rows the coaches_read_referral_swings RLS policy would otherwise
        // grant. Design §D9.R9.1.
        const { data, error } = await mod.supabase
          .from('swings')
          .select(GRIP_HISTORY_COLUMNS)
          .eq('user_id', userId)
          .gte('created_at', sinceIso)
          .not('swing_debug->grip_cloud', 'is', null)
          .not('swing_debug->grip_cloud->>overall', 'is', null)
          .or(
            'swing_debug->grip_cloud->>analysis_failed.is.null,' +
              'swing_debug->grip_cloud->>analysis_failed.neq.true',
          )
          .order('created_at', { ascending: false });
        return {
          data: (data as GripHistoryRecord[] | null) ?? null,
          error: error ? { message: error.message } : null,
        };
      },
      async fetchSwingHistory(userId, sinceIso) {
        const { data, error } = await mod.supabase
          .from('swings')
          .select(SWING_HISTORY_COLUMNS)
          .eq('user_id', userId)
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: false });
        return {
          data: (data as SwingHistoryRecord[] | null) ?? null,
          error: error ? { message: error.message } : null,
        };
      },
      async getUserId() {
        return mod.getUserId();
      },
    };
  } catch {
    // Test environment without ./supabase; return empty results gracefully.
    adapter = {
      async fetchSwingById() {
        return { data: null, error: { message: 'supabase unavailable' } };
      },
      async fetchGripHistory() {
        return { data: null, error: { message: 'supabase unavailable' } };
      },
      async fetchSwingHistory() {
        return { data: null, error: { message: 'supabase unavailable' } };
      },
      async getUserId() {
        return null;
      },
    };
  }
  return adapter;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Fetch a single swing by id. Returns null on not-found or on any DB error
 * (logged). Does not throw. RLS scopes the result to the caller's own swings
 * plus any referral swings the coaches_read_referral_swings policy grants.
 */
export async function getSwingById(id: string): Promise<SwingRecord | null> {
  const { data, error } = await getAdapter().fetchSwingById(id);
  if (error) {
    console.error('[HoneySwing] swingStore getSwingById error:', error.message);
    return null;
  }
  return data;
}

/**
 * Fetch the current user's grip-classified swings within a recency window
 * (defaults to 30 days). Returns [] on DB error (logged) or when no user is
 * authenticated. Does not throw.
 *
 * Enum-membership validation of grip_overall and MIN_ROWS empty-state gating
 * stay in the caller — SQL cannot express enum membership cleanly
 * (components/GripHistoryRow.tsx:74-76).
 */
export async function getGripHistory(
  opts?: { windowMs?: number },
): Promise<GripHistoryRecord[]> {
  const a = getAdapter();
  const userId = await a.getUserId();
  if (!userId) return [];
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  const { data, error } = await a.fetchGripHistory(userId, sinceIso);
  if (error) {
    // Message prefix preserved verbatim from components/GripHistoryRow.tsx:59
    // so observability dashboards keyed on the existing string keep working.
    console.error('[HoneySwing] grip history fetch error:', error.message);
    return [];
  }
  return data ?? [];
}

/**
 * Fetch the current user's swing history within a recency window (defaults to
 * 30 days), newest first. Returns [] when no user is authenticated or on DB
 * error (logged). Does not throw.
 */
export async function getSwingHistory(
  opts?: { windowMs?: number },
): Promise<SwingHistoryRecord[]> {
  const a = getAdapter();
  const userId = await a.getUserId();
  if (!userId) return [];
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  const { data, error } = await a.fetchSwingHistory(userId, sinceIso);
  if (error) {
    console.error('[HoneySwing] swing history fetch error:', error.message);
    return [];
  }
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export function __setAdapterForTesting(a: SwingStoreAdapter): void {
  adapter = a;
}

export function __resetForTesting(): void {
  adapter = null;
}
