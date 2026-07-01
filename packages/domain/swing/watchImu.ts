/**
 * Wrist IMU types — the watch capture-then-transfer stream and its summary.
 * Pure domain types (no UI/native deps) so analysisPipeline and persistSwing can
 * both import them. Field set mirrors the watch ImuSample: {t,ax,ay,az,gx,gy,gz}.
 */

export interface WatchImuReading {
  /** Watch boot-relative ms (CMDeviceMotion.timestamp * 1000). NOT pose-clock aligned. */
  t: number;
  ax: number; ay: number; az: number; // userAcceleration (G, gravity removed)
  gx: number; gy: number; gz: number; // rotationRate (rad/s)
}

/** Measured fields the watch computes; the capture hook surfaces these verbatim. */
export interface WatchImuMeasured {
  sampleCount: number;
  derivedHz: number;
  maxAccelMagnitudeG: number;
}

/** Persisted summary block — measured fields plus the stamped assumption + clock note. */
export interface WatchImuSummary extends WatchImuMeasured {
  wornWrist: 'lead';
  /** Documents the clock basis so a later consumer doesn't mis-align the streams. */
  clockNote: string;
}

/**
 * EXTERNAL_ASSUMPTION — no wrist detection this phase (Phase 5). The watch is
 * assumed worn on the lead wrist; Phase 5.5 calibration revisits this.
 */
export const WORN_WRIST = 'lead' as const;

/** Carried into swing_debug.watch_imu so a later session knows the alignment basis. */
export const WATCH_IMU_CLOCK_NOTE =
  'watch t is absolute watch-mono ms (CMDeviceMotion.timestamp domain); aligned to video time via clock-sync offset + phoneMonoAtVideoStart (see alignment block, syncConfidence). Impact-spike correction is Phase B.';

// Alignment math lives in clockAlign.ts (pure, unit-tested). Re-exported here so the swing
// domain has a single watch-IMU entry point.
export {
  alignWatchImuToVideo,
  watchMonoToVideoMs,
  syncConfidenceFor,
  isOffsetUsable,
} from './clockAlign';
export type {
  SyncConfidence,
  ClockSyncResult,
  VideoAnchor,
  AlignParams,
  AlignedWatchImuReading,
  WatchImuAlignment,
  AlignResult,
} from './clockAlign';
