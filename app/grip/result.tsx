import { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, type Href } from 'expo-router';
import { getGrip } from '../../lib/gripStore';
import {
  classifyGrip,
  GripClassifyError,
  type GripClassification,
  type GripError,
} from '../../lib/classifyGrip';

type ResultState =
  | { status: 'loading' }
  | { status: 'success'; data: GripClassification }
  | { status: 'error'; errorType: GripError };

const OVERALL_LABELS: Record<string, { label: string; color: string }> = {
  solid: { label: 'Solid', color: '#00FF66' },
  playable: { label: 'Playable', color: '#FFB020' },
  needs_adjustment: { label: 'Needs Adjustment', color: '#FF4444' },
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: '#00FF66',
  medium: '#FFB020',
  low: '#FF4444',
};

export default function GripResultScreen() {
  const router = useRouter();
  const [state, setState] = useState<ResultState>({ status: 'loading' });

  useEffect(() => {
    const grip = getGrip();
    if (!grip) {
      setState({ status: 'error', errorType: 'server' });
      return;
    }

    classifyGrip(grip.photoUri)
      .then((data) => setState({ status: 'success', data }))
      .catch((err) => {
        const errorType: GripError =
          err instanceof GripClassifyError ? err.type : 'server';
        setState({ status: 'error', errorType });
      });
  }, []);

  const isLoading = state.status === 'loading';

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Grip Analysis</Text>
      </View>

      <ScrollView contentContainerStyle={styles.container}>
        {state.status === 'loading' && (
          <View style={styles.centerContent}>
            <ActivityIndicator size="large" color="#F5A623" />
            <Text style={styles.loadingText}>Analyzing your grip...</Text>
          </View>
        )}

        {state.status === 'error' && (
          <View style={styles.centerContent}>
            <Text style={styles.errorTitle}>
              {state.errorType === 'timeout' || state.errorType === 'network'
                ? "Couldn't reach the server"
                : 'Something went wrong'}
            </Text>
            <Text style={styles.errorHint}>
              {state.errorType === 'timeout' || state.errorType === 'network'
                ? 'Check your connection and try again.'
                : 'Please try again.'}
            </Text>
          </View>
        )}

        {state.status === 'success' && state.data.analysis_failed && (
          <View style={styles.centerContent}>
            <Text style={styles.errorTitle}>Couldn't classify your grip</Text>
            <Text style={styles.errorHint}>
              Try a clearer photo with both hands visible on the club.
            </Text>
          </View>
        )}

        {state.status === 'success' && !state.data.analysis_failed && (
          <>
            {/* Overall assessment */}
            <View style={styles.overallCard}>
              <Text style={styles.overallLabel}>Overall</Text>
              <Text
                style={[
                  styles.overallValue,
                  { color: OVERALL_LABELS[state.data.overall]?.color ?? '#fff' },
                ]}
              >
                {OVERALL_LABELS[state.data.overall]?.label ?? state.data.overall}
              </Text>
            </View>

            {/* Classification details */}
            <View style={styles.detailCard}>
              <DetailRow label="Lead Hand" value={state.data.lead_hand} />
              <DetailRow label="Trail Hand" value={state.data.trail_hand} />
              <DetailRow label="Hands Match" value={state.data.hands_match} />
              <DetailRow
                label="Confidence"
                value={state.data.confidence}
                valueColor={CONFIDENCE_COLORS[state.data.confidence]}
              />
            </View>

            {/* Reason */}
            <View style={styles.reasonCard}>
              <Text style={styles.reasonText}>{state.data.reason}</Text>
            </View>
          </>
        )}
      </ScrollView>

      {/* Navigation buttons — always visible */}
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.secondaryButton, isLoading && styles.buttonDisabled]}
          onPress={() => router.push('/grip/capture' as Href)}
          disabled={isLoading}
          activeOpacity={0.7}
        >
          <Text style={styles.secondaryButtonText}>Try Again</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.primaryButton, isLoading && styles.buttonDisabled]}
          onPress={() => router.push('/(tabs)' as Href)}
          disabled={isLoading}
          activeOpacity={0.7}
        >
          <Text style={styles.primaryButtonText}>Done</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function DetailRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, valueColor ? { color: valueColor } : undefined]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#111' },
  header: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  headerTitle: { color: '#F5A623', fontSize: 18, fontWeight: '700' },
  container: { flexGrow: 1, padding: 24, paddingTop: 8 },

  // Loading / Error centered
  centerContent: {
    alignItems: 'center',
    paddingTop: 80,
  },
  loadingText: {
    color: '#999',
    fontSize: 16,
    marginTop: 16,
  },
  errorTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  errorHint: {
    color: '#999',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 16,
  },

  // Overall card
  overallCard: {
    alignItems: 'center',
    paddingVertical: 28,
    marginBottom: 16,
  },
  overallLabel: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  overallValue: {
    fontSize: 32,
    fontWeight: '800',
  },

  // Detail card
  detailCard: {
    backgroundColor: '#1A1A1C',
    borderRadius: 14,
    padding: 18,
    marginBottom: 16,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  detailLabel: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
  },
  detailValue: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    textTransform: 'capitalize',
  },

  // Reason card
  reasonCard: {
    backgroundColor: '#1A1A1C',
    borderRadius: 14,
    padding: 18,
    marginBottom: 16,
  },
  reasonText: {
    color: '#fff',
    fontSize: 15,
    lineHeight: 22,
  },

  // Bottom buttons
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: '#F5A623',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#111',
    fontSize: 18,
    fontWeight: '700',
  },
  secondaryButton: {
    flex: 1,
    backgroundColor: '#333',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
});
