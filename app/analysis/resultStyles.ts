import { StyleSheet } from 'react-native';
import { GOLD } from '../../lib/colors';

export const styles = StyleSheet.create({
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
    backgroundColor: GOLD,
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
    color: GOLD,
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

  // Grip chip
  gripChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1A1A1C',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    marginBottom: 16,
  },
  gripChipLabel: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
  },
  gripChipValue: {
    fontSize: 14,
    fontWeight: '600',
  },

  // CTA
  primaryButton: {
    backgroundColor: GOLD,
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
    color: GOLD,
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
