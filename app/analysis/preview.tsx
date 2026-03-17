import { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import {
  getCurrentSwingMotion,
  getCurrentSwingAnalysis,
} from '../../lib/swingMotionStore';
import {
  analyzePoseSequence,
  type AnalysisResult,
} from '../../packages/domain/swing/analysisPipeline';
import { PoseSequence } from '../../packages/pose/PoseTypes';
import {
  TEMPO_LABELS,
  type TempoRating,
} from '../../packages/domain/swing/tempoAnalysis';
import { type DetectedPhase } from '../../packages/domain/swing/phaseDetection';

const MIN_FRAMES_FOR_ANALYSIS = 6;

function formatNumber(value: number | null | undefined, digits: number = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'N/A';
}

function formatMs(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : 'N/A';
}

export default function Preview() {
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

  const firstPhaseSource =
    analysis?.phases && analysis.phases.length > 0 ? analysis.phases[0].source : 'N/A';

  const tempoRatingLabel =
    analysis?.tempo?.tempoRating
      ? TEMPO_LABELS[analysis.tempo.tempoRating as TempoRating]
      : 'N/A';

  const analysisOrigin = storedAnalysis ? 'shared-store' : fallbackAnalysis ? 'local-fallback' : 'none';

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Preview</Text>

      {!motion ? (
        <Text style={styles.text}>No live swing data buffered yet.</Text>
      ) : (
        <>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Buffered Motion</Text>
            <Text style={styles.text}>Source: {motion.source}</Text>
            <Text style={styles.text}>Buffered frames: {motion.frames.length}</Text>
            <Text style={styles.text}>
              Recorded at: {new Date(motion.recordedAt).toLocaleTimeString()}
            </Text>
            <Text style={styles.text}>
              Duration:{' '}
              {sequence?.metadata?.durationMs != null
                ? `${Math.round(sequence.metadata.durationMs)} ms`
                : 'N/A'}
            </Text>
            <Text style={styles.text}>
              Analysis ready: {readyForAnalysis ? 'Yes' : `No (need ${MIN_FRAMES_FOR_ANALYSIS}+ frames)`}
            </Text>
            <Text style={styles.text}>Analysis source: {analysisOrigin}</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Analysis</Text>
            <Text style={styles.text}>Score: {analysis?.score ?? 0}</Text>
            <Text style={styles.text}>Honey Boom: {analysis?.honeyBoom ? 'Yes' : 'No'}</Text>
            <Text style={styles.text}>Phases detected: {analysis?.phases?.length ?? 0}</Text>
            <Text style={styles.text}>Phase source: {firstPhaseSource}</Text>
            <Text style={styles.text}>
              Tempo ratio:{' '}
              {typeof analysis?.tempo?.tempoRatio === 'number'
                ? analysis.tempo.tempoRatio.toFixed(2)
                : 'N/A'}
            </Text>
            <Text style={styles.text}>Backswing: {formatMs(analysis?.tempo?.backswingMs)}</Text>
            <Text style={styles.text}>Downswing: {formatMs(analysis?.tempo?.downswingMs)}</Text>
            <Text style={styles.text}>Total swing: {formatMs(analysis?.tempo?.totalSwingMs)}</Text>
            <Text style={styles.text}>Tempo rating: {tempoRatingLabel}</Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Angles</Text>
            <Text style={styles.text}>
              Spine angle: {formatNumber(analysis?.angles?.spineAngle)}
            </Text>
            <Text style={styles.text}>
              Shoulder tilt: {formatNumber(analysis?.angles?.shoulderTilt)}
            </Text>
            <Text style={styles.text}>
              Left elbow: {formatNumber(analysis?.angles?.leftElbowAngle)}
            </Text>
            <Text style={styles.text}>
              Right elbow: {formatNumber(analysis?.angles?.rightElbowAngle)}
            </Text>
            <Text style={styles.text}>
              Left knee: {formatNumber(analysis?.angles?.leftKneeAngle)}
            </Text>
            <Text style={styles.text}>
              Right knee: {formatNumber(analysis?.angles?.rightKneeAngle)}
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Phases</Text>
            {analysis?.phases?.length ? (
              analysis.phases.map((phase: DetectedPhase, index: number) => (
                <Text key={`${phase.phase}-${index}`} style={styles.phaseText}>
                  {phase.label}: {Math.round(phase.timestamp)} ms ({phase.source})
                </Text>
              ))
            ) : (
              <Text style={styles.text}>No phases available yet.</Text>
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
    backgroundColor: '#111',
    padding: 24,
    alignItems: 'center',
  },
  title: {
    color: '#F5A623',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 16,
  },
  section: {
    width: '100%',
    marginTop: 20,
    alignItems: 'center',
  },
  sectionTitle: {
    color: '#F5A623',
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 12,
  },
  text: {
    color: '#fff',
    fontSize: 16,
    marginBottom: 8,
    textAlign: 'center',
  },
  phaseText: {
    color: '#ccc',
    fontSize: 14,
    marginBottom: 4,
    textAlign: 'center',
  },
});