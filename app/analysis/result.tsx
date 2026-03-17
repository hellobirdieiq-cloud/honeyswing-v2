import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
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
    if (!motion) {
      return null;
    }

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
    if (!sequence || !readyForAnalysis || storedAnalysis) {
      return null;
    }

    return analyzePoseSequence(sequence);
  }, [sequence, readyForAnalysis, storedAnalysis]);

  const analysis: AnalysisResult | null = storedAnalysis ?? fallbackAnalysis;

  const tempoRatingLabel =
    analysis?.tempo?.tempoRating
      ? TEMPO_LABELS[analysis.tempo.tempoRating as TempoRating]
      : 'N/A';

  const analysisSource =
    storedAnalysis ? 'shared-store' : fallbackAnalysis ? 'local-fallback' : 'none';

  function goToRecord() {
    router.replace('/(tabs)/record');
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Result</Text>

      <Pressable style={styles.primaryButton} onPress={goToRecord}>
        <Text style={styles.primaryButtonText}>Record Again</Text>
      </Pressable>

      {!motion ? (
        <Text style={styles.emptyText}>No swing data available yet.</Text>
      ) : (
        <>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Swing Summary</Text>
            <Text style={styles.valueText}>Source: {motion.source}</Text>
            <Text style={styles.valueText}>Frames: {motion.frames.length}</Text>
            <Text style={styles.valueText}>
              Duration:{' '}
              {sequence?.metadata?.durationMs != null
                ? `${Math.round(sequence.metadata.durationMs)} ms`
                : 'N/A'}
            </Text>
            <Text style={styles.valueText}>Analysis source: {analysisSource}</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Score</Text>
            <Text style={styles.score}>{analysis?.score ?? 0}</Text>
            <Text style={styles.valueText}>
              Honey Boom: {analysis?.honeyBoom ? 'Yes' : 'No'}
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Tempo</Text>
            <Text style={styles.valueText}>
              Tempo ratio:{' '}
              {typeof analysis?.tempo?.tempoRatio === 'number'
                ? analysis.tempo.tempoRatio.toFixed(2)
                : 'N/A'}
            </Text>
            <Text style={styles.valueText}>
              Backswing: {formatMs(analysis?.tempo?.backswingMs)}
            </Text>
            <Text style={styles.valueText}>
              Downswing: {formatMs(analysis?.tempo?.downswingMs)}
            </Text>
            <Text style={styles.valueText}>
              Total swing: {formatMs(analysis?.tempo?.totalSwingMs)}
            </Text>
            <Text style={styles.valueText}>Tempo rating: {tempoRatingLabel}</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Angles</Text>
            <Text style={styles.valueText}>
              Spine angle: {formatNumber(analysis?.angles?.spineAngle)}
            </Text>
            <Text style={styles.valueText}>
              Shoulder tilt: {formatNumber(analysis?.angles?.shoulderTilt)}
            </Text>
            <Text style={styles.valueText}>
              Left elbow: {formatNumber(analysis?.angles?.leftElbowAngle)}
            </Text>
            <Text style={styles.valueText}>
              Right elbow: {formatNumber(analysis?.angles?.rightElbowAngle)}
            </Text>
            <Text style={styles.valueText}>
              Left knee: {formatNumber(analysis?.angles?.leftKneeAngle)}
            </Text>
            <Text style={styles.valueText}>
              Right knee: {formatNumber(analysis?.angles?.rightKneeAngle)}
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Phases</Text>
            {analysis?.phases?.length ? (
              analysis.phases.map((phase: DetectedPhase, index: number) => (
                <Text key={`${phase.phase}-${index}`} style={styles.phaseText}>
                  {phase.label}: {Math.round(phase.timestamp)} ms ({phase.source})
                </Text>
              ))
            ) : (
              <Text style={styles.valueText}>No phases available yet.</Text>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#111111',
    padding: 24,
  },
  title: {
    color: '#F5A623',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 16,
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: '#F5A623',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 20,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#111111',
    fontSize: 16,
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  cardTitle: {
    color: '#F5A623',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 12,
  },
  score: {
    color: '#FFFFFF',
    fontSize: 42,
    fontWeight: '700',
    marginBottom: 8,
  },
  valueText: {
    color: '#FFFFFF',
    fontSize: 16,
    marginBottom: 8,
  },
  phaseText: {
    color: '#D0D0D0',
    fontSize: 14,
    marginBottom: 6,
  },
  emptyText: {
    color: '#FFFFFF',
    fontSize: 16,
    textAlign: 'center',
    marginTop: 40,
  },
});
