/**
 * useWatchImuCapture.ts — pulls the paired Apple Watch's IMU stream for a swing.
 *
 * Mirrors useTiltCapture.ts (start/stop tied to recording, getReadings() on stop),
 * but the data path is capture-then-transfer: the watch buffers a swing and sends
 * one blob over WatchConnectivity; the native HoneyWatchImuModule holds the latest,
 * and getReadings() PULLS it at persist time (promise-pull, repo-native).
 *
 * Gating (toggle OFF = zero watch paths): when disabled, startCapture() no-ops and
 * getReadings() returns [] BEFORE any NativeModules reference — so WCSession is never
 * activated and persistSwing writes watch_imu = null, identical to today.
 *
 * Acceptance (R4): in auto-mode the blob echoes the arm signal's `seq`; getReadings
 * accepts a blob only if blob.seq === this capture's seq, so a backlogged prior-swing
 * transfer can never be reused. For a MANUAL watch capture (no arm signal → no seq) the
 * wall-clock staleness guard is the fallback: accept only if the blob arrived at/after
 * this recording's start (captureStartMs). (Clock alignment of the watch's own
 * boot-relative t vs pose timestamps is Phase 5.5/6 — not done here.)
 */

import { useCallback, useEffect, useRef } from 'react';
import { NativeModules } from 'react-native';
import { getWatchCaptureEnabled } from './watchCaptureSetting';
import type { WatchImuReading, WatchImuMeasured } from '../packages/domain/swing/watchImu';

type NativePayload = {
  readings: WatchImuReading[];
  n: number;
  hz: number;
  g: number;
  receivedAtMs: number;
  seq?: number;        // echoed arm-signal id (auto-mode); absent for manual captures
  armStartMs?: number; // echoed arm startMs (future clock alignment; unused this phase)
};

type WatchImuModule = {
  activate(): Promise<boolean>;
  getLatestWatchImu(): Promise<NativePayload | null>;
  startWatchAndArm(seq: number, startMs: number): Promise<boolean>;
  stopWatch(seq: number): Promise<boolean>;
};

export function useWatchImuCapture() {
  const enabledRef = useRef(false);
  const captureStartMsRef = useRef<number>(0);
  const summaryRef = useRef<WatchImuMeasured | null>(null);
  // Monotonic per-capture id. Seeded from the clock so values stay unique across a
  // screen remount (a counter reset to 0 could collide with a backlogged blob's seq).
  const seqRef = useRef<number>(Date.now());
  const currentSeqRef = useRef<number>(0); // the active capture's seq, for getReadings match

  // Resolve the toggle once on mount (and keep it current if the screen remounts).
  useEffect(() => {
    let cancelled = false;
    getWatchCaptureEnabled()
      .then((v) => { if (!cancelled) enabledRef.current = v; })
      .catch(() => { if (!cancelled) enabledRef.current = false; });
    return () => { cancelled = true; };
  }, []);

  const startCapture = useCallback(() => {
    // Anchor staleness + assign the capture seq SYNCHRONOUSLY first — independent of the
    // async toggle read below. captureStartMs/seq must reflect the true record-start
    // instant regardless of how the toggle read resolves; nothing here is awaited.
    summaryRef.current = null;
    const startMs = Date.now();
    captureStartMsRef.current = startMs;
    const seq = ++seqRef.current;
    currentSeqRef.current = seq;
    // Fix #1 (WATCH-TOGGLE-STALE-REF): re-read the toggle at the moment of use. The
    // mount-once read (useEffect above) goes stale when the user flips the toggle ON
    // mid-session, which previously required an app relaunch. Fire-and-forget: this is
    // never awaited, so nothing the caller reaches before cameraRef.startRecording can
    // block on it.
    getWatchCaptureEnabled()
      .then((enabled) => {
        enabledRef.current = enabled;
        if (!enabled) return; // disabled → never touch the native module
        const mod = NativeModules.HoneyWatchImuModule as WatchImuModule | undefined;
        // Auto-mode: launch the watch app into a workout + send the ARM signal. This
        // self-activates the phone WCSession (native activatedSession), so the blob
        // receive path is live without a separate activate() call. D5 + Fix #2: a launch/
        // signal failure degrades silently to no-IMU but is logged for diagnosis.
        mod?.startWatchAndArm?.(seq, startMs)?.catch((e) =>
          console.warn('[useWatchImuCapture] startWatchAndArm failed', e),
        );
      })
      .catch((e) => {
        enabledRef.current = false;
        console.warn('[useWatchImuCapture] toggle re-read failed', e);
      });
  }, []);

  const stopCapture = useCallback(() => {
    // Auto-mode: signal the watch to snapshot its ring buffer + send the blob.
    // Fire-and-forget (the caller does not await); gated on the now-resolved toggle.
    // seq lets the watch echo it back so getReadings matches this capture's blob. A
    // manual capture relies on the watch's own Stop button (this no-ops when disabled).
    if (!enabledRef.current) return;
    const seq = currentSeqRef.current;
    const mod = NativeModules.HoneyWatchImuModule as WatchImuModule | undefined;
    mod?.stopWatch?.(seq)?.catch((e) => console.warn('[useWatchImuCapture] stopWatch failed', e));
  }, []);

  /**
   * Pull the latest received blob. Returns [] when disabled, when nothing arrived,
   * or when the blob predates this recording (stale). Stashes the measured summary
   * for getSummary(). Async — the caller awaits it at persist time.
   */
  const getReadings = useCallback(async (): Promise<WatchImuReading[]> => {
    if (!enabledRef.current) return [];
    const mod = NativeModules.HoneyWatchImuModule as WatchImuModule | undefined;
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
    // R4 acceptance: prefer the echoed seq (auto-mode). A blob whose seq != this
    // capture's seq is a backlogged/prior transfer — drop it. Only when the blob carries
    // NO seq (manual watch capture) does the wall-clock staleness guard apply (constraint 5).
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
      return []; // stale prior swing
    }
    summaryRef.current = {
      sampleCount: payload.n ?? payload.readings.length,
      derivedHz: payload.hz ?? 0,
      maxAccelMagnitudeG: payload.g ?? 0,
    };
    // Fix #2 (WATCH-RECEIVE-OBSERVABILITY): the happy path previously logged nothing in
    // JS — the Swift success print (HoneyWatchImuModule.swift:81) goes to the device
    // console, not Metro. Surface the successful pull where the RN logs are visible.
    console.log(
      `[useWatchImuCapture] watch IMU received: n=${payload.readings.length} seq=${payload.seq ?? 'none'} receivedAtMs=${payload.receivedAtMs}`,
    );
    return payload.readings;
  }, []);

  /** Measured summary from the last successful getReadings() pull (or null). */
  const getSummary = useCallback((): WatchImuMeasured | null => summaryRef.current, []);

  const isEnabled = useCallback((): boolean => enabledRef.current, []);

  return { startCapture, stopCapture, getReadings, getSummary, isEnabled };
}
