import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, type Href } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { styles } from './resultStyles';
import {
  getCurrentSwingMotion,
  getCurrentSwingAnalysis,
  getCurrentSwingVideoUri,
  computeFocus,
  saveFocus,
} from '../../lib/swingMotionStore';
import { checkSwingLimit } from '../../lib/swingLimit';
import { getUser, supabase } from '../../lib/supabase';
import {
  analyzePoseSequence,
  type AnalysisResult,
} from '../../packages/domain/swing/analysisPipeline';
import type { PoseSequence } from '../../packages/pose/PoseTypes';
import {
  TEMPO_LABELS,
  type TempoRating,
} from '../../packages/domain/swing/tempoAnalysis';
import VisualCoachCard from '../../components/VisualCoachCard';
import { classifyCapture, type CaptureClassification } from '../../lib/captureValidity';
import { getIsLeftHanded } from '../../lib/handedness';
import { getCoachCode } from '../../lib/coachCode';
import { processSwingTips, type ProcessedCoachingTip } from '../../lib/tipFrequency';
import { shouldShowMetric } from '../../packages/domain/swing/confidenceScore';
import SwingArtCard from '../../components/SwingArtCard';
import { positiveReinforcementEngine } from '../../lib/positiveReinforcement';
import type { ProcessSwingResult } from '../../lib/positiveReinforcement';
import { sessionAccumulator, type SessionInsight } from '../../lib/sessionAccumulator';
import { frameToLandmarks, pickKeyFrame, buildRawTips, METRIC_KEY_MAP } from '../../lib/coachingTips';
import type { GripClassification } from '../../lib/classifyGrip';

const GRIP_CHIP_COLORS: Record<string, { label: string; color: string }> = {
  solid:            { label: 'Solid',            color: '#00FF66' },
  playable:         { label: 'Playable',         color: '#FFB020' },
  needs_adjustment: { label: 'Needs Adjustment', color: '#FF4444' },
};

export default function ResultScreen() {
  const router = useRouter();
  const { swingId } = useLocalSearchParams<{ swingId?: string }>();
  const { width: screenW } = useWindowDimensions();
  const motion = getCurrentSwingMotion();
  const storedAnalysis = getCurrentSwingAnalysis();
  const videoUri = getCurrentSwingVideoUri();
  const [isLeftHanded, setIsLeftHanded] = useState(false);
  const [coachName, setCoachName] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [speed, setSpeed] = useState(0.25);
  const swingAddedRef = useRef(false);
  const [gripCloud, setGripCloud] = useState<GripClassification | null>(null);

  const player = useVideoPlayer(videoUri, (p) => {
    p.loop = true;
    p.playbackRate = 0.25;
    p.play();
  });

  useEffect(() => {
    if (player) player.playbackRate = speed;
  }, [speed, player]);

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
    supabase
      .from('swings')
      .select('swing_debug')
      .eq('id', swingId)
      .single()
      .then(({ data }) => {
        const gc = data?.swing_debug?.grip_cloud as GripClassification | undefined;
        if (gc && !gc.analysis_failed) setGripCloud(gc);
      });
  }, [swingId]);

  const classification: CaptureClassification | null = useMemo(
    () => (motion ? classifyCapture(motion.frames) : null),
    [motion],
  );

  const sequence: PoseSequence | null = useMemo(() => {
    if (!motion) return null;
    return {
      frames: motion.frames,
      source: motion.source,
      metadata: {
        durationMs:
          motion.frames.length > 1
            ? motion.frames[motion.frames.length - 1].timestampMs - motion.frames[0].timestampMs
            : 0,
      },
    };
  }, [motion]);

  const fallbackAnalysis: AnalysisResult | null = useMemo(() => {
    if (!sequence || classification?.validity === 'invalid' || storedAnalysis) return null;
    return analyzePoseSequence(sequence, isLeftHanded);
  }, [sequence, classification, storedAnalysis, isLeftHanded]);

  const analysis: AnalysisResult | null = storedAnalysis ?? fallbackAnalysis;
  const angles = analysis?.angles;
  const tempo = analysis?.tempo;

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
    () => (motion ? pickKeyFrame(motion.frames) : null),
    [motion],
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
        <Text style={styles.headerTitle}>Your Swing</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.container}>
        {!motion ? (
          <Text style={styles.emptyText}>No swing data available yet.</Text>
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
            {/* 2. Video */}
            {videoUri && player && (
              <View style={styles.videoSection}>
                <VideoView
                  player={player}
                  style={styles.videoPlayer}
                  nativeControls={false}
                />
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

            {/* 3. Score */}
            <View style={styles.scoreCard}>
              {isLowConfidence && (
                <Text style={styles.lowConfBadge}>Quick look — try a longer swing next time</Text>
              )}
              <Text style={styles.score}>{analysis?.score ?? 0}</Text>
              {analysis?.honeyBoom && (
                <Text style={styles.honeyBoom}>Honey Boom!</Text>
              )}
              {tempoLabel && (
                <Text style={styles.tempoSubLabel}>{tempoLabel}</Text>
              )}
            </View>

            {/* 4. Coaching */}
            {positiveResult.card ? (
              <View style={styles.positiveCard}>
                <Text style={styles.positiveCardText}>{positiveResult.card.message}</Text>
              </View>
            ) : sessionInsight ? (
              <View style={styles.sessionInsightCard}>
                <Text style={styles.sessionInsightText}>{sessionInsight.message}</Text>
              </View>
            ) : (
              keyLandmarks.length > 0 && (
                <VisualCoachCard
                  landmarks={keyLandmarks}
                  angles={angles}
                  width={skeletonW}
                  height={skeletonH}
                  isLowConfidence={isLowConfidence}
                  isLeftHanded={isLeftHanded}
                  suppressedMetrics={analysis?.swing_debug?.angle_gating?.suppressed}
                />
              )
            )}

            {/* 5. Coach */}
            {coachName && (
              <View style={styles.coachChip}>
                <Text style={styles.coachChipLabel}>Coach</Text>
                <Text style={styles.coachChipValue}>{coachName}</Text>
              </View>
            )}

            {/* 5b. Grip */}
            {gripCloud && GRIP_CHIP_COLORS[gripCloud.overall] && (
              <View style={styles.gripChip}>
                <Text style={styles.gripChipLabel}>Grip</Text>
                <Text style={[styles.gripChipValue, { color: GRIP_CHIP_COLORS[gripCloud.overall].color }]}>
                  {GRIP_CHIP_COLORS[gripCloud.overall].label}
                </Text>
              </View>
            )}

            {/* 6. CTA */}
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => router.back()}
              activeOpacity={0.7}
            >
              <Text style={styles.primaryButtonText}>Record Again</Text>
            </TouchableOpacity>

            {/* 7. Sign-in */}
            {limitHit && (
              <TouchableOpacity
                style={styles.signInPrompt}
                onPress={() => router.push('/signin' as Href)}
                activeOpacity={0.7}
              >
                <Text style={styles.signInPromptTitle}>Want to keep practicing?</Text>
                <Text style={styles.signInPromptText}>
                  Create a free account to save your swings and keep going.
                </Text>
                <Text style={styles.signInPromptCta}>Sign up free →</Text>
              </TouchableOpacity>
            )}

            {/* 8. Swing Art */}
            {classification?.validity === 'valid' && motion && (
              <View style={{ marginTop: 8 }}>
                <SwingArtCard
                  frames={motion.frames}
                  phases={analysis?.phases ?? []}
                  width={screenW - 48}
                />
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
