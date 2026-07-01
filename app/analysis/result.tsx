import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, useWindowDimensions, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, type Href } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { styles } from './resultStyles';
import {
  getCurrentSwingMotion,
  getCurrentSwingAnalysis,
  getCurrentSwingVideoUri,
  getCurrentSwingId,
  computeFocus,
  saveFocus,
} from '../../lib/swingMotionStore';
import { checkSwingLimit } from '../../lib/swingLimit';
import { getUser, supabase } from '../../lib/supabase';
import { getSwingById, getSwingMotionFrames, type SwingRecord } from '../../lib/swingStore';
import { getSwingVideoSignedUrl } from '../../lib/getSwingVideoUrl';
import { GOLD } from '../../lib/colors';
import {
  analyzePoseSequence,
  type AnalysisResult,
} from '../../packages/domain/swing/analysisPipeline';
import type { SwingPhase } from '../../packages/domain/swing/phaseDetection';
import type { PoseSequence, PoseFrame } from '../../packages/pose/PoseTypes';
import {
  TEMPO_LABELS,
  type TempoRating,
} from '../../packages/domain/swing/tempoAnalysis';
import VisualCoachCard from '../../components/VisualCoachCard';
import { classifyCapture, type CaptureClassification } from '@/packages/domain/swing/captureValidity';
import { getActiveProfileHandedness } from '../../lib/handedness';
import { getPrimaryProfile, getProfiles, type PlayerProfile } from '../../lib/playerProfiles';
import { resolveHeaderProfile } from '../../lib/headerIdentity';
import { getCoachCode } from '../../lib/coachCode';
import { processSwingTips, type ProcessedCoachingTip } from '../../lib/tipFrequency';
import { shouldShowMetric } from '../../packages/domain/swing/confidenceScore';
import SwingArtCard from '../../components/SwingArtCard';
import SwingSkeletonCanvas from '../../components/SwingSkeletonCanvas';
import { positiveReinforcementEngine } from '@/packages/domain/swing/positiveReinforcement';
import type { ProcessSwingResult } from '@/packages/domain/swing/positiveReinforcement';
import { sessionAccumulator, type SessionInsight } from '../../lib/sessionAccumulator';
import { frameToLandmarks, pickKeyFrame, buildRawTips, METRIC_KEY_MAP } from '../../lib/coachingTips';
import {
  scoreTempoTrafficLight,
  TEMPO_GREEN_LOWER,
  TEMPO_GREEN_UPPER,
} from '../../packages/domain/swing/scoring';
import type { GripClassification } from '../../lib/classifyGrip';

const GRIP_CHIP_COLORS: Record<string, { label: string; color: string }> = {
  solid:            { label: 'Solid',            color: '#00FF66' },
  playable:         { label: 'Playable',         color: '#FFB020' },
  needs_adjustment: { label: 'Needs Adjustment', color: '#FF4444' },
};

type PhaseChipKey = SwingPhase | 'full_swing';
const PHASE_CHIPS: { phase: PhaseChipKey; label: string }[] = [
  { phase: 'full_swing',     label: 'Full Swing' },
  { phase: 'takeaway',       label: 'Takeaway' },
  { phase: 'top',            label: 'Top' },
  { phase: 'impact',         label: 'Impact' },
  { phase: 'follow_through', label: 'Finish' },
];

const NO_DATA_FAILURE_REASONS = new Set([
  'no-person',
  'zero-frames',
  'recording-stop-fallback',
  'recording-error',
  'extract-or-analyze-threw',
]);

// Reconstruct an AnalysisResult from a persisted SwingRecord — used by the
// history-tap path where the in-memory store doesn't hold the tapped swing.
// `swingConfidence` and `cameraAngleResult` are NOT persisted today; safe
// defaults (matching the empty-sequence shape at analysisPipeline.ts:515-527)
// gate coaching tips off via the confidence threshold at result.tsx :290.
// Follow-up: persist swingConfidence + cameraAngleResult for full-fidelity
// tips on historical swings. Re-analyzing motion_frames is NOT a fix —
// persistSwing.ts:191-199 stores only the average gravity vector, so
// applyTiltCorrection rejects (insufficient_samples) on replay and the
// re-analyzed score diverges from the persisted one.
function reconstructAnalysisFromRecord(record: SwingRecord): AnalysisResult {
  return {
    score: record.score,
    honeyBoom: record.honey_boom ?? false,
    cameraAngleValid: record.camera_angle_valid ?? false,
    swingConfidence: {
      overall: 0,
      tier: 'low',
      components: {
        jointVisibility: 0,
        cameraAngle: 0,
        phaseDetection: 0,
        frameCoverage: 0,
      },
    },
    cameraAngleResult: {
      angle: 'unknown',
      shoulderSpread: 0,
      hipSpread: 0,
      avgSpread: 0,
      footIndexNorm: null,
      weights: {
        spineAngle: 0,
        leftElbowAngle: 0,
        rightElbowAngle: 0,
        leftKneeAngle: 0,
        rightKneeAngle: 0,
        hipSpreadDelta: 0,
        shoulderTilt: 0,
        tempo: 0,
      },
    },
    angles: record.angles ?? undefined,
    tempo: record.tempo ?? null,
    phases: record.phases ?? undefined,
    trail: record.trail_points ?? undefined,
    metricConfidences: record.metric_confidences ?? undefined,
    // swing_debug omitted: DB column is a superset (persistSwing.ts:229-246
    // spreads extra debug keys), not a clean FrameSelectionDebug. Sole
    // consumer (scoring_breakdown tip build) is gated off by the
    // low-confidence default above.
    // aggregate omitted: explicitly NOT persisted per analysisPipeline.ts:104.
  };
}

export default function ResultScreen() {
  const router = useRouter();
  const { swingId } = useLocalSearchParams<{ swingId?: string }>();
  const { width: screenW } = useWindowDimensions();
  const motion = getCurrentSwingMotion();
  const storedAnalysis = getCurrentSwingAnalysis();
  const videoUri = getCurrentSwingVideoUri();
  const liveSwingId = getCurrentSwingId();
  // "live" means: the in-memory store holds the swing being viewed. True when
  // either (a) URL carries no swingId AND in-memory has data (live capture
  // path where persist returned no id), or (b) URL swingId matches the
  // in-memory id (live capture path with successful persist). History-tap
  // navigation falls through to false because the tapped swingId won't match.
  const isLiveSwing = motion !== null && (!swingId || swingId === liveSwingId);
  const [swingRecord, setSwingRecord] = useState<SwingRecord | null>(null);
  const [recordLoaded, setRecordLoaded] = useState(false);
  const [profiles, setProfiles] = useState<PlayerProfile[]>([]);
  const [isLeftHanded, setIsLeftHanded] = useState<boolean | null>(null);
  const [coachName, setCoachName] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [speed, setSpeed] = useState(0.25);
  // Stage view mode. Default 'overlay' (skeleton on the video frame). Only
  // meaningful when a video exists; the no-video path renders skeleton-only and
  // never shows the segmented control.
  const [viewMode, setViewMode] = useState<'video' | 'overlay' | 'skeleton'>('overlay');
  const swingAddedRef = useRef(false);
  const [gripCloud, setGripCloud] = useState<GripClassification | null>(null);
  const [activeProfile, setActiveProfile] = useState<PlayerProfile | null>(null);
  const [historicalFrames, setHistoricalFrames] = useState<PoseFrame[] | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);
  // Remote playback for historical swings: signed URL resolved ONCE per record
  // load from video_storage_path (private swing-videos bucket). null = no
  // remote video → skeleton-only (existing behavior). Local videoUri wins.
  const [remoteVideoUrl, setRemoteVideoUrl] = useState<string | null>(null);
  // One quiet re-sign on playback error (expired URL / transient network),
  // then give up → skeleton-only. Guards against an error→retry loop.
  const remoteRetriedRef = useRef(false);

  const effectiveMotion = useMemo(
    () =>
      isLiveSwing
        ? motion
        : historicalFrames
          ? {
              frames: historicalFrames,
              recordedAt: 0,
              // EXTERNAL ASSUMPTION: source='live-camera' for historical frames.
              // Verified no consumer branches on this value (only assigned to
              // sequence.source).
              source: 'live-camera' as const,
            }
          : null,
    [isLiveSwing, motion, historicalFrames],
  );

  // Frame-index ↔ video-time mapping. Post-hoc extraction guarantees frame i
  // ↔ video time i × msPerFrame (timestamps assigned as i × step in
  // extractPoseFromVideo.ts), so this is exact and offset-free.
  const msPerFrame = useMemo(() => {
    const frames = effectiveMotion?.frames;
    return frames && frames.length > 1
      ? (frames[frames.length - 1].timestampMs - frames[0].timestampMs) / (frames.length - 1)
      : 33;
  }, [effectiveMotion]);

  // Re-read on focus (not just mount) so a profile switched while this screen was
  // backgrounded is reflected when the viewer regains focus.
  useFocusEffect(
    useCallback(() => {
      getPrimaryProfile().then(setActiveProfile).catch((err) => console.error('[HoneySwing]', err));
      getProfiles().then(setProfiles).catch((err) => console.error('[HoneySwing]', err));
    }, []),
  );

  // Local capture file wins (live swing, byte-identical to the previous
  // behavior); remote signed URL is the historical-view fallback. useVideoPlayer
  // recreates the player when the source changes (keyed on the parsed source),
  // so the null → signed-URL transition re-runs setup and re-attaches the
  // player-dep'd listener effects below.
  const videoStoragePath = swingRecord?.video_storage_path ?? null;
  const effectiveVideoUri = videoUri ?? remoteVideoUrl;

  const player = useVideoPlayer(effectiveVideoUri, (p) => {
    p.loop = true;
    p.playbackRate = 0.25;
  });

  // Driven mode (video present): the skeleton canvas matches the video panel
  // exactly — same width (content column, container padding 24/side) and the
  // video's 9:16 aspect — so the identity transform in SwingSkeletonCanvas
  // frames the figure pixel-identically to the golfer in the video.
  const hasVideo = !!(effectiveVideoUri && player);
  const skeletonCanvasW = hasVideo ? screenW - 48 : screenW - 32;
  const skeletonCanvasH = hasVideo ? Math.round(((screenW - 48) * 16) / 9) : 380;

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
  const frameCount = effectiveMotion?.frames?.length ?? 0;
  useEffect(() => {
    if (!player) return;
    // expo-video emits timeUpdate ONLY when the interval is set (default 0 =
    // disabled). 1/60 s keeps step with one data-frame per ~16.7 ms at 1×.
    player.timeUpdateEventInterval = 1 / 60;
    const sub = player.addListener('timeUpdate', (payload) => {
      if (frameCount === 0) return;
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
    return () => {
      isMountedRef.current = false;
      if (seekTimerRef.current != null) {
        clearTimeout(seekTimerRef.current);
        seekTimerRef.current = null;
      }
    };
  }, []);

  // THE one seek path for every phase-chip surface (canvas row + video-section
  // row). Divergent chip behavior was the original sync bug — keep it single.
  const seekToFrame = useCallback((index: number) => {
    if (!player) return;
    player.pause();
    player.currentTime = Math.max(0, (index * msPerFrame) / 1000);
    // Sync skeleton immediately — timeUpdate is not reliably emitted while
    // paused.
    setVideoIdx(Math.min(Math.max(0, index), Math.max(0, frameCount - 1)));
    if (seekTimerRef.current != null) clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(() => {
      seekTimerRef.current = null;
      if (!isMountedRef.current) return;
      player.play();
    }, 100);
  }, [player, msPerFrame, frameCount]);

  const scrollRef = useRef<ScrollView>(null);
  const [videoSectionY, setVideoSectionY] = useState<number | null>(null);
  useEffect(() => {
    if (videoSectionY == null) return;
    const t = setTimeout(
      () => scrollRef.current?.scrollTo({ y: videoSectionY, animated: true }),
      2000,
    );
    return () => clearTimeout(t);
  }, [videoSectionY]);

  // Re-read on focus so the skeleton orientation reflects the ACTIVE profile's
  // handedness after a profile switch (was once-only on mount → stale skeleton).
  useFocusEffect(
    useCallback(() => {
      getActiveProfileHandedness().then(setIsLeftHanded).catch((err) => console.error('[HoneySwing]', err));
      getCoachCode().then(setCoachName).catch((err) => console.error('[HoneySwing]', err));

      // Check swing limit after this swing was persisted
      checkSwingLimit().then((status) => {
        if (!status.allowed) {
          getUser().then((user) => {
            if (!user) setLimitHit(true);
          }).catch((err) => console.error('[HoneySwing]', err));
        }
      }).catch((err) => console.error('[HoneySwing]', err));
    }, []),
  );

  useEffect(() => {
    if (!swingId) return;
    setRecordLoaded(false);
    getSwingById(swingId)
      .then((swing) => {
        if (!swing) return;
        setSwingRecord(swing);
        const gc = swing.swing_debug?.grip_cloud as GripClassification | undefined;
        if (gc && !gc.analysis_failed) setGripCloud(gc);
      })
      .catch((err) => console.error('[HoneySwing]', err))
      .finally(() => setRecordLoaded(true));
  }, [swingId]);

  useEffect(() => {
    if (!swingId || isLiveSwing) return;
    setFramesLoading(true);
    getSwingMotionFrames(swingId)
      .then((frames) => setHistoricalFrames(frames))
      .catch((err) => console.error('[HoneySwing]', err))
      .finally(() => setFramesLoading(false));
  }, [swingId, isLiveSwing]);

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

  useEffect(() => {
    const reason = swingRecord?.failure_reason;
    if (reason && NO_DATA_FAILURE_REASONS.has(reason)) {
      router.replace({
        pathname: '/analysis/no-swing',
        params: { reason, swingId: swingRecord.id },
      } as Href);
    }
  }, [swingRecord, router]);

  const classification: CaptureClassification | null = useMemo(
    () => (effectiveMotion ? classifyCapture(effectiveMotion.frames) : null),
    [effectiveMotion],
  );

  const sequence: PoseSequence | null = useMemo(() => {
    if (!effectiveMotion) return null;
    return {
      frames: effectiveMotion.frames,
      source: effectiveMotion.source,
      metadata: {
        durationMs:
          effectiveMotion.frames.length > 1
            ? effectiveMotion.frames[effectiveMotion.frames.length - 1].timestampMs - effectiveMotion.frames[0].timestampMs
            : 0,
      },
    };
  }, [effectiveMotion]);

  const fallbackAnalysis: AnalysisResult | null = useMemo(() => {
    if (isLeftHanded === null) return null;
    if (!isLiveSwing) return null;
    if (!sequence || classification?.validity === 'invalid' || storedAnalysis) return null;
    return analyzePoseSequence(sequence, isLeftHanded);
  }, [sequence, classification, storedAnalysis, isLiveSwing, isLeftHanded]);

  const reconstructedAnalysis: AnalysisResult | null = useMemo(
    () => (swingRecord && !isLiveSwing ? reconstructAnalysisFromRecord(swingRecord) : null),
    [swingRecord, isLiveSwing],
  );

  const analysis: AnalysisResult | null = isLiveSwing
    ? (storedAnalysis ?? fallbackAnalysis)
    : reconstructedAnalysis;
  const partialReason: string | null =
    analysis?.swing_debug?.fallback_gate != null
      ? String(analysis.swing_debug.fallback_gate)
      : swingRecord?.failure_reason === 'no-swing'
        ? swingRecord.failure_reason
        : null;
  const angles = analysis?.angles;
  const tempo = analysis?.tempo;
  const firstFrameTimestamp = effectiveMotion?.frames?.[0]?.timestampMs;

  const tempoResult = tempo ? scoreTempoTrafficLight(tempo.tempoRatio) : null;
  const isGreen = tempoResult?.isGreen ?? false;
  const tooFast = !!tempo && tempo.tempoRatio < TEMPO_GREEN_LOWER;
  const tooSlow = !!tempo && tempo.tempoRatio > TEMPO_GREEN_UPPER;
  const scoreColor = isGreen ? '#44CC44' : '#FFFFFF';
  const tempoLabelText = isGreen
    ? 'Perfect swing speed!'
    : tooFast
    ? 'Slow down your backswing'
    : tooSlow
    ? 'Speed up your backswing'
    : null;
  const coachingCueText = tooFast
    ? "Swing back slow like you're moving through honey"
    : tooSlow
    ? 'Whip the club head back fast'
    : null;

  const finalScore = analysis?.score ?? 0;
  const [displayedScore, setDisplayedScore] = useState(0);
  useEffect(() => {
    if (finalScore <= 0) {
      setDisplayedScore(0);
      return;
    }
    let raf: number;
    const start = Date.now();
    const tick = () => {
      const p = Math.min(1, (Date.now() - start) / 800);
      setDisplayedScore(Math.round(finalScore * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [finalScore]);

  const isLowConfidence = classification?.validity === 'partial';

  // Task 7: frequency-limited coaching tips + Task 8: positive reinforcement
  const { processedTips, positiveResult } = useMemo<{
    processedTips: ProcessedCoachingTip[];
    positiveResult: ProcessSwingResult;
  }>(() => {
    if (!analysis) return { processedTips: [], positiveResult: { card: null, improvements: [] } };
    const breakdown = analysis.swing_debug?.scoring_breakdown;
    if (!breakdown) return { processedTips: [], positiveResult: { card: null, improvements: [] } };
    const rawTips = buildRawTips(breakdown);
    const estimatedAngleDeg = analysis.swing_debug?.foreshortening?.estimatedAngleDegrees ?? null;
    const tips = processSwingTips(
      rawTips,
      shouldShowMetric,
      analysis.swingConfidence,
      analysis.cameraAngleResult,
      estimatedAngleDeg,
    );

    // Build deduped metric scores (same metricKey mapping as buildRawTips, keep worst score)
    const worstByKey = new Map<string, number>();
    for (const entry of breakdown) {
      if (entry.dataQuality === 'missing') continue;  // SCR-0b-1: don't pull "0" worst from missing
      const mappedKey = METRIC_KEY_MAP[entry.metric];
      if (!mappedKey) continue;
      const existing = worstByKey.get(mappedKey);
      if (existing === undefined || entry.score < existing) {
        worstByKey.set(mappedKey, entry.score);
      }
    }
    const dedupedScores = Array.from(worstByKey.entries()).map(([metricKey, score]) => ({ metricKey, score }));

    const swingConfidence = analysis.swingConfidence ?? { tier: 'low' as const, overall: 0 };
    const posResult = positiveReinforcementEngine.processSwing(
      { tier: swingConfidence.tier, overall: swingConfidence.overall },
      dedupedScores,
      tips.length,
    );
    if (posResult.card) {
      console.log('[positiveReinforcement]', posResult.card);
    }

    return { processedTips: tips, positiveResult: posResult };
  }, [analysis]);

  // Task 14: Session accumulator — feed swing data once per swing
  useEffect(() => {
    if (!analysis || swingAddedRef.current) return;
    swingAddedRef.current = true;
    const firedMetricKeys = processedTips.map(t => t.metricKey);
    sessionAccumulator.addSwing(analysis, firedMetricKeys);
  }, [analysis, processedTips]);

  const sessionInsight = useMemo<SessionInsight | null>(() => {
    if (!analysis) return null;

    // Only show session insight if no high-priority correction tip
    const hasHighPriorityTip = processedTips.length > 0 &&
      (analysis.swingConfidence?.overall ?? 0) >= 0.75;
    if (hasHighPriorityTip) return null;

    const insight = sessionAccumulator.getInsight();
    if (insight) {
      console.log('[sessionInsight]', insight.type, insight.metricKey, insight.message);
    }
    return insight;
  }, [analysis, processedTips]);

  // Persist session insight to the swing row (atomic JSONB merge — no read-modify-write race)
  useEffect(() => {
    if (!swingId || !sessionInsight) return;
    supabase
      .rpc('merge_swing_debug', {
        swing_id: swingId,
        patch: { session_insight_shown: sessionInsight.message },
      })
      .then(({ error }) => {
        if (error) {
          console.error('[HoneySwing] session_insight_shown update error:', error.message);
        }
      });
  }, [swingId, sessionInsight]);

  // Metro log for verification before tip UI exists
  useEffect(() => {
    if (processedTips.length > 0) {
      console.log('[tipFrequency]', processedTips.map(t => `${t.metricKey}:${t.decision.tier}`));
    }
  }, [processedTips]);

  // Persist the weakest metric as "Today's Focus" for the home screen
  useEffect(() => {
    if (!angles) return;
    const focus = computeFocus(angles);
    if (focus) saveFocus(focus).catch((err) => console.error('[HoneySwing]', err));
  }, [angles]);

  const tempoRating = tempo?.tempoRating as TempoRating | undefined;
  const tempoLabel = tempoRating ? TEMPO_LABELS[tempoRating] : null;

  const keyFrame = useMemo(
    () => (effectiveMotion ? pickKeyFrame(effectiveMotion.frames) : null),
    [effectiveMotion],
  );
  const keyLandmarks = useMemo(
    () => (keyFrame ? frameToLandmarks(keyFrame) : []),
    [keyFrame],
  );

  // Skeleton preview dimensions — compact 3:4 landscape-ish for coaching card
  const skeletonW = screenW - 48;
  const skeletonH = Math.round(skeletonW * 0.85);

  // Header identity: the viewed swing's OWN attribution governs (not the current
  // primary). Live swing belongs to the current primary, so its pre-load fallback
  // is activeProfile; the history path must not flash another kid's name pre-load.
  const headerProfile = resolveHeaderProfile(
    swingRecord,
    profiles,
    isLiveSwing ? activeProfile : null,
    recordLoaded,
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* 1. Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {headerProfile?.name ? `${headerProfile.name}'s Swing` : 'Your Swing'}
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView ref={scrollRef} contentContainerStyle={styles.container}>
        {!effectiveMotion && !analysis ? (
          framesLoading ? (
            <ActivityIndicator color={GOLD} style={{ marginTop: 40 }} />
          ) : (
            <Text style={styles.emptyText}>No swing data available yet.</Text>
          )
        ) : classification?.validity === 'invalid' ? (
          <View style={styles.invalidContainer}>
            <Text style={styles.invalidTitle}>Couldn&apos;t clearly capture your swing</Text>
            <Text style={styles.invalidHint}>
              Make sure your full body is in frame and try again
            </Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => router.back()}
              activeOpacity={0.7}
            >
              <Text style={styles.primaryButtonText}>Record Again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {partialReason && (
              <View style={styles.partialBanner}>
                <Text style={styles.partialBannerTitle}>
                  We couldn&apos;t fully read this swing — score is approximate.
                </Text>
                <Text style={styles.partialBannerSub}>Reason: {partialReason}</Text>
              </View>
            )}
            {/* 1. Score */}
            <View style={styles.scoreCard}>
              <Text style={[styles.score, { color: scoreColor }]}>
                {displayedScore}
              </Text>
              {tempoLabelText && (
                <Text style={[styles.tempoVerdict, { color: scoreColor }]}>
                  {tempoLabelText}
                </Text>
              )}
              {coachingCueText && (
                <Text style={styles.coachingCue}>{coachingCueText}</Text>
              )}
              {tempo && (
                <Text style={styles.tempoRatio}>
                  {tempo.tempoRatio.toFixed(2)}:1
                </Text>
              )}
              {tempo && (
                <View style={styles.timingRow}>
                  <Text style={styles.timingItem}>Back {Math.round(tempo.backswingMs)}ms</Text>
                  <Text style={styles.timingItem}>Down {Math.round(tempo.downswingMs)}ms</Text>
                </View>
              )}
            </View>

            {/* 2. Stage: Video / Overlay / Skeleton */}
            {effectiveMotion?.frames?.length ? (
              hasVideo ? (
                <>
                  {/* Control bar — segmented control (left) + speed chips
                      (right). Video-backed swings only; the speed chips are the
                      transport for the shared video clock that also drives the
                      skeleton in Overlay/Skeleton modes. */}
                  <View style={styles.controlBar}>
                    <View style={styles.segmentedControl}>
                      {([
                        { mode: 'video', label: 'Video' },
                        { mode: 'overlay', label: 'Overlay' },
                        { mode: 'skeleton', label: 'Skeleton' },
                      ] as const).map(({ mode, label }) => (
                        <TouchableOpacity
                          key={mode}
                          style={[styles.segment, viewMode === mode && styles.segmentActive]}
                          onPress={() => setViewMode(mode)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.segmentText, viewMode === mode && styles.segmentTextActive]}>
                            {label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    <View style={[styles.segmentedControl, { alignSelf: 'stretch' }]}>
                      {([0.25, 0.5, 1] as const).map((s) => (
                        <TouchableOpacity
                          key={s}
                          style={[styles.segment, { flex: 1, alignItems: 'center' }, speed === s && styles.segmentActive]}
                          onPress={() => setSpeed(s)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.segmentText, speed === s && styles.segmentTextActive]}>
                            {s}x
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>

                  <View
                    style={styles.videoSection}
                    onLayout={(e) => setVideoSectionY(e.nativeEvent.layout.y)}
                  >
                    {/* Video stays mounted in ALL modes — unmounting would
                        pause the player / stop timeUpdate and freeze the driven
                        skeleton. Skeleton mode just hides it behind a dark
                        backdrop (opacity 0 + opaque cover). */}
                    <View style={[styles.stage, { width: skeletonCanvasW, height: skeletonCanvasH }]}>
                      <VideoView
                        player={player}
                        style={[styles.videoPlayer, viewMode === 'skeleton' && { opacity: 0 }]}
                        nativeControls={false}
                      />
                      {viewMode === 'skeleton' && (
                        <View style={[StyleSheet.absoluteFill, styles.skeletonBackdrop]} />
                      )}
                      {viewMode !== 'video' && (
                        <View style={StyleSheet.absoluteFill} pointerEvents="none">
                          <SwingSkeletonCanvas
                            frames={effectiveMotion.frames}
                            phases={analysis?.phases ?? null}
                            width={skeletonCanvasW}
                            height={skeletonCanvasH}
                            // Driven by the video clock; videoIdx ?? 0 until the
                            // first timeUpdate. No onPhaseSeek → canvas hides its
                            // own chip row; the phase chips below are the single
                            // chip surface.
                            playheadIdx={videoIdx ?? 0}
                            overlay
                          />
                        </View>
                      )}
                      {!isPlaying && (
                        <TouchableOpacity
                          style={styles.videoPlayButton}
                          onPress={() => player.play()}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.videoPlayButtonIcon}>▶</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                </>
              ) : (
                // No video → skeleton-only, self-clocked replay (existing
                // behavior). No segmented control.
                <SwingSkeletonCanvas
                  frames={effectiveMotion.frames}
                  phases={analysis?.phases ?? null}
                  width={skeletonCanvasW}
                  height={skeletonCanvasH}
                  playheadIdx={null}
                  onPhaseSeek={(_phase, index) => seekToFrame(index)}
                />
              )
            ) : null}

            {/* 3. Phase chips */}
            <View style={styles.phaseChipsRow}>
              {PHASE_CHIPS.map((entry) => {
                if (entry.phase === 'full_swing') {
                  const enabled = !!player && !!effectiveVideoUri;
                  return (
                    <TouchableOpacity
                      key={entry.phase}
                      style={enabled ? styles.phaseChip : styles.phaseChipDisabled}
                      disabled={!enabled}
                      onPress={
                        enabled
                          ? () => seekToFrame(0)
                          : undefined
                      }
                      activeOpacity={0.7}
                    >
                      <Text
                        style={enabled ? styles.phaseChipLabel : styles.phaseChipLabelDisabled}
                        numberOfLines={1}
                      >
                        {entry.label}
                      </Text>
                    </TouchableOpacity>
                  );
                }
                const phaseEntry = analysis?.phases?.find((p) => p.phase === entry.phase);
                const enabled = !!phaseEntry && !!player && !!effectiveVideoUri && firstFrameTimestamp != null;
                return (
                  <TouchableOpacity
                    key={entry.phase}
                    style={enabled ? styles.phaseChip : styles.phaseChipDisabled}
                    disabled={!enabled}
                    onPress={
                      enabled
                        ? () => {
                            if (typeof phaseEntry.index !== 'number') return;
                            seekToFrame(phaseEntry.index);
                          }
                        : undefined
                    }
                    activeOpacity={0.7}
                  >
                    <Text
                      style={enabled ? styles.phaseChipLabel : styles.phaseChipLabelDisabled}
                      numberOfLines={1}
                    >
                      {entry.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* 4. Swing Art */}
            {classification?.validity === 'valid' && effectiveMotion && (
              <View style={{ marginTop: 8 }}>
                <SwingArtCard
                  frames={effectiveMotion.frames}
                  phases={analysis?.phases ?? []}
                  width={screenW - 48}
                />
              </View>
            )}

            {/* 5. CTA */}
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => router.back()}
              activeOpacity={0.7}
            >
              <Text style={styles.primaryButtonText}>Record Again</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
