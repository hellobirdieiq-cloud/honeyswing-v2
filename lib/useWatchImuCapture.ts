/**
 * useWatchImuCapture.ts — paired Apple Watch IMU for a swing (watch-primary).
 *
 * The watch is the primary initiator: the user taps Start on the watch, it captures locally,
 * and pushes `onWatchStarted` to the phone (RCTEventEmitter). When the record screen is
 * pre-armed AND the signal is fresh, the phone auto-starts video adopting the watch's seq.
 * The phone warm path (armWatch) is a reachable-only convenience.
 *
 * Data path stays capture-then-transfer: the watch sends one binary blob over
 * WatchConnectivity; native holds the latest; getReadings() PULLS it at persist time (the
 * up-to-45s extraction gives the 6–8s capture ample time to land). A batch that drains AFTER
 * the swing persists is handled by the onWatchBatch late-join drain (seq→swing attach, or an
 * IMU-only record). Alignment to video time uses the cached clock-sync offset +
 * phoneMonoAtVideoStart (see clockAlign.ts).
 *
 * Gating (toggle OFF = zero watch paths): when disabled, every method no-ops before touching
 * the native module, so WCSession is never activated and persistSwing writes watch_imu = null.
 */

import { useCallback, useEffect, useRef } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
import { getWatchCaptureEnabled } from './watchCaptureSetting';
import {
  CLOCK_SYNC_ROUNDS,
  CLOCK_SYNC_STALENESS_MS,
  DEFAULT_CAPTURE_DURATION_MS,
  IMU_BATCH_SEQ_LOOKBACK_MS,
} from './watchImuConstants';
import {
  attachWatchImuToSwing,
  findSwingIdByCaptureSeq,
  persistImuOnlyRecord,
  type WatchImuPersist,
} from './persistSwing';
import {
  alignWatchImuToVideo,
  type WatchImuReading,
  type WatchImuMeasured,
  type ClockSyncResult,
  type WatchImuAlignment,
} from '../packages/domain/swing/watchImu';

type NativePayload = {
  readings: WatchImuReading[];
  n: number;
  hz: number;
  g: number;
  receivedAtMs: number;
  receivedMonoMs?: number;
  watchStartMs?: number;
  watchEndMs?: number;
  durationMs?: number;
  seq?: number; // echoed capture id; absent for legacy/manual captures
  armStartMs?: number;
  mode?: string;
};

/** onWatchStarted event body + the phone-computed freshness age. */
export type WatchStartedEvent = {
  seq: number;
  watchStartMs: number;
  durationMs: number;
  mode: string | null;
  receivedMonoMs: number;
  /** Age of the started signal at handling time (ms); ≤ STARTED_FRESHNESS_MS ⇒ may auto-start. */
  startedAgeMs: number;
};

type WatchImuModule = {
  activate(): Promise<boolean>;
  getLatestWatchImu(): Promise<NativePayload | null>;
  monotonicNowMs(): Promise<number>;
  armWatch(seq: number, startMs: number, durationMs: number, mode: string | null): Promise<boolean>;
  stopWatch(seq: number): Promise<boolean>;
  launchWatchApp(): Promise<boolean>;
  clockSyncPing(rounds: number): Promise<ClockSyncResult | null>;
};

export type VideoAlignAnchor = {
  videoDurationMs: number;
  recordIntentAtMs: number | null;
  captureOrigin: 'watch' | 'phone';
};

// Module-level state survives a screen remount (a backgrounded capture's batch may land later).
let clockSyncCache: ClockSyncResult | null = null;
const seqToSwingId = new Map<number, string>();

function rememberSwingId(seq: number, swingId: string): void {
  seqToSwingId.set(seq, swingId);
  // Soft cap — a session won't legitimately exceed this; drop the oldest if it does.
  if (seqToSwingId.size > 100) {
    const first = seqToSwingId.keys().next().value;
    if (first !== undefined) seqToSwingId.delete(first);
  }
}

function getModule(): WatchImuModule | undefined {
  return NativeModules.HoneyWatchImuModule as WatchImuModule | undefined;
}

export function useWatchImuCapture() {
  const enabledRef = useRef(false);
  const captureStartMsRef = useRef<number>(0);
  const summaryRef = useRef<WatchImuMeasured | null>(null);
  // Monotonic per-capture id (phone warm path). Seeded from the clock so values stay unique
  // across a screen remount.
  const seqRef = useRef<number>(Date.now());
  const currentSeqRef = useRef<number>(0); // active capture's seq, for getReadings match
  // The seq currently in flight (capture started, not yet persisted). Guards the late-join
  // drain from firing for a batch the persist pull will consume.
  const inFlightSeqRef = useRef<number | null>(null);
  const latestWatchStartMsRef = useRef<number | null>(null);
  const phoneMonoAtVideoStartRef = useRef<number | null>(null);
  // Consumer (useSwingCapture) handler for watch-initiated starts.
  const startedHandlerRef = useRef<((e: WatchStartedEvent) => boolean | void) | null>(null);

  // Resolve the toggle once on mount (and keep it current if the screen remounts).
  useEffect(() => {
    let cancelled = false;
    getWatchCaptureEnabled()
      .then((v) => { if (!cancelled) enabledRef.current = v; })
      .catch(() => { if (!cancelled) enabledRef.current = false; });
    return () => { cancelled = true; };
  }, []);

  // Subscribe to native events (onWatchStarted, onWatchBatch). Activating WCSession happens
  // in prearm()/armWatch(); listening here is harmless when the toggle is off (no signals fire).
  useEffect(() => {
    const mod = getModule();
    if (!mod) return;
    const emitter = new NativeEventEmitter(NativeModules.HoneyWatchImuModule);

    const startedSub = emitter.addListener('onWatchStarted', (p: NativePayload & { mode?: string | null }) => {
      void handleWatchStarted(p);
    });
    const batchSub = emitter.addListener('onWatchBatch', (p: { seq?: number }) => {
      void handleWatchBatch(p);
    });

    return () => {
      startedSub.remove();
      batchSub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Started: adopt seq + compute freshness, then hand to the consumer ───────────
  const handleWatchStarted = useCallback(async (p: NativePayload & { mode?: string | null }) => {
    if (!enabledRef.current) return;
    const seq = typeof p.seq === 'number' ? p.seq : 0;
    const watchStartMs = typeof p.watchStartMs === 'number' ? p.watchStartMs : 0;
    // Adopt the watch's seq for alignment / late-join mapping. inFlightSeqRef is
    // NOT set here: a watch `started` the consumer refuses (stale / not pre-armed)
    // must not gate the late-join drain (handleWatchBatch), or its IMU batch would
    // be silently dropped. It's adopted below only if the consumer auto-starts.
    currentSeqRef.current = seq;
    latestWatchStartMsRef.current = watchStartMs;
    captureStartMsRef.current = Date.now();

    let startedAgeMs = Number.POSITIVE_INFINITY;
    try {
      const nowMono = await (getModule()?.monotonicNowMs() ?? Promise.resolve(0));
      if (clockSyncCache) {
        startedAgeMs = nowMono - (watchStartMs + clockSyncCache.clockOffsetMs);
      } else if (typeof p.receivedMonoMs === 'number') {
        startedAgeMs = nowMono - p.receivedMonoMs;
      }
    } catch {
      // leave startedAgeMs = Infinity → no auto-start, seq still adopted for alignment/late-join
    }

    const accepted = startedHandlerRef.current?.({
      seq,
      watchStartMs,
      durationMs: typeof p.durationMs === 'number' ? p.durationMs : DEFAULT_CAPTURE_DURATION_MS,
      mode: typeof p.mode === 'string' ? p.mode : null,
      receivedMonoMs: typeof p.receivedMonoMs === 'number' ? p.receivedMonoMs : 0,
      startedAgeMs,
    });
    // Adopt in-flight ONLY when the consumer actually auto-started a recording.
    if (accepted) inFlightSeqRef.current = seq;
  }, []);

  // ── Batch: late-join drain (only for batches NOT consumed by an in-flight persist) ──
  const handleWatchBatch = useCallback(async (p: { seq?: number }) => {
    if (!enabledRef.current) return;
    const seq = typeof p.seq === 'number' ? p.seq : null;
    // In-flight capture → the persist-time pull will consume this batch; do nothing.
    if (seq != null && seq === inFlightSeqRef.current) return;
    try {
      await drainLateBatch(seq);
    } catch (e) {
      console.warn('[useWatchImuCapture] late-join drain failed', e);
    }
  }, []);

  const prearm = useCallback(async () => {
    try {
      enabledRef.current = await getWatchCaptureEnabled();
    } catch {
      enabledRef.current = false;
    }
    if (!enabledRef.current) return;
    const mod = getModule();
    if (!mod) return;
    try { await mod.activate?.(); } catch (e) { console.warn('[useWatchImuCapture] activate failed', e); }
    try {
      const res = await mod.clockSyncPing?.(CLOCK_SYNC_ROUNDS);
      if (res) {
        clockSyncCache = res;
        console.log('[useWatchImuCapture] clock sync', res);
      }
    } catch (e) {
      console.warn('[useWatchImuCapture] clock sync failed', e);
    }
  }, []);

  // Warm path (phone-initiated). Reachable-only ARM; on unreachable/failure the promise
  // rejects so the caller can surface "start from the watch". Fire-and-forget for the legacy
  // Instant/Countdown buttons (IMU simply absent when the watch is unreachable).
  const startCapture = useCallback((): Promise<boolean> => {
    summaryRef.current = null;
    const startMs = Date.now();
    captureStartMsRef.current = startMs;
    const seq = ++seqRef.current;
    currentSeqRef.current = seq;
    inFlightSeqRef.current = seq;
    return getWatchCaptureEnabled()
      .then((enabled) => {
        enabledRef.current = enabled;
        if (!enabled) return false;
        const mod = getModule();
        if (!mod?.armWatch) return false;
        return mod.armWatch(seq, startMs, DEFAULT_CAPTURE_DURATION_MS, 'phone');
      })
      .catch((e) => {
        console.warn('[useWatchImuCapture] armWatch failed', e);
        throw e;
      });
  }, []);

  const stopCapture = useCallback(() => {
    // Advisory only — the watch stops on its own duration timer. No-op when disabled.
    if (!enabledRef.current) return;
    const seq = currentSeqRef.current;
    const mod = getModule();
    mod?.stopWatch?.(seq)?.catch((e) => console.warn('[useWatchImuCapture] stopWatch failed', e));
  }, []);

  // Capture the monotonic video-start anchor (same clock domain as the sync offset) at the
  // startRecording call. Fire-and-forget; read at persist time via getAlignment.
  const stampVideoAnchor = useCallback(async () => {
    const mod = getModule();
    try {
      phoneMonoAtVideoStartRef.current = (await mod?.monotonicNowMs?.()) ?? null;
    } catch {
      phoneMonoAtVideoStartRef.current = null;
    }
  }, []);

  /**
   * Pull the latest received blob. Returns [] when disabled, nothing arrived, or the blob is
   * stale / seq-mismatched. Stashes the measured summary + watchStartMs for getAlignment().
   */
  const getReadings = useCallback(async (): Promise<WatchImuReading[]> => {
    if (!enabledRef.current) return [];
    const mod = getModule();
    if (!mod?.getLatestWatchImu) return [];
    let payload: NativePayload | null = null;
    try {
      payload = await mod.getLatestWatchImu();
    } catch (e) {
      console.warn('[useWatchImuCapture] getLatestWatchImu failed', e);
      return [];
    }
    if (!payload || !Array.isArray(payload.readings) || payload.readings.length === 0) {
      console.warn('[useWatchImuCapture] enabled but no watch IMU payload received');
      return [];
    }
    // R4 acceptance: prefer the echoed seq. A blob whose seq != this capture's seq is a
    // backlogged/prior transfer — drop it. Only a no-seq blob falls back to the wall-clock guard.
    if (typeof payload.seq === 'number') {
      if (payload.seq !== currentSeqRef.current) {
        console.warn(
          `[useWatchImuCapture] seq mismatch dropped: blob.seq=${payload.seq} current=${currentSeqRef.current}`,
        );
        return [];
      }
    } else if (payload.receivedAtMs < captureStartMsRef.current) {
      console.warn(
        `[useWatchImuCapture] stale watch IMU dropped (no-seq fallback): receivedAtMs=${payload.receivedAtMs} < captureStartMs=${captureStartMsRef.current}`,
      );
      return [];
    }
    summaryRef.current = {
      sampleCount: payload.n ?? payload.readings.length,
      derivedHz: payload.hz ?? 0,
      maxAccelMagnitudeG: payload.g ?? 0,
    };
    latestWatchStartMsRef.current =
      typeof payload.watchStartMs === 'number' ? payload.watchStartMs : latestWatchStartMsRef.current;
    console.log(
      `[useWatchImuCapture] watch IMU received: n=${payload.readings.length} seq=${payload.seq ?? 'none'} receivedAtMs=${payload.receivedAtMs}`,
    );
    return payload.readings;
  }, []);

  /** Measured summary from the last successful getReadings() pull (or null). */
  const getSummary = useCallback((): WatchImuMeasured | null => summaryRef.current, []);

  /**
   * Build the alignment block for persist: cached clock-sync offset + phoneMonoAtVideoStart +
   * the blob's watchStartMs. Confidence is 'medium' only when the offset is fresh AND a
   * monotonic video anchor exists; else 'low'/'none' (readings still persisted, raw).
   */
  const getAlignment = useCallback(
    async (readings: WatchImuReading[], anchor: VideoAlignAnchor): Promise<WatchImuAlignment | null> => {
      if (!enabledRef.current || readings.length === 0) return null;
      let offsetAgeMs: number | null = null;
      if (clockSyncCache) {
        try {
          const nowMono = (await getModule()?.monotonicNowMs?.()) ?? null;
          if (nowMono != null) offsetAgeMs = nowMono - clockSyncCache.handshakeAtMs;
        } catch {
          offsetAgeMs = null;
        }
      }
      return alignWatchImuToVideo(readings, {
        sync: clockSyncCache,
        offsetAgeMs,
        stalenessMs: CLOCK_SYNC_STALENESS_MS,
        anchor: {
          phoneMonoAtVideoStart: phoneMonoAtVideoStartRef.current,
          recordIntentAtMs: anchor.recordIntentAtMs,
          videoDurationMs: anchor.videoDurationMs,
        },
        watchStartMs: latestWatchStartMsRef.current,
        captureOrigin: anchor.captureOrigin,
      }).alignment;
    },
    [],
  );

  const getCurrentSeq = useCallback((): number => currentSeqRef.current, []);

  /** Record seq→swingId for late-join, and clear in-flight (persist for this seq is done). */
  const registerSwingId = useCallback((seq: number, swingId: string | null) => {
    if (typeof seq === 'number' && swingId) rememberSwingId(seq, swingId);
    if (inFlightSeqRef.current === seq) inFlightSeqRef.current = null;
  }, []);

  /**
   * Clear the in-flight seq on a capture that failed before persist (no-person,
   * zero-frames, extract threw) — the persist path's registerSwingId never runs
   * for those, so without this the late-join drain (handleWatchBatch) keeps
   * skipping this seq's batch forever. Safe: captures are serialized, so this
   * only ever clears the current, now-failed capture.
   */
  const clearInFlight = useCallback(() => {
    inFlightSeqRef.current = null;
  }, []);

  /** Set the consumer for watch-initiated starts; returns an unsubscribe. */
  const registerStartedHandler = useCallback((cb: (e: WatchStartedEvent) => boolean | void) => {
    startedHandlerRef.current = cb;
    return () => {
      if (startedHandlerRef.current === cb) startedHandlerRef.current = null;
    };
  }, []);

  const isEnabled = useCallback((): boolean => enabledRef.current, []);

  return {
    prearm,
    startCapture,
    stopCapture,
    stampVideoAnchor,
    getReadings,
    getSummary,
    getAlignment,
    getCurrentSeq,
    registerSwingId,
    clearInFlight,
    registerStartedHandler,
    isEnabled,
  };
}

// ── Late-join drain (module scope; safe to call without an active hook instance) ───
async function drainLateBatch(seqHint: number | null): Promise<void> {
  const mod = getModule();
  if (!mod?.getLatestWatchImu) return;
  const payload = await mod.getLatestWatchImu();
  if (!payload || !Array.isArray(payload.readings) || payload.readings.length === 0) return;
  const captureSeq = typeof payload.seq === 'number' ? payload.seq : seqHint;
  if (captureSeq == null) return; // can't seq-match a no-seq orphan

  const readings = payload.readings;
  const summary: WatchImuMeasured = {
    sampleCount: payload.n ?? readings.length,
    derivedHz: payload.hz ?? 0,
    maxAccelMagnitudeG: payload.g ?? 0,
  };
  // Orphan/late batch has no video → no monotonic anchor → confidence low/none.
  let offsetAgeMs: number | null = null;
  if (clockSyncCache) {
    try {
      const nowMono = await mod.monotonicNowMs();
      offsetAgeMs = nowMono - clockSyncCache.handshakeAtMs;
    } catch {
      offsetAgeMs = null;
    }
  }
  const alignment = alignWatchImuToVideo(readings, {
    sync: clockSyncCache,
    offsetAgeMs,
    stalenessMs: CLOCK_SYNC_STALENESS_MS,
    anchor: { phoneMonoAtVideoStart: null, recordIntentAtMs: null, videoDurationMs: 0 },
    watchStartMs: typeof payload.watchStartMs === 'number' ? payload.watchStartMs : null,
    captureOrigin: 'watch',
  }).alignment;

  const persist: WatchImuPersist = { readings, summary, alignment, captureSeq };

  let swingId = seqToSwingId.get(captureSeq) ?? null;
  if (!swingId) {
    swingId = await findSwingIdByCaptureSeq(captureSeq, IMU_BATCH_SEQ_LOOKBACK_MS);
  }
  if (swingId) {
    await attachWatchImuToSwing(swingId, persist);
  } else {
    const newId = await persistImuOnlyRecord(persist);
    console.log('[useWatchImuCapture] late batch persisted as IMU-only', { seq: captureSeq, swingId: newId });
  }
}
