import { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, type Href } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import {
  getCurrentSwingMotion,
  getCurrentSwingAnalysis,
  getCurrentSwingVideoUri,
  computeFocus,
  saveFocus,
} from '../../lib/swingMotionStore';
import { checkSwingLimit } from '../../lib/swingLimit';
import { getUser } from '../../lib/supabase';
import {
  analyzePoseSequence,
  type AnalysisResult,
} from '../../packages/domain/swing/analysisPipeline';
import type { PoseFrame, PoseSequence } from '../../packages/pose/PoseTypes';
import {
  TEMPO_LABELS,
  TEMPO_COLORS,
  type TempoRating,
} from '../../packages/domain/swing/tempoAnalysis';
import type { Landmark } from '../../components/SkeletonOverlay';
import VisualCoachCard from '../../components/VisualCoachCard';
import { classifyCapture, type CaptureClassification } from '../../lib/captureValidity';
import { getIsLeftHanded } from '../../lib/handedness';
import { getCoachCode, resolveCoachName } from '../../lib/coachCode';
import { processSwingTips, type RawCoachingTip, type ProcessedCoachingTip } from '../../lib/tipFrequency';
import { shouldShowMetric } from '../../packages/domain/swing/confidenceScore';
import type { ScoringBreakdownEntry } from '../../packages/domain/swing/scoring';
import SwingArtCard from '../../components/SwingArtCard';
import { positiveReinforcementEngine } from '../../lib/positiveReinforcement';
import type { ProcessSwingResult } from '../../lib/positiveReinforcement';
import { sessionAccumulator, type SessionInsight } from '../../lib/sessionAccumulator';
import { getCachedAgeTier, type AgeTier } from '../../lib/ageTier';

/** Convert a PoseFrame's joints into the Landmark[] format SkeletonOverlay expects. */
function frameToLandmarks(frame: PoseFrame): Landmark[] {
  const landmarks: Landmark[] = [];
  for (const joint of Object.values(frame.joints)) {
    if (!joint) continue;
    landmarks.push({
      name: joint.name,
      x: joint.x,
      y: joint.y,
      inFrameLikelihood: joint.confidence ?? 0,
    });
  }
  return landmarks;
}

/** Pick the frame with the most high-confidence joints. */
function pickKeyFrame(frames: PoseFrame[]): PoseFrame {
  let best = frames[Math.floor(frames.length / 2)];
  let bestCount = 0;
  for (const frame of frames) {
    let count = 0;
    for (const joint of Object.values(frame.joints)) {
      if (joint && (joint.confidence ?? 0) >= 0.3) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = frame;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Tip adapter: scoring breakdown → RawCoachingTip[]
// ---------------------------------------------------------------------------

const TIP_SCORE_THRESHOLD = 80;

/** Mapping from scoring metric names to tipFrequency metricKeys */
const METRIC_KEY_MAP: Record<string, string> = {
  spineAngle: 'spineAngle',
  leftElbowAngle: 'elbow',
  rightElbowAngle: 'elbow',
  leftKneeAngle: 'kneeFlex',
  rightKneeAngle: 'kneeFlex',
  shoulderTilt: 'shoulderTilt',
  tempo: 'tempo',
};

/** Static coaching text keyed by scoring metric name. juniorBody for ages 6-8. */
const COACHING_TEXT: Record<string, { title: string; body: string; juniorBody?: string }> = {
  spineAngle: {
    title: 'Spine Tilt',
    body: 'Check your spine angle at address — aim for an athletic tilt, not too upright or hunched.',
    juniorBody: 'Stand tall like an athlete',
  },
  leftElbowAngle: {
    title: 'Lead Arm',
    body: 'Keep your lead arm straighter through the swing for better extension.',
    juniorBody: 'Try keeping your front arm straight',
  },
  rightElbowAngle: {
    title: 'Trail Arm',
    body: 'Let your trail arm fold naturally at the top and extend through impact.',
    juniorBody: 'Let your back arm bend and stretch',
  },
  leftKneeAngle: {
    title: 'Lead Knee',
    body: 'Check your lead knee flex at setup — stay athletic, not locked or crouched.',
    juniorBody: 'Bend your front knee a little',
  },
  rightKneeAngle: {
    title: 'Trail Knee',
    body: 'Soften your trail knee at address to help your rotation.',
    juniorBody: 'Keep your back knee soft',
  },
  shoulderTilt: {
    title: 'Shoulders',
    body: 'Work on leveling your shoulders at address for a more consistent swing.',
    juniorBody: 'Keep your shoulders more level',
  },
  tempo: {
    title: 'Tempo',
    body: 'Smooth out your tempo — aim for a controlled backswing and accelerating downswing.',
    juniorBody: 'Nice and slow going back',
  },
};

/**
 * Convert scoring breakdown entries into RawCoachingTip[].
 * Pre-filters to score < TIP_SCORE_THRESHOLD. Deduplicates mapped keys
 * (e.g. leftElbowAngle + rightElbowAngle both map to 'elbow') by keeping
 * the worse-scoring entry.
 */
function buildRawTips(breakdown: ScoringBreakdownEntry[], ageTier: AgeTier): RawCoachingTip[] {
  // Collect worst score per mapped metricKey
  const best: Map<string, { scoringMetric: string; score: number }> = new Map();

  for (const entry of breakdown) {
    if (entry.score >= TIP_SCORE_THRESHOLD) continue;
    const mappedKey = METRIC_KEY_MAP[entry.metric];
    if (!mappedKey) continue;
    const text = COACHING_TEXT[entry.metric];
    if (!text) continue;

    const existing = best.get(mappedKey);
    if (!existing || entry.score < existing.score) {
      best.set(mappedKey, { scoringMetric: entry.metric, score: entry.score });
    }
  }

  const useJunior = ageTier === 'junior';
  const tips: RawCoachingTip[] = [];
  for (const [mappedKey, { scoringMetric }] of best) {
    const text = COACHING_TEXT[scoringMetric]!;
    tips.push({
      metricKey: mappedKey,
      title: text.title,
      body: useJunior && text.juniorBody ? text.juniorBody : text.body,
      shortBody: useJunior && text.juniorBody ? text.juniorBody : '',
    });
  }
  return tips;
}

export default function ResultScreen() {
  const router = useRouter();
  const { width: screenW } = useWindowDimensions();
  const motion = getCurrentSwingMotion();
  const storedAnalysis = getCurrentSwingAnalysis();
  const videoUri = getCurrentSwingVideoUri();
  const [isLeftHanded, setIsLeftHanded] = useState(false);
  const [coachName, setCoachName] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [speed, setSpeed] = useState(0.25);


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
    getCoachCode().then((code) => setCoachName(resolveCoachName(code))).catch((err) => console.error('[HoneySwing]', err));

    // Check swing limit after this swing was persisted
    checkSwingLimit().then((status) => {
      if (!status.allowed) {
        getUser().then((user) => {
          if (!user) setLimitHit(true);
        }).catch((err) => console.error('[HoneySwing]', err));
      }
    }).catch((err) => console.error('[HoneySwing]', err));
  }, []);

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
    const ageTier = getCachedAgeTier();
    const breakdown = analysis.swing_debug?.scoring_breakdown;
    if (!breakdown) return { processedTips: [], positiveResult: { card: null, improvements: [] } };
    const rawTips = buildRawTips(breakdown, ageTier);
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

  // Task 14: Session accumulator — feed swing data and compute insight
  const sessionInsight = useMemo<SessionInsight | null>(() => {
    if (!analysis) return null;
    const firedMetricKeys = processedTips.map(t => t.metricKey);
    sessionAccumulator.addSwing(analysis, firedMetricKeys);

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

  // Metro log for verification before tip UI exists
  useEffect(() => {
    if (processedTips.length > 0) {
      console.log('[tipFrequency]', processedTips.map(t => `${t.metricKey}:${t.displayTier}`));
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
  const tempoColor = tempoRating ? TEMPO_COLORS[tempoRating] : '#999';

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

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#111' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backButton: { padding: 8 },
  backButtonText: { color: '#CCCCCC', fontSize: 16, fontWeight: '600' },
  headerTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  headerSpacer: { width: 60 },
  container: { flexGrow: 1, padding: 24, paddingTop: 0 },
  emptyText: { color: '#fff', fontSize: 16, textAlign: 'center', marginTop: 40 },

  // Invalid capture
  invalidContainer: {
    alignItems: 'center',
    paddingTop: 60,
  },
  invalidTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  invalidHint: {
    color: '#999',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 32,
    paddingHorizontal: 16,
  },

  // Video replay
  videoSection: {
    marginBottom: 20,
    alignItems: 'center',
  },
  videoPlayer: {
    width: '100%',
    aspectRatio: 9 / 16,
    borderRadius: 12,
    overflow: 'hidden',
  },
  speedRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  speedButton: {
    backgroundColor: '#1A1A1C',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  speedButtonActive: {
    backgroundColor: '#F5A623',
  },
  speedButtonText: {
    color: '#999',
    fontSize: 14,
    fontWeight: '600',
  },
  speedButtonTextActive: {
    color: '#111',
  },

  // Score
  scoreCard: {
    alignItems: 'center',
    marginBottom: 20,
    paddingVertical: 28,
  },
  lowConfBadge: {
    color: '#AAAAAA',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  score: {
    color: '#fff',
    fontSize: 96,
    fontWeight: '800',
    lineHeight: 104,
  },
  honeyBoom: {
    color: '#F5A623',
    fontSize: 22,
    fontWeight: '700',
    marginTop: 4,
  },
  tempoSubLabel: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 6,
  },

  // Tempo chip
  tempoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1A1A1C',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    marginBottom: 16,
  },
  tempoChipLabel: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
  },
  tempoChipValue: {
    fontSize: 17,
    fontWeight: '700',
  },

  // Coach chip
  coachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1A1A1C',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    marginBottom: 16,
  },
  coachChipLabel: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
  },
  coachChipValue: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },

  // CTA
  primaryButton: {
    backgroundColor: '#F5A623',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 12,
  },
  primaryButtonText: {
    color: '#111',
    fontSize: 18,
    fontWeight: '700',
  },

  // Sign-in prompt
  signInPrompt: {
    backgroundColor: '#1A1A1C',
    borderRadius: 14,
    padding: 20,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  signInPromptTitle: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  signInPromptText: {
    color: '#999',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 10,
  },
  signInPromptCta: {
    color: '#F5A623',
    fontSize: 15,
    fontWeight: '600',
  },

  // Positive reinforcement card
  positiveCard: {
    backgroundColor: '#1a472a',
    borderWidth: 1,
    borderColor: '#c8a951',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    alignItems: 'center' as const,
  },
  positiveCardText: {
    color: '#c8a951',
    fontSize: 24,
    fontWeight: '700' as const,
    textAlign: 'center' as const,
  },
  sessionInsightCard: {
    backgroundColor: '#1a2a3a',
    borderWidth: 1,
    borderColor: '#5b9bd5',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    alignItems: 'center' as const,
  },
  sessionInsightText: {
    color: '#b8d4f0',
    fontSize: 18,
    fontWeight: '600' as const,
    textAlign: 'center' as const,
  },

});
