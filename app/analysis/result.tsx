import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, useWindowDimensions, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, type Href } from 'expo-router';
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
import { classifyCapture, type CaptureClassification } from '../../lib/captureValidity';
import { getIsLeftHanded } from '../../lib/handedness';
import { getActiveProfile, type PlayerProfile } from '../../lib/playerProfiles';
import { getCoachCode } from '../../lib/coachCode';
import { processSwingTips, type ProcessedCoachingTip } from '../../lib/tipFrequency';
import { shouldShowMetric } from '../../packages/domain/swing/confidenceScore';
import SwingArtCard from '../../components/SwingArtCard';
import SwingSkeletonCanvas from '../../components/SwingSkeletonCanvas';
import { positiveReinforcementEngine } from '../../lib/positiveReinforcement';
import type { ProcessSwingResult } from '../../lib/positiveReinforcement';
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
  { phase: 'address',        label: 'Address' },
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
  const [isLeftHanded, setIsLeftHanded] = useState<boolean | null>(null);
  const [coachName, setCoachName] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [speed, setSpeed] = useState(0.25);
  const swingAddedRef = useRef(false);
  const [gripCloud, setGripCloud] = useState<GripClassification | null>(null);
  const [activeProfile, setActiveProfile] = useState<PlayerProfile | null>(null);
  const [historicalFrames, setHistoricalFrames] = useState<PoseFrame[] | null>(null);
  const [framesLoading, setFramesLoading] = useState(false);

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

  useEffect(() => {
    getActiveProfile().then(setActiveProfile).catch((err) => console.error('[HoneySwing]', err));
  }, []);

  const player = useVideoPlayer(videoUri, (p) => {
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

  useEffect(() => {
    getIsLeftHanded().then(setIsLeftHanded).catch((err) => console.error('[HoneySwing]', err));
    getCoachCode().then(setCoachName).catch((err) => console.error('[HoneySwing]', err));

    // Check swing limit after this swing was persisted
    checkSwingLimit().then((status) => {
      if (!status.allowed) {
        getUser().then((user) => {
          if (!user) setLimitHit(true);
        }).catch((err) => console.error('[HoneySwing]', err));
      }
    }).catch((err) => console.error('[HoneySwing]', err));
  }, []);

  useEffect(() => {
    if (!swingId) return;
    getSwingById(swingId).then((swing) => {
      if (!swing) return;
      setSwingRecord(swing);
      const gc = swing.swing_debug?.grip_cloud as GripClassification | undefined;
      if (gc && !gc.analysis_failed) setGripCloud(gc);
    });
  }, [swingId]);

  useEffect(() => {
    if (!swingId || isLiveSwing) return;
    setFramesLoading(true);
    getSwingMotionFrames(swingId)
      .then((frames) => setHistoricalFrames(frames))
      .catch((err) => console.error('[HoneySwing]', err))
      .finally(() => setFramesLoading(false));
  }, [swingId, isLiveSwing]);

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
          {activeProfile?.name ? `${activeProfile.name}'s Swing` : 'Your Swing'}
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

            {effectiveMotion?.frames?.length ? (
              <SwingSkeletonCanvas
                frames={effectiveMotion.frames}
                phases={analysis?.phases ?? null}
                width={screenW - 32}
                height={380}
              />
            ) : null}

            {/* 2. Video */}
            {videoUri && player && (
              <View
                style={styles.videoSection}
                onLayout={(e) => setVideoSectionY(e.nativeEvent.layout.y)}
              >
                <View style={styles.videoWrapper}>
                  <VideoView
                    player={player}
                    style={styles.videoPlayer}
                    nativeControls={false}
                  />
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
                <View style={styles.speedRow}>
                  {([0.25, 0.5, 1] as const).map((s) => (
                    <TouchableOpacity
                      key={s}
                      style={[styles.speedButton, speed === s && styles.speedButtonActive]}
                      onPress={() => setSpeed(s)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.speedButtonText, speed === s && styles.speedButtonTextActive]}>
                        {s}x
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* 3. Phase chips */}
            <View style={styles.phaseChipsRow}>
              {PHASE_CHIPS.map((entry) => {
                if (entry.phase === 'full_swing') {
                  const enabled = !!player && !!videoUri;
                  return (
                    <TouchableOpacity
                      key={entry.phase}
                      style={enabled ? styles.phaseChip : styles.phaseChipDisabled}
                      disabled={!enabled}
                      onPress={
                        enabled
                          ? () => {
                              player.pause();
                              player.currentTime = 0;
                              setTimeout(() => {
                                player.play();
                              }, 100);
                            }
                          : undefined
                      }
                      activeOpacity={0.7}
                    >
                      <Text style={enabled ? styles.phaseChipLabel : styles.phaseChipLabelDisabled}>
                        {entry.label}
                      </Text>
                    </TouchableOpacity>
                  );
                }
                const phaseEntry = analysis?.phases?.find((p) => p.phase === entry.phase);
                const enabled = !!phaseEntry && !!player && !!videoUri && firstFrameTimestamp != null;
                return (
                  <TouchableOpacity
                    key={entry.phase}
                    style={enabled ? styles.phaseChip : styles.phaseChipDisabled}
                    disabled={!enabled}
                    onPress={
                      enabled
                        ? () => {
                            if (typeof phaseEntry.index !== 'number') return;
                            const frames = effectiveMotion?.frames;
                            const msPerFrame = (frames && frames.length > 1)
                              ? (frames[frames.length - 1].timestampMs - frames[0].timestampMs) / (frames.length - 1)
                              : 33;
                            const seekSeconds = Math.max(0, (phaseEntry.index * msPerFrame) / 1000);
                            player.pause();
                            player.currentTime = seekSeconds;
                            setTimeout(() => {
                              player.play();
                            }, 100);
                          }
                        : undefined
                    }
                    activeOpacity={0.7}
                  >
                    <Text style={enabled ? styles.phaseChipLabel : styles.phaseChipLabelDisabled}>
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
