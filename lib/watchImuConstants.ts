/**
 * watchImuConstants.ts — JS-side timing constants for watch-primary capture.
 *
 * Watch-side timing (capture duration, ring buffer, hard cap, blob version) lives in
 * targets/watch/WatchImuConstants.swift; these are the phone-side gates only.
 */

/**
 * Max age of a `started` signal that may auto-start phone video. A `started` older than
 * this (a backlogged/late signal) is consumed for seq-adoption/alignment only — never
 * starts a recording.
 */
export const STARTED_FRESHNESS_MS = 2500;

/**
 * Late-join window: when an IMU batch drains, it may attach to a swing persisted within
 * this lookback. Generous vs. the seconds-scale transfer, but bounded so an old unmatched
 * batch becomes an IMU-only record rather than mis-attaching.
 */
export const IMU_BATCH_SEQ_LOOKBACK_MS = 120_000;

/**
 * A clock-sync offset older than this is not applied to alignment (syncConfidence drops to
 * 'low'). The handshake runs when the record screen enters the pre-armed "ready" state and
 * opportunistically on reachability, cached with an age stamp.
 */
export const CLOCK_SYNC_STALENESS_MS = 60_000;

/** Ping/pong rounds per handshake; the phone keeps the lowest-RTT round. */
export const CLOCK_SYNC_ROUNDS = 6;

/**
 * Duration a phone warm-path ARM requests (ms). The watch clamps to its own
 * maxCaptureDurationMs; a watch-initiated tap ignores this and uses its own default.
 */
export const DEFAULT_CAPTURE_DURATION_MS = 7000;
