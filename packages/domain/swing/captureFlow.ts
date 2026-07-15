/**
 * captureFlow.ts — pure decision helpers extracted VERBATIM from useSwingCapture.ts
 * so they can be unit-tested without a React-Native renderer. Type-only imports
 * (erased at runtime) keep this module graph-free for the tsx test harness.
 * No logic changes; useSwingCapture.ts calls these.
 */
import type { CaptureClassification } from './captureValidity';
import type { WatchImuReading, WatchImuMeasured, WatchImuAlignment } from './watchImu';
import type { WatchImuPersist } from './swingRowBuilders';

export type CapturePhase = 'idle' | 'countdown' | 'capturing' | 'processing' | 'complete' | 'error' | 'weak';

/**
 * What ended the recording: the 4s capture-window timer or a manual stop tap.
 * Persisted into swing_debug.stop_origin. A row with NEITHER value (null) means
 * the recording ended without finalizeCapture — e.g. native truncation when the
 * camera deactivated mid-recording (tab blur / backgrounding).
 */
export type StopOrigin = 'window_timer' | 'manual';

/**
 * True while the post-capture pipeline is still running from the user's point of
 * view: 'processing' (extraction + analysis) AND 'complete' (persist + navigation
 * dwell — tryNavigate awaits persistSwing before pushing the result screen).
 * Single definition shared by the record screen's brand overlay and the tab bar's
 * analyzing flag so the two indicators can't drift apart.
 */
export function isAnalyzingPhase(phase: CapturePhase): boolean {
  return phase === 'processing' || phase === 'complete';
}

export type NavigationBlockReason = 'phase' | 'analysis' | 'video' | 'navigated' | null;

/**
 * Reason navigation is blocked, or null when clear to navigate. Same precedence
 * as tryNavigate's inline gate: phase → analysis → video → navigated.
 */
export function computeNavigationBlockReason(state: {
  phase: CapturePhase;
  analysisReady: boolean;
  video: 'pending' | null | string;
  navigated: boolean;
}): NavigationBlockReason {
  return (
    state.phase !== 'complete' ? 'phase' :
    !state.analysisReady ? 'analysis' :
    state.video === 'pending' ? 'video' :
    state.navigated ? 'navigated' :
    null
  );
}

/**
 * Override the capture classification to a partial "no-swing" when phase detection
 * fell back; otherwise pass the base classification through unchanged.
 */
export function deriveClassification(
  base: CaptureClassification,
  fallbackGateReason: string | null,
): CaptureClassification {
  return fallbackGateReason
    ? {
        ...base,
        validity: 'partial' as const,
        reason: 'no-swing',
      }
    : base;
}

/**
 * A non-null fallback_gate in swing_debug means phase detection fell back — the
 * capture downgrades to a "no-swing" partial (feeds deriveClassification above).
 */
export function deriveFallbackGateReason(
  swingDebug: { fallback_gate?: unknown } | null | undefined,
): 'no-swing' | null {
  return swingDebug?.fallback_gate != null ? 'no-swing' : null;
}

/** Grip estimation reads the LEAD wrist: right for left-handed players, left otherwise. */
export function selectLeadWristForGrip<Joint>(
  joints: { leftWrist: Joint | undefined; rightWrist: Joint | undefined },
  isLeftHanded: boolean,
): Joint | undefined {
  return isLeftHanded ? joints.rightWrist : joints.leftWrist;
}

/**
 * Watch-IMU persist payload: present only when a summary was measured AND readings
 * arrived; otherwise null (persistSwing then writes no watch_imu block).
 */
export function buildWatchImuPersistPayload(
  readings: WatchImuReading[],
  summary: WatchImuMeasured | null,
  alignment: WatchImuAlignment | null,
  captureSeq: number | null,
): WatchImuPersist | null {
  return summary && readings.length > 0
    ? { readings, summary, alignment, captureSeq }
    : null;
}

/**
 * Drift-telemetry gate: fires only for a persisted swing with a clean extraction
 * and both native measurements present. Returns the validated (narrowed) inputs,
 * or null when any input disqualifies.
 */
export function planDriftEvent(args: {
  swingId: string | null;
  failure: string | null | undefined;
  frameCount: number | null | undefined;
  durationMs: number | null | undefined;
}): { swingId: string; frameCount: number; durationMs: number } | null {
  return args.swingId &&
    !args.failure &&
    typeof args.frameCount === 'number' &&
    typeof args.durationMs === 'number'
    ? { swingId: args.swingId, frameCount: args.frameCount, durationMs: args.durationMs }
    : null;
}

export type OutboxReconcilePlan =
  | { action: 'attach'; ids: string[]; swingId: string }
  | { action: 'hold'; ids: string[] }
  | { action: 'abandon'; ids: string[] }
  | { action: 'none'; ids: string[] };

/**
 * Outbox reconcile decision once persistSwing resolves: attach every captured
 * entry id to the swing row (attach fires even with zero ids — it also triggers
 * the drain), or abandon them when the insert returned no id (anonymous /
 * failed — those entries can never reconcile). The caller owns the
 * videoOutboxEntryIdRef read-and-null (mutual exclusion with the failure path)
 * and must read the ref AFTER awaiting the pose entry id, as before.
 *
 * Queue-until-login: `held` is true when persistSwing surfaced a built row for
 * a signed-out REAL swing (frames > 0) — those entries are held on disk for
 * retroactive persist at sign-in instead of abandoned. Hold fires even with
 * zero ids: the self-contained held row alone is worth keeping. The signed-in
 * branch (swingId truthy → attach) is checked FIRST and is unchanged.
 */
export function planOutboxReconcile(
  poseEntryId: string | null,
  videoEntryId: string | null,
  swingId: string | null,
  held = false,
): OutboxReconcilePlan {
  const ids = [poseEntryId, videoEntryId].filter(
    (x): x is string => typeof x === 'string',
  );
  if (swingId) return { action: 'attach', ids, swingId };
  if (held) return { action: 'hold', ids };
  if (ids.length > 0) return { action: 'abandon', ids };
  return { action: 'none', ids };
}

export interface WatchAutoStartEvaluation {
  fresh: boolean;
  shouldStart: boolean;
}

/**
 * Watch-initiated auto-start gate: only a fresh `started` signal, received while
 * pre-armed and idle, may start a recording. `fresh` is returned alongside the
 * decision so the caller's no-auto-start log reports it without recomputing the
 * threshold (freshnessMs is caller-supplied to keep this module graph-free).
 */
export function evaluateWatchAutoStart(args: {
  startedAgeMs: number;
  freshnessMs: number;
  preArmed: boolean;
  phase: CapturePhase;
}): WatchAutoStartEvaluation {
  const fresh = args.startedAgeMs <= args.freshnessMs;
  return { fresh, shouldStart: args.preArmed && fresh && args.phase === 'idle' };
}
