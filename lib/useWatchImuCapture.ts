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
 * Staleness guard: the native payload carries receivedAtMs (phone wall clock). A blob
 * is accepted only if it arrived at/after this recording's start (captureStartMs),
 * so a previous swing's transfer is never reused. (Clock alignment of the watch's own
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
};

type WatchImuModule = {
  activate(): Promise<boolean>;
  getLatestWatchImu(): Promise<NativePayload | null>;
};

export function useWatchImuCapture() {
  const enabledRef = useRef(false);
  const captureStartMsRef = useRef<number>(0);
  const summaryRef = useRef<WatchImuMeasured | null>(null);

  // Resolve the toggle once on mount (and keep it current if the screen remounts).
  useEffect(() => {
    let cancelled = false;
    getWatchCaptureEnabled()
      .then((v) => { if (!cancelled) enabledRef.current = v; })
      .catch(() => { if (!cancelled) enabledRef.current = false; });
    return () => { cancelled = true; };
  }, []);

  const startCapture = useCallback(() => {
    if (!enabledRef.current) return; // disabled → never touch the native module
    summaryRef.current = null;
    captureStartMsRef.current = Date.now();
    const mod = NativeModules.HoneyWatchImuModule as WatchImuModule | undefined;
    mod?.activate?.().catch((e) => console.warn('[useWatchImuCapture] activate failed', e));
  }, []);

  const stopCapture = useCallback(() => {
    // The watch drives its own capture/stop; nothing to stop on the phone. Kept for
    // symmetry with useTiltCapture so the wiring in useSwingCapture reads the same.
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
    if (!payload || !Array.isArray(payload.readings) || payload.readings.length === 0) return [];
    if (payload.receivedAtMs < captureStartMsRef.current) return []; // stale prior swing
    summaryRef.current = {
      sampleCount: payload.n ?? payload.readings.length,
      derivedHz: payload.hz ?? 0,
      maxAccelMagnitudeG: payload.g ?? 0,
    };
    return payload.readings;
  }, []);

  /** Measured summary from the last successful getReadings() pull (or null). */
  const getSummary = useCallback((): WatchImuMeasured | null => summaryRef.current, []);

  const isEnabled = useCallback((): boolean => enabledRef.current, []);

  return { startCapture, stopCapture, getReadings, getSummary, isEnabled };
}
