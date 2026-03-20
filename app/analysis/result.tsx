import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, SafeAreaView } from 'react-native';
import { useRouter } from 'expo-router';
import {
  getCurrentSwingMotion,
  getCurrentSwingAnalysis,
} from '../../lib/swingMotionStore';
import {
  analyzePoseSequence,
  type AnalysisResult,
} from '../../packages/domain/swing/analysisPipeline';
import type { PoseSequence } from '../../packages/pose/PoseTypes';
import {
  TEMPO_LABELS,
  type TempoRating,
} from '../../packages/domain/swing/tempoAnalysis';
import type { DetectedPhase } from '../../packages/domain/swing/phaseDetection';

const MIN_FRAMES_FOR_ANALYSIS = 6;
const MIN_FRAMES_FOR_TRUST = 20;
const MIN_NONNULL_ANGLES_FOR_TRUST = 4;

function formatNumber(value: number | null | undefined, digits: number = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'N/A';
}

function formatMs(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : 'N/A';
}

export default function ResultScreen() {
  const router = useRouter();
  const motion = getCurrentSwingMotion();
  const storedAnalysis = getCurrentSwingAnalysis();

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

  const readyForAnalysis = !!sequence && sequence.frames.length >= MIN_FRAMES_FOR_ANALYSIS;

  const fallbackAnalysis: AnalysisResult | null = useMemo(() => {
    if (!sequence || !readyForAnalysis || storedAnalysis) return null;
    return analyzePoseSequence(sequence);
  }, [sequence, readyForAnalysis, storedAnalysis]);

  const analysis: AnalysisResult | null = storedAnalysis ?? fallbackAnalysis;

  const phases = (analysis?.phases ?? []) as DetectedPhase[];
  const hasFallbackPhases = phases.some((phase) => phase.source === 'fallback');

  const nonNullAngleCount = [
    analysis?.angles?.spineAngle,
    analysis?.angles?.leftElbowAngle,
    analysis?.angles?.rightElbowAngle,
    analysis?.angles?.leftKneeAngle,
    analysis?.angles?.rightKneeAngle,
    analysis?.angles?.hipRotation,
    analysis?.angles?.shoulderTilt,
  ].filter((value) => typeof value === 'number' && Number.isFinite(value)).length;

  const isLowConfidenceCapture =
    !!motion &&
    (
      motion.frames.length < MIN_FRAMES_FOR_TRUST ||
      (!analysis?.tempo && nonNullAngleCount < 3)
    );

  const tempoRatingLabel =
    analysis?.tempo?.tempoRating
      ? TEMPO_LABELS[analysis.tempo.tempoRating as TempoRating]
      : 'N/A';

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
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => router.replace('/(tabs)/record')}
          activeOpacity={0.7}
        >
          <Text style={styles.primaryButtonText}>Record Again</Text>
        </TouchableOpacity>

        {!motion ? (
          <Text style={styles.emptyText}>No swing data available yet.</Text>
        ) : (
          <>
            {isLowConfidenceCapture ? (
              <View style={styles.warningCard}>
                <Text style={styles.warningTitle}>Low-confidence capture</Text>
                <Text style={styles.warningText}>
                  We captured some motion, but this swing does not look strong enough for a fully
                  trusted result. Try recording again with your full body in frame and complete the
                  entire swing inside the capture window.
                </Text>
              </View>
            ) : (
              <View style={styles.scoreCard}>
                <Text style={styles.scoreLabel}>Score</Text>
                <Text style={styles.score}>{analysis?.score ?? 0}</Text>
                {analysis?.honeyBoom && (
                  <Text style={styles.honeyBoom}>🍯 Honey Boom!</Text>
                )}
              </View>
            )}

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Capture Quality</Text>
              <Text style={styles.valueText}>Frames: {motion.frames.length}</Text>
              <Text style={styles.valueText}>
                Duration: {formatMs(sequence?.metadata?.durationMs)}
              </Text>
              <Text style={styles.valueText}>
                Phase detection: {hasFallbackPhases ? 'Fallback' : phases.length ? 'Heuristic' : 'None'}
              </Text>
              <Text style={styles.valueText}>
                Tempo available: {analysis?.tempo ? 'Yes' : 'No'}
              </Text>
              <Text style={styles.valueText}>
                Valid angle metrics: {nonNullAngleCount}
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Tempo</Text>
              <Text style={styles.valueText}>
                Ratio: {typeof analysis?.tempo?.tempoRatio === 'number' ? analysis.tempo.tempoRatio.toFixed(2) : 'N/A'}
              </Text>
              <Text style={styles.valueText}>
                Backswing: {formatMs(analysis?.tempo?.backswingMs)}
              </Text>
              <Text style={styles.valueText}>
                Downswing: {formatMs(analysis?.tempo?.downswingMs)}
              </Text>
              <Text style={styles.valueText}>Rating: {tempoRatingLabel}</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Angles</Text>
              <Text style={styles.valueText}>
                Spine: {formatNumber(analysis?.angles?.spineAngle)}°
              </Text>
              <Text style={styles.valueText}>
                Shoulder tilt: {formatNumber(analysis?.angles?.shoulderTilt)}°
              </Text>
              <Text style={styles.valueText}>
                Left elbow: {formatNumber(analysis?.angles?.leftElbowAngle)}°
              </Text>
              <Text style={styles.valueText}>
                Right elbow: {formatNumber(analysis?.angles?.rightElbowAngle)}°
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Phases</Text>
              {phases.length ? (
                phases.map((phase: DetectedPhase, index: number) => (
                  <Text key={`${phase.phase}-${index}`} style={styles.phaseText}>
                    {phase.label}: {Math.round(phase.timestamp)} ms ({phase.source})
                  </Text>
                ))
              ) : (
                <Text style={styles.valueText}>No phases detected.</Text>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#111111' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#111111',
  },
  backButton: { padding: 8 },
  backButtonText: { color: '#F5A623', fontSize: 16, fontWeight: '600' },
  headerTitle: { color: '#F5A623', fontSize: 18, fontWeight: '700' },
  headerSpacer: { width: 60 },
  container: { flexGrow: 1, padding: 24, paddingTop: 8 },
  primaryButton: {
    backgroundColor: '#F5A623',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 20,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#111111', fontSize: 16, fontWeight: '700' },
  scoreCard: {
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    padding: 24,
    marginBottom: 16,
    alignItems: 'center',
  },
  warningCard: {
    backgroundColor: '#2A1F12',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#F5A623',
  },
  warningTitle: {
    color: '#F5A623',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
  },
  warningText: {
    color: '#FFFFFF',
    fontSize: 15,
    lineHeight: 22,
  },
  scoreLabel: { color: '#F5A623', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  score: { color: '#FFFFFF', fontSize: 64, fontWeight: '700' },
  honeyBoom: { color: '#F5A623', fontSize: 20, fontWeight: '700', marginTop: 8 },
  card: { backgroundColor: '#1C1C1E', borderRadius: 16, padding: 16, marginBottom: 16 },
  cardTitle: { color: '#F5A623', fontSize: 20, fontWeight: '700', marginBottom: 12 },
  valueText: { color: '#FFFFFF', fontSize: 16, marginBottom: 8 },
  phaseText: { color: '#D0D0D0', fontSize: 14, marginBottom: 6 },
  emptyText: { color: '#FFFFFF', fontSize: 16, textAlign: 'center', marginTop: 40 },
});
