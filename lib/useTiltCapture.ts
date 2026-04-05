/**
 * useTiltCapture.ts — Captures phone tilt via accelerometer during recording
 *
 * Collects accelerometer readings at ~30 Hz while the camera is recording.
 * Readings are averaged by computePhoneTilt() in tiltCorrection.ts to
 * determine how much the phone was tilted forward/backward.
 *
 * Usage in record.tsx:
 *
 *   import { useTiltCapture } from '../lib/useTiltCapture';
 *
 *   const { startCapture, stopCapture, getReadings } = useTiltCapture();
 *
 *   // When recording starts:
 *   startCapture();
 *
 *   // When recording ends:
 *   stopCapture();
 *   const gravityReadings = getReadings();
 *   // → pass gravityReadings to analysisPipeline via applyTiltCorrection()
 *
 * Notes:
 *   - expo-sensors Accelerometer returns values as multiples of G (not m/s²).
 *     computePhoneTilt handles both scales (it uses atan2 ratios).
 *   - Readings are capped at MAX_READINGS (500 ≈ 16 seconds at 30Hz) to
 *     prevent unbounded memory growth on long recordings.
 *   - Subscription is cleaned up on unmount to prevent zombie listeners.
 *   - If Accelerometer is unavailable (simulator, old device), getReadings()
 *     returns empty → tilt correction gracefully no-ops.
 *   - Accelerometer does NOT require user permission on iOS/Android.
 *     No permission prompt will appear. If expo-sensors is installed,
 *     it works automatically on real hardware.
 *
 * Sign convention (CRITICAL — verify on first device test):
 *   Expected for portrait-vertical phone, screen facing user:
 *     { x: ~0, y: ~-1, z: ~0 }
 *   When tilted forward 15° (top away):
 *     z should be POSITIVE, y should be less negative.
 *
 *   If z is NEGATIVE when tilted forward, set SIGN_NEGATE_Z = true below.
 *   This is the single point of truth for sign convention. The pure-function
 *   tests and correction math are unaffected — only the sensor-to-math
 *   mapping changes.
 *
 * @module useTiltCapture
 */

import { useRef, useCallback, useEffect, useState } from 'react';
import { Accelerometer } from 'expo-sensors';
import type { EventSubscription as Subscription } from 'expo-modules-core';
import type { GravityReading } from '../packages/domain/swing/tiltCorrection';

// ─── Configuration ───────────────────────────────────────────────────────────

/** Accelerometer sample interval (ms). 33ms ≈ 30Hz. */
const SAMPLE_INTERVAL_MS = 33;

/**
 * Maximum readings to keep. 500 at 30Hz = ~16 seconds.
 * Golf swing recordings are 2-5 seconds — 3× headroom.
 */
const MAX_READINGS = 500;

/**
 * Sign convention flips. Set to true if device test shows inverted axis.
 * These are the SINGLE POINT OF TRUTH for sign convention correction.
 * After running the sign verification protocol (see INTEGRATION.md Step 0),
 * flip the relevant constant and re-test.
 *
 * Default: all false (matches expected iOS convention).
 */
const SIGN_NEGATE_X = false;
const SIGN_NEGATE_Y = false;
const SIGN_NEGATE_Z = false;

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useTiltCapture() {
  const readingsRef = useRef<GravityReading[]>([]);
  const subscriptionRef = useRef<Subscription | null>(null);
  const isCapturingRef = useRef(false);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);

  // Check accelerometer availability on mount
  useEffect(() => {
    let cancelled = false;
    Accelerometer.isAvailableAsync()
      .then((available) => {
        if (!cancelled) setIsAvailable(available);
      })
      .catch(() => {
        if (!cancelled) setIsAvailable(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Cleanup on unmount — prevents zombie subscription if component
  // unmounts while capture is active (e.g., navigation away mid-recording)
  useEffect(() => {
    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current.remove();
        subscriptionRef.current = null;
      }
      isCapturingRef.current = false;
    };
  }, []);

  const startCapture = useCallback(() => {
    // Guard: don't double-subscribe
    if (isCapturingRef.current) return;

    // Guard: skip if explicitly unavailable.
    // When isAvailable === null (still checking), we ALLOW the attempt.
    // On unsupported hardware the listener simply won't fire, and
    // getReadings() returns [] → tilt correction gracefully no-ops.
    // This avoids a timing race where startCapture is called before
    // the async isAvailableAsync() resolves.
    if (isAvailable === false) return;

    readingsRef.current = [];
    isCapturingRef.current = true;

    Accelerometer.setUpdateInterval(SAMPLE_INTERVAL_MS);

    try {
      subscriptionRef.current = Accelerometer.addListener((data) => {
        if (readingsRef.current.length < MAX_READINGS) {
          readingsRef.current.push({
            x: SIGN_NEGATE_X ? -data.x : data.x,
            y: SIGN_NEGATE_Y ? -data.y : data.y,
            z: SIGN_NEGATE_Z ? -data.z : data.z,
          });
        }
        // Beyond MAX_READINGS: silently drop. First ~16 seconds is enough.
      });
    } catch (error) {
      // Accelerometer unavailable at runtime (permissions, hardware).
      // Degrade gracefully: getReadings() returns [] → no tilt correction.
      console.warn('[useTiltCapture] Failed to start accelerometer:', error);
      isCapturingRef.current = false;
    }
  }, [isAvailable]);

  const stopCapture = useCallback(() => {
    if (subscriptionRef.current) {
      subscriptionRef.current.remove();
      subscriptionRef.current = null;
    }
    isCapturingRef.current = false;
  }, []);

  /** Returns a copy of collected readings. Safe to call after stopCapture(). */
  const getReadings = useCallback((): GravityReading[] => {
    return [...readingsRef.current];
  }, []);

  /**
   * Quick check: how many readings were collected? Useful for debugging
   * without copying the entire array. If 0 after a recording, the hook
   * isn't wired correctly or the accelerometer is unavailable.
   */
  const getSampleCount = useCallback((): number => {
    return readingsRef.current.length;
  }, []);

  return {
    startCapture,
    stopCapture,
    getReadings,
    getSampleCount,
    /** null = still checking, true = available, false = unavailable */
    isAvailable,
  };
}
