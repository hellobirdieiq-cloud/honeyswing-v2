/**
 * clockAlign.ts — pure clock-sync + alignment math (no UI/native deps).
 *
 * The watch stamps IMU samples in CMDeviceMotion.timestamp's domain (boot-relative,
 * mach-monotonic ms). The phone clock-sync handshake yields a single offset mapping that
 * domain to the phone's own monotonic clock (ProcessInfo.systemUptime ms). The phone also
 * stamps phoneMonoAtVideoStart (same monotonic clock) at the startRecording call. Aligning
 * a watch sample to video time is therefore:
 *
 *     sample_phoneMono = sample_watchMono − clockOffsetMs
 *     sample_videoMs   = sample_phoneMono − phoneMonoAtVideoStart
 *
 * Both subtractions are in the monotonic domain, so they compose. Alignment is approximate
 * (the unmeasured startRecording latency floors confidence at 'medium'); precise impact-spike
 * anchoring is Phase B. When no fresh handshake or no monotonic video anchor exists, no offset
 * is applied — the readings are still persisted raw, with confidence 'low'/'none'.
 */

import type { WatchImuReading } from './watchImu';

export type SyncConfidence = 'none' | 'low' | 'medium';

/** Result of the native clock-sync handshake (lowest-RTT round). */
export interface ClockSyncResult {
  /** watchMono − phoneMonoMid (ms). Add to a phoneMono to get watchMono; subtract to invert. */
  clockOffsetMs: number;
  roundTripMs: number;
  /** Phone-monotonic ms at handshake completion (for offsetAge at align time). */
  handshakeAtMs: number;
}

/** Where video-t=0 sits on the phone clocks. */
export interface VideoAnchor {
  /** Phone-monotonic ms at startRecording — the preferred, offset-compatible anchor. */
  phoneMonoAtVideoStart: number | null;
  /** Wall-clock Date.now at record intent — coarse fallback, NOT offset-compatible. */
  recordIntentAtMs: number | null;
  videoDurationMs: number;
}

/** Inputs to an alignment pass. */
export interface AlignParams {
  sync: ClockSyncResult | null;
  /** monotonicNow − handshakeAtMs at the moment of alignment (null when no sync). */
  offsetAgeMs: number | null;
  /** Staleness window; an offset older than this is not applied (CLOCK_SYNC_STALENESS_MS). */
  stalenessMs: number;
  anchor: VideoAnchor;
  /** First retained sample's watch-mono ms (the blob's `watchStartMs` base). */
  watchStartMs: number | null;
  captureOrigin: 'watch' | 'phone';
}

/** A reading plus its aligned, video-relative timestamp. */
export interface AlignedWatchImuReading extends WatchImuReading {
  /** Aligned video-time ms (0 = first video frame). Present only for kept (in-span) samples. */
  videoMs: number;
}

/** Persisted alignment metadata (swing_debug.watch_imu.alignment). */
export interface WatchImuAlignment {
  clockOffsetMs: number | null;
  roundTripMs: number | null;
  handshakeAtMs: number | null;
  offsetAgeMs: number | null;
  recordIntentAtMs: number | null;
  phoneMonoAtVideoStart: number | null;
  watchStartMs: number | null;
  syncConfidence: SyncConfidence;
  /** Phase B populates these without a schema change. */
  correctionSource: 'audio' | 'video' | 'imu' | 'none';
  impactCorrectionMs: number | null;
  captureOrigin: 'watch' | 'phone';
}

export interface AlignResult {
  /** In-span aligned readings (empty when no usable offset/anchor). */
  aligned: AlignedWatchImuReading[];
  confidence: SyncConfidence;
  alignment: WatchImuAlignment;
}

/** True when the handshake is present and fresh enough to apply. */
export function isOffsetUsable(params: AlignParams): boolean {
  if (!params.sync) return false;
  if (params.offsetAgeMs == null) return false;
  return params.offsetAgeMs <= params.stalenessMs;
}

/** Confidence for an alignment. Never 'high' (unmeasured startRecording latency). */
export function syncConfidenceFor(params: AlignParams): SyncConfidence {
  if (!params.sync) return 'none';
  const usable = isOffsetUsable(params);
  const hasMonoAnchor = params.anchor.phoneMonoAtVideoStart != null;
  return usable && hasMonoAnchor ? 'medium' : 'low';
}

/**
 * Map one absolute watch-mono ms to video-time ms. Returns null when the offset is unusable
 * or the monotonic video anchor is missing (the coarse wall-clock fallback is NOT combined
 * with the monotonic offset — mixing domains would be wrong).
 */
export function watchMonoToVideoMs(
  watchMonoMs: number,
  params: AlignParams,
): number | null {
  if (!isOffsetUsable(params)) return null;
  const anchor = params.anchor.phoneMonoAtVideoStart;
  if (anchor == null) return null;
  const samplePhoneMono = watchMonoMs - params.sync!.clockOffsetMs;
  return samplePhoneMono - anchor;
}

/**
 * Align + trim watch IMU readings to the video span. Readings carry absolute watch-mono `t`.
 * When the offset is usable and a monotonic anchor exists, each sample is mapped to video time
 * and kept iff 0 ≤ videoMs ≤ videoDurationMs (the phone trims the over-captured window here).
 * Otherwise `aligned` is empty and the raw readings are persisted unaligned with low/none
 * confidence.
 */
export function alignWatchImuToVideo(
  readings: WatchImuReading[],
  params: AlignParams,
): AlignResult {
  const confidence = syncConfidenceFor(params);
  const alignment: WatchImuAlignment = {
    clockOffsetMs: params.sync?.clockOffsetMs ?? null,
    roundTripMs: params.sync?.roundTripMs ?? null,
    handshakeAtMs: params.sync?.handshakeAtMs ?? null,
    offsetAgeMs: params.offsetAgeMs,
    recordIntentAtMs: params.anchor.recordIntentAtMs,
    phoneMonoAtVideoStart: params.anchor.phoneMonoAtVideoStart,
    watchStartMs: params.watchStartMs,
    syncConfidence: confidence,
    correctionSource: 'none',
    impactCorrectionMs: null,
    captureOrigin: params.captureOrigin,
  };

  if (confidence !== 'medium') {
    return { aligned: [], confidence, alignment };
  }

  const { videoDurationMs } = params.anchor;
  const aligned: AlignedWatchImuReading[] = [];
  for (const r of readings) {
    const videoMs = watchMonoToVideoMs(r.t, params);
    if (videoMs == null) continue;
    if (videoMs < 0 || videoMs > videoDurationMs) continue;
    aligned.push({ ...r, videoMs });
  }
  return { aligned, confidence, alignment };
}
