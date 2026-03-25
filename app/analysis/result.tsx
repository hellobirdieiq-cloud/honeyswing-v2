import { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, type Href } from 'expo-router';
import {
  getCurrentSwingMotion,
  getCurrentSwingAnalysis,
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
import type { GolfAngles } from '../../packages/domain/swing/angles';
import type { Landmark } from '../../components/SkeletonOverlay';
import VisualCoachCard from '../../components/VisualCoachCard';
import { classifyCapture, type CaptureClassification } from '../../lib/captureValidity';
import { getIsLeftHanded } from '../../lib/handedness';
import type { DetectedPhase } from '../../packages/domain/swing/phaseDetection';
import SwingArtCard from '../../components/SwingArtCard';

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

export default function ResultScreen() {
  const router = useRouter();
  const { width: screenW } = useWindowDimensions();
  const motion = getCurrentSwingMotion();
  const storedAnalysis = getCurrentSwingAnalysis();
  const [isLeftHanded, setIsLeftHanded] = useState(false);
  const [limitHit, setLimitHit] = useState(false);

  useEffect(() => {
    getIsLeftHanded().then(setIsLeftHanded);
    // Check swing limit after this swing was persisted
    checkSwingLimit().then((status) => {
      if (!status.allowed) {
        getUser().then((user) => {
          if (!user) setLimitHit(true);
        });
      }
    });
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
    return analyzePoseSequence(sequence);
  }, [sequence, classification, storedAnalysis]);

  const analysis: AnalysisResult | null = storedAnalysis ?? fallbackAnalysis;
  const angles = analysis?.angles as GolfAngles | undefined;
  const tempo = analysis?.tempo;

  const isLowConfidence = classification?.validity === 'partial';

  // Persist the weakest metric as "Today's Focus" for the home screen
  useEffect(() => {
    if (!angles) return;
    const focus = computeFocus(angles, isLeftHanded);
    if (focus) saveFocus(focus);
  }, [angles, isLeftHanded]);

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
            <Text style={styles.invalidTitle}>Couldn't clearly capture your swing</Text>
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
            {/* 1. Score — dominant, with breathing room */}
            <View style={styles.scoreCard}>
              {isLowConfidence && (
                <Text style={styles.lowConfBadge}>Quick look — try a longer swing next time</Text>
              )}
              <Text style={styles.score}>{analysis?.score ?? 0}</Text>
              {analysis?.honeyBoom && (
                <Text style={styles.honeyBoom}>Honey Boom!</Text>
              )}
            </View>

            {/* 2. Visual Coach — ONE issue, skeleton + coaching cue */}
            {keyLandmarks.length > 0 && (
              <VisualCoachCard
                landmarks={keyLandmarks}
                angles={angles}
                width={skeletonW}
                height={skeletonH}
                isLowConfidence={isLowConfidence}
                isLeftHanded={isLeftHanded}
              />
            )}

            {/* 3. Tempo — simplified to rating only */}
            {tempo && (
              <View style={styles.tempoChip}>
                <Text style={styles.tempoChipLabel}>Tempo</Text>
                <Text style={[styles.tempoChipValue, { color: tempoColor }]}>
                  {tempoLabel}
                </Text>
              </View>
            )}

            {/* 4. Record Again CTA */}
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => router.back()}
              activeOpacity={0.7}
            >
              <Text style={styles.primaryButtonText}>Record Again</Text>
            </TouchableOpacity>

            {/* 4b. Swing limit — prompt sign-in */}
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

            {/* 5. Swing Art — valid captures only */}
            {classification?.validity === 'valid' && motion && (
              <SwingArtCard
                frames={motion.frames}
                phases={(analysis?.phases ?? []) as DetectedPhase[]}
                width={screenW - 48}
              />
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
    marginBottom: 16,
    paddingVertical: 28,
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

  // Sign-in prompt
  signInPrompt: {
    backgroundColor: '#1A1A1C',
    borderRadius: 14,
    padding: 20,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(245, 166, 35, 0.2)',
  },
  signInPromptTitle: {
    color: '#F5A623',
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

});
