/**
 * useSwingVideoClock — the result screen's video/skeleton clock subsystem,
 * extracted VERBATIM from result.tsx (Batch 5.2): player creation, remote
 * signed-URL resolution with one silent retry, playback speed, the
 * timeUpdate-driven skeleton playhead, and the single seek path.
 *
 * ORDER INVARIANT (do not reorder): useVideoPlayer is declared FIRST in this
 * cluster. On unmount its cleanup release()s the player BEFORE the timeUpdate
 * effect's cleanup runs (React runs cleanups in declaration order), which is
 * why that cleanup deliberately does NOT touch timeUpdateEventInterval — the
 * native setter would throw NativeSharedObjectNotFound on a released object.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVideoPlayer } from 'expo-video';
import { getSwingVideoSignedUrl } from '../../lib/getSwingVideoUrl';
import type { PoseFrame } from '../../packages/pose/PoseTypes';

/** FIX 6c scrub coalescing: minimum gap between currentTime writes while a
 *  drag is active (expo-video has no seek-completion event, so "one seek in
 *  flight" is enforced as a time gate + one trailing write for the newest
 *  pending target). EXTERNAL-ASSUMPTION tunable. */
const SCRUB_MIN_SEEK_INTERVAL_MS = 80;

export function useSwingVideoClock(args: {
  frames: PoseFrame[] | undefined;
  videoUri: string | null;
  videoStoragePath: string | null;
  isLiveSwing: boolean;
}) {
  const { frames, videoUri, videoStoragePath, isLiveSwing } = args;

  // Remote playback for historical swings: signed URL resolved ONCE per record
  // load from video_storage_path (private swing-videos bucket). null = no
  // remote video → skeleton-only (existing behavior). Local videoUri wins.
  const [remoteVideoUrl, setRemoteVideoUrl] = useState<string | null>(null);
  // One quiet re-sign on playback error (expired URL / transient network),
  // then give up → skeleton-only. Guards against an error→retry loop.
  const remoteRetriedRef = useRef(false);

  const [speed, setSpeed] = useState(0.25);

  // Frame-index ↔ video-time mapping. Post-hoc extraction guarantees frame i
  // ↔ video time i × msPerFrame (timestamps assigned as i × step in
  // extractPoseFromVideo.ts), so this is exact and offset-free.
  const msPerFrame = useMemo(() => {
    return frames && frames.length > 1
      ? (frames[frames.length - 1].timestampMs - frames[0].timestampMs) / (frames.length - 1)
      : 33;
  }, [frames]);

  // Local capture file wins (live swing, byte-identical to the previous
  // behavior); remote signed URL is the historical-view fallback. useVideoPlayer
  // recreates the player when the source changes (keyed on the parsed source),
  // so the null → signed-URL transition re-runs setup and re-attaches the
  // player-dep'd listener effects below.
  const effectiveVideoUri = videoUri ?? remoteVideoUrl;

  const player = useVideoPlayer(effectiveVideoUri, (p) => {
    p.loop = true;
    p.playbackRate = 0.25;
  });

  useEffect(() => {
    if (player) player.playbackRate = speed;
  }, [speed, player]);

  const [isPlaying, setIsPlaying] = useState(false);
  useEffect(() => {
    if (!player) return;
    const sub = player.addListener('playingChange', (payload) => {
      setIsPlaying(payload.isPlaying);
    });
    return () => sub.remove();
  }, [player]);

  // Seek readiness for the phase-chip gates: expo-video silently drops
  // pause()/currentTime/play() until the native item reaches readyToPlay, so a
  // non-null player object does NOT mean the player can seek. Initialized from
  // player.status because this listener attaches after creation and can miss
  // the transition; useVideoPlayer recreates the player on source change,
  // which re-runs this effect and re-baselines the flag.
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  useEffect(() => {
    if (!player) {
      setIsPlayerReady(false);
      return;
    }
    setIsPlayerReady(player.status === 'readyToPlay');
    const sub = player.addListener('statusChange', (payload) => {
      setIsPlayerReady(payload.status === 'readyToPlay');
    });
    return () => sub.remove();
  }, [player]);

  // Remote-playback failure path: one silent re-sign (expired URL / transient
  // network), then surrender to skeleton-only (remoteVideoUrl → null collapses
  // every video gate). Local-file playback (videoUri set) is never touched.
  useEffect(() => {
    if (!player || videoUri || !remoteVideoUrl) return;
    const sub = player.addListener('statusChange', (payload) => {
      if (payload.status !== 'error') return;
      console.warn('[HoneySwing] remote video playback error:', payload.error?.message);
      if (remoteRetriedRef.current || !videoStoragePath) {
        setRemoteVideoUrl(null);
        return;
      }
      remoteRetriedRef.current = true;
      getSwingVideoSignedUrl(videoStoragePath).then((url) => setRemoteVideoUrl(url));
    });
    return () => sub.remove();
  }, [player, videoUri, remoteVideoUrl, videoStoragePath]);

  // Skeleton playhead, derived from the video player's clock. null until the
  // first timeUpdate; the canvas call site maps no-video → null → the canvas
  // stays uncontrolled (self-clocked rAF).
  const [videoIdx, setVideoIdx] = useState<number | null>(null);
  const frameCount = frames?.length ?? 0;
  // FIX 6c scrub state — active mutes the timeUpdate listener; timer/pending
  // implement the trailing coalesced currentTime write.
  const scrubRef = useRef<{
    active: boolean;
    lastSeekAtMs: number;
    pendingIdx: number | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ active: false, lastSeekAtMs: 0, pendingIdx: null, timer: null });
  useEffect(() => {
    if (!player) return;
    // expo-video emits timeUpdate ONLY when the interval is set (default 0 =
    // disabled). 1/60 s keeps step with one data-frame per ~16.7 ms at 1×.
    player.timeUpdateEventInterval = 1 / 60;
    const sub = player.addListener('timeUpdate', (payload) => {
      if (frameCount === 0) return;
      // Muted mid-scrub (FIX 6c): the drag updates videoIdx immediately while
      // currentTime writes are coalesced behind it — a stale event here would
      // stomp the playhead back to a lagging video position.
      if (scrubRef.current.active) return;
      const idx = Math.round((payload.currentTime * 1000) / msPerFrame);
      setVideoIdx(Math.min(Math.max(0, idx), frameCount - 1));
    });
    return () => {
      // No interval reset here: on unmount useVideoPlayer has already
      // release()d the player (its hook is declared first, cleanups run in
      // declaration order) and the native Property setter throws
      // NativeSharedObjectNotFound on a released object; on dep-change
      // re-runs the effect body re-sets 1/60 anyway. sub.remove() is safe
      // either way — listeners live JS-side, no native-peer lookup.
      sub.remove();
    };
  }, [player, frameCount, msPerFrame]);

  // Deferred-play timer guard: a chip tap <100 ms before back-nav would fire
  // play() on a released player (same NativeSharedObjectNotFound throw, via
  // the global handler). Clear the timer on unmount and no-op the callback
  // once unmounted.
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    const scrub = scrubRef.current;
    return () => {
      isMountedRef.current = false;
      if (seekTimerRef.current != null) {
        clearTimeout(seekTimerRef.current);
        seekTimerRef.current = null;
      }
      if (scrub.timer != null) {
        clearTimeout(scrub.timer);
        scrub.timer = null;
      }
    };
  }, []);

  // THE one seek path for every phase-chip surface (canvas row + video-section
  // row). Divergent chip behavior was the original sync bug — keep it single.
  // opts.autoPlay (default TRUE — existing callers byte-identical): false =
  // stay paused after the seek (operator label-mode frame stepping).
  const seekToFrame = useCallback((index: number, opts?: { autoPlay?: boolean }) => {
    // Not-ready guard covers the surfaces without a chip gate (skeleton-only
    // canvas row) — a seek before readyToPlay would be silently dropped anyway.
    if (!player || !isPlayerReady) return;
    player.pause();
    player.currentTime = Math.max(0, (index * msPerFrame) / 1000);
    // Sync skeleton immediately — timeUpdate is not reliably emitted while
    // paused.
    setVideoIdx(Math.min(Math.max(0, index), Math.max(0, frameCount - 1)));
    if (seekTimerRef.current != null) clearTimeout(seekTimerRef.current);
    if (opts?.autoPlay === false) return;
    seekTimerRef.current = setTimeout(() => {
      seekTimerRef.current = null;
      if (!isMountedRef.current) return;
      player.play();
    }, 100);
  }, [player, isPlayerReady, msPerFrame, frameCount]);

  // ── FIX 6c: scrub path — paused, coalesced preview seeks during a drag ──
  // begin pauses and mutes timeUpdate; update moves the UI playhead
  // immediately and gates currentTime writes to one per
  // SCRUB_MIN_SEEK_INTERVAL_MS with a trailing write for the newest pending
  // target; end lands ONE definitive exact seek through the single seek path
  // (always autoPlay:false — label mode never resumes playback, FIX 6a).
  const beginScrub = useCallback(() => {
    if (!player || !isPlayerReady) return;
    player.pause();
    // A pending deferred-play from an earlier autoPlay seek must not fire
    // mid-scrub.
    if (seekTimerRef.current != null) {
      clearTimeout(seekTimerRef.current);
      seekTimerRef.current = null;
    }
    scrubRef.current.active = true;
  }, [player, isPlayerReady]);

  const scrubToFrame = useCallback(
    (index: number) => {
      const s = scrubRef.current;
      if (!player || !isPlayerReady || !s.active) return;
      const idx = Math.min(Math.max(0, index), Math.max(0, frameCount - 1));
      // Playhead/counter/skeleton update immediately; the video write may lag.
      setVideoIdx(idx);
      const now = Date.now();
      if (s.timer == null && now - s.lastSeekAtMs >= SCRUB_MIN_SEEK_INTERVAL_MS) {
        s.lastSeekAtMs = now;
        player.currentTime = Math.max(0, (idx * msPerFrame) / 1000);
        return;
      }
      s.pendingIdx = idx; // newest target replaces pending
      if (s.timer == null) {
        s.timer = setTimeout(
          () => {
            s.timer = null;
            const pending = s.pendingIdx;
            s.pendingIdx = null;
            if (!isMountedRef.current || !s.active || pending == null) return;
            s.lastSeekAtMs = Date.now();
            player.currentTime = Math.max(0, (pending * msPerFrame) / 1000);
          },
          Math.max(0, SCRUB_MIN_SEEK_INTERVAL_MS - (now - s.lastSeekAtMs)),
        );
      }
    },
    [player, isPlayerReady, msPerFrame, frameCount],
  );

  const endScrub = useCallback(
    (index: number) => {
      const s = scrubRef.current;
      if (s.timer != null) {
        clearTimeout(s.timer);
        s.timer = null;
      }
      s.pendingIdx = null;
      s.active = false;
      seekToFrame(index, { autoPlay: false });
    },
    [seekToFrame],
  );

  // Resolve the uploaded video into a signed URL ONCE per record load —
  // historical views only. Local videoUri (live swing) wins; storage_path
  // null (never/in-flight upload) → stays skeleton-only with no error.
  useEffect(() => {
    if (videoUri || isLiveSwing || !videoStoragePath) return;
    let cancelled = false;
    getSwingVideoSignedUrl(videoStoragePath).then((url) => {
      if (!cancelled && url) setRemoteVideoUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [videoUri, isLiveSwing, videoStoragePath]);

  return {
    player,
    effectiveVideoUri,
    isPlaying,
    isPlayerReady,
    videoIdx,
    speed,
    setSpeed,
    seekToFrame,
    beginScrub,
    scrubToFrame,
    endScrub,
  };
}
