import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, SafeAreaView, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import {
  getCurrentSwingMotion,
  getCurrentSwingAnalysis,
} from '../../lib/swingMotionStore';
import {
  analyzePoseSequence,
  type AnalysisResult,
} from '../../packages/domain/swing/analysisPipeline';
import type { PoseFrame, PoseSequence, NormalizedJoint } from '../../packages/pose/PoseTypes';
import {
  TEMPO_LABELS,
  TEMPO_COLORS,
  type TempoRating,
} from '../../packages/domain/swing/tempoAnalysis';
import type { DetectedPhase } from '../../packages/domain/swing/phaseDetection';
import type { GolfAngles } from '../../packages/domain/swing/angles';
import type { Landmark } from '../../components/SkeletonOverlay';
import VisualCoachCard from '../../components/VisualCoachCard';
import { classifyCapture, type CaptureClassification } from '../../lib/captureValidity';

function formatDeg(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}°` : '—';
}

function formatMs(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
}

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

/** Generate a single coaching cue from the analysis. */
function getCoachingCue(analysis: AnalysisResult): string {
  const angles = analysis.angles as GolfAngles | undefined;
  const tempo = analysis.tempo;

  // Check tempo first — most actionable
  if (tempo?.tempoRating === 'rushed') return 'Slow down your backswing for better control.';
  if (tempo?.tempoRating === 'very_slow') return 'Speed up your transition for more power.';

  // Check key angles
  if (angles?.spineAngle != null && angles.spineAngle > 50)
    return 'Keep your spine more upright at address.';
  if (angles?.spineAngle != null && angles.spineAngle < 15)
    return 'Add a bit more forward tilt in your stance.';

  if (angles?.leftElbowAngle != null && angles.leftElbowAngle < 130)
    return 'Try to keep your lead arm straighter through the swing.';

  if (angles?.shoulderTilt != null && Math.abs(angles.shoulderTilt) > 20)
    return 'Level your shoulders more at address.';

  if (tempo?.tempoRating === 'fast') return 'Slightly slower backswing could improve consistency.';
  if (tempo?.tempoRating === 'slow') return 'A quicker transition could add distance.';

  if (analysis.score >= 85) return 'Great swing! Keep that tempo consistent.';
  if (analysis.score >= 70) return 'Solid form. Focus on repeating this tempo.';
  return 'Focus on a smooth, complete backswing.';
}

export default function ResultScreen() {
  const router = useRouter();
  const { width: screenW } = useWindowDimensions();
  const motion = getCurrentSwingMotion();
  const storedAnalysis = getCurrentSwingAnalysis();

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
    return analyzePoseSequence(sequence);
  }, [sequence, classification, storedAnalysis]);

  const analysis: AnalysisResult | null = storedAnalysis ?? fallbackAnalysis;
  const angles = analysis?.angles as GolfAngles | undefined;
  const tempo = analysis?.tempo;
  const phases = (analysis?.phases ?? []) as DetectedPhase[];

  const isLowConfidence = classification?.validity === 'partial';

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

  const coachingCue = analysis ? getCoachingCue(analysis) : null;

  // Skeleton preview dimensions — wide card, 4:3 aspect
  const skeletonW = screenW - 48;
  const skeletonH = Math.round(skeletonW * (4 / 3));

  // Collect detected angles for display
  const angleEntries: { label: string; value: string }[] = [];
  if (angles) {
    if (angles.spineAngle != null) angleEntries.push({ label: 'Spine tilt', value: formatDeg(angles.spineAngle) });
    if (angles.shoulderTilt != null) angleEntries.push({ label: 'Shoulder tilt', value: formatDeg(angles.shoulderTilt) });
    if (angles.leftElbowAngle != null) angleEntries.push({ label: 'Lead elbow', value: formatDeg(angles.leftElbowAngle) });
    if (angles.rightElbowAngle != null) angleEntries.push({ label: 'Trail elbow', value: formatDeg(angles.rightElbowAngle) });
    if (angles.leftKneeAngle != null) angleEntries.push({ label: 'Lead knee', value: formatDeg(angles.leftKneeAngle) });
    if (angles.rightKneeAngle != null) angleEntries.push({ label: 'Trail knee', value: formatDeg(angles.rightKneeAngle) });
    if (angles.hipRotation != null) angleEntries.push({ label: 'Hip rotation', value: `${angles.hipRotation}` });
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Result</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.container}>
        {!motion ? (
          <Text style={styles.emptyText}>No swing data available yet.</Text>
        ) : classification?.validity === 'invalid' ? (
          <View style={styles.invalidContainer}>
            <Text style={styles.invalidTitle}>Couldn't capture your swing clearly</Text>
            {classification.reason && (
              <Text style={styles.invalidReason}>{classification.reason}</Text>
            )}
            <Text style={styles.invalidHint}>
              Make sure your full body is visible and you complete the swing during the capture window.
            </Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => router.replace('/(tabs)/record')}
              activeOpacity={0.7}
            >
              <Text style={styles.primaryButtonText}>Record Again</Text>
            </TouchableOpacity>
            <Text style={styles.debugText}>
              {classification.frameCount} frames · {classification.goodFrameCount} good · {Math.round(classification.poseSuccessRate * 100)}% detection
            </Text>
          </View>
        ) : (
          <>
            {/* 1. Score — dominant element */}
            <View style={styles.scoreCard}>
              {isLowConfidence && (
                <Text style={styles.lowConfBadge}>Low confidence</Text>
              )}
              <Text style={styles.score}>{analysis?.score ?? 0}</Text>
              {analysis?.honeyBoom && (
                <Text style={styles.honeyBoom}>Honey Boom!</Text>
              )}
            </View>

            {/* 2. Coaching cue */}
            {coachingCue && (
              <Text style={styles.coachingCue}>{coachingCue}</Text>
            )}

            {/* 3. Tempo */}
            {tempo && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Tempo</Text>
                <View style={styles.tempoRow}>
                  <Text style={[styles.tempoRating, { color: tempoColor }]}>
                    {tempoLabel}
                  </Text>
                  <Text style={styles.tempoRatio}>
                    {tempo.tempoRatio.toFixed(2)} : 1
                  </Text>
                </View>
                <View style={styles.tempoDetails}>
                  <Text style={styles.tempoDetail}>Backswing {formatMs(tempo.backswingMs)}</Text>
                  <Text style={styles.tempoDetailSep}>·</Text>
                  <Text style={styles.tempoDetail}>Downswing {formatMs(tempo.downswingMs)}</Text>
                </View>
              </View>
            )}

            {/* 4. Key angles */}
            {angleEntries.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Key Angles</Text>
                <View style={styles.anglesGrid}>
                  {angleEntries.map((entry) => (
                    <View key={entry.label} style={styles.angleItem}>
                      <Text style={styles.angleValue}>{entry.value}</Text>
                      <Text style={styles.angleLabel}>{entry.label}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* 5. Visual Coach — skeleton with highlighted issue */}
            {keyLandmarks.length > 0 && (
              <VisualCoachCard
                landmarks={keyLandmarks}
                angles={angles}
                width={skeletonW}
                height={skeletonH}
                isLowConfidence={isLowConfidence}
              />
            )}

            {/* 6. Record Again CTA */}
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => router.replace('/(tabs)/record')}
              activeOpacity={0.7}
            >
              <Text style={styles.primaryButtonText}>Record Again</Text>
            </TouchableOpacity>

            {/* Debug info */}
            <Text style={styles.debugText}>
              {classification?.frameCount ?? 0} frames · {Math.round((classification?.poseSuccessRate ?? 0) * 100)}% detection · {angleEntries.length}/7 angles · {classification?.validity}
            </Text>
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
  backButtonText: { color: '#F5A623', fontSize: 16, fontWeight: '600' },
  headerTitle: { color: '#F5A623', fontSize: 18, fontWeight: '700' },
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
  invalidReason: {
    color: '#F5A623',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 8,
  },
  invalidHint: {
    color: '#999',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 32,
    paddingHorizontal: 16,
  },

  // Score
  scoreCard: {
    alignItems: 'center',
    marginBottom: 8,
    paddingVertical: 24,
  },
  lowConfBadge: {
    color: '#F5A623',
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

  // Coaching
  coachingCue: {
    color: '#ccc',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },

  // Cards
  card: {
    backgroundColor: '#1A1A1C',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: {
    color: '#F5A623',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 10,
  },

  // Tempo
  tempoRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  tempoRating: {
    fontSize: 20,
    fontWeight: '700',
  },
  tempoRatio: {
    color: '#999',
    fontSize: 16,
    fontWeight: '500',
  },
  tempoDetails: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  tempoDetail: {
    color: '#999',
    fontSize: 13,
  },
  tempoDetailSep: {
    color: '#555',
    fontSize: 13,
    marginHorizontal: 8,
  },

  // Angles
  anglesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  angleItem: {
    width: '50%',
    marginBottom: 10,
  },
  angleValue: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  angleLabel: {
    color: '#999',
    fontSize: 12,
    marginTop: 1,
  },

  // CTA
  primaryButton: {
    backgroundColor: '#F5A623',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  primaryButtonText: {
    color: '#111',
    fontSize: 18,
    fontWeight: '700',
  },

  // Debug
  debugText: {
    color: '#555',
    fontSize: 11,
    textAlign: 'center',
    marginBottom: 24,
  },
});
