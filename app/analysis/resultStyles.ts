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

  // Control row: View + Speed groups side by side in ONE compact row,
  // a small muted label above each set.
  controlBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    // Content-sized groups: View pill left, Speed pill right (same visual
    // positions the old 1.5/1 flex split produced, without forcing widths).
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 12,
  },
  controlGroup: {
    gap: 4,
  },
  // Groups + segments size to CONTENT (wrap root-cause fix): forced
  // equal-width flex squeezed 'Overlay'/'0.25x' into wrapping on narrow
  // screens. All six labels fit one line at 390pt with 8pt side padding.
  controlGroupView: {},
  controlGroupSpeed: {},
  controlGroupLabel: {
    color: '#666',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginLeft: 4,
  },
  // Segmented control (View / Speed sets share it)
  segmentedControl: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    backgroundColor: '#1A1A1C',
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  segment: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  segmentActive: {
    backgroundColor: GOLD,
  },
  segmentText: {
    color: '#999',
    fontSize: 13, // compact: both control sets share one row
    fontWeight: '600',
  },
  segmentTextActive: {
    color: '#111',
  },

  // Single stage that hosts the video + (optional) skeleton overlay
  stage: {
    position: 'relative',
    alignSelf: 'center',
    borderRadius: 12,
    overflow: 'hidden',
  },
  // Opaque cover that hides the (still-mounted) video in Skeleton mode.
  skeletonBackdrop: {
    backgroundColor: '#08080A',
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
  // Score
  scoreCard: {
    alignItems: 'center',
    marginBottom: 20,
    paddingVertical: 28,
  },
  // Auto | Yours view toggle (P-101) — putting-card pattern, GOLD accent
  viewToggleRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
    alignSelf: 'center',
  },
  viewToggle: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 18,
  },
  viewToggleActive: {
    borderColor: GOLD,
    backgroundColor: `${GOLD}22`,
  },
  viewToggleText: {
    color: '#888',
    fontSize: 13,
    fontWeight: '700',
  },
  viewToggleTextActive: {
    color: GOLD,
  },
  // Bottom detail rows (Phase 1 restructure): Review Detection / Tempo / Art.
  // detailRow has NO horizontal padding of its own — the header carries it, so
  // the Art body can host the full-content-width SwingArtCard (screenW - 48).
  detailRow: {
    backgroundColor: '#1A1A1C',
    borderRadius: 14,
    marginBottom: 10,
    overflow: 'hidden',
  },
  detailRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 52,
    gap: 10,
  },
  detailRowPressable: {
    flex: 1,
  },
  detailRowLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  detailRowCaption: {
    color: '#777',
    fontSize: 12,
    fontWeight: '500',
    marginTop: 2,
  },
  detailRowChevron: {
    color: '#777',
    fontSize: 14,
    fontWeight: '700',
  },
  detailRowBody: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  detailRowBodyArt: {
    alignItems: 'center',
    paddingBottom: 12,
  },
  // Relocated Auto | Yours toggle, small variant (Review Detection row).
  // Deliberately quiet so the row title reads first; active state stays GOLD.
  viewToggleRowSmall: {
    flexDirection: 'row',
    gap: 6,
  },
  viewToggleSmall: {
    borderWidth: 1,
    borderColor: '#2A2A2C',
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  viewToggleSmallActive: {
    borderColor: GOLD,
    backgroundColor: `${GOLD}22`,
  },
  viewToggleSmallText: {
    color: '#666',
    fontSize: 11,
    fontWeight: '700',
  },
  viewToggleSmallTextActive: {
    color: GOLD,
  },
  // Corrections-gated null-tempo notice (FIX 5)
  tempoUnavailableText: {
    color: '#888',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 6,
  },
  // Collapsed-state tab for the operator label overlay (FIX 4/4b)
  labelOverlayTab: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  labelOverlayTabText: {
    color: '#FFF', // white label; the caret span is the sole blue accent
    fontSize: 13,
    fontWeight: '700',
  },
  labelOverlayTabCaret: {
    color: '#0A84FF',
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

  // Phase chips — single row of content-sized chips at a fixed 13px label (see
  // phaseChipLabel). Chips hug their label width via paddingHorizontal (no
  // flex:1, no auto-shrink), gap 6 between them; all 5 fit on one line down to
  // the narrowest supported iPhone (375pt). minHeight 44 preserves the 44pt
  // touch target.
  phaseChipsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 4,
    marginBottom: 16,
  },
  phaseChip: {
    minWidth: 64,
    minHeight: 44,
    backgroundColor: '#1A1A1C',
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phaseChipDisabled: {
    minWidth: 64,
    minHeight: 44,
    backgroundColor: '#0E0E10',
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phaseChipLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  phaseChipLabelDisabled: {
    color: '#555',
    fontSize: 13,
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

  tempoVerdict: {
    fontSize: 20,
    fontWeight: '700',
    marginTop: 8,
    textAlign: 'center',
  },
  coachingCue: {
    color: '#F59E0B',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 6,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  tempoRatio: {
    color: '#888',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 14,
  },
  timingRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    marginTop: 6,
  },
  timingItem: {
    color: '#888',
    fontSize: 13,
    fontWeight: '500',
  },
  videoWrapper: {
    width: '100%',
    aspectRatio: 9 / 16,
    position: 'relative',
  },
  videoPlayButton: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoPlayButtonIcon: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
    marginLeft: 2,
  },

  partialBanner: {
    backgroundColor: 'rgba(200, 169, 81, 0.12)',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  partialBannerTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  partialBannerSub: {
    color: '#999',
    fontSize: 12,
    fontWeight: '500',
  },

});
