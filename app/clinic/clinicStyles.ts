import { Dimensions, Platform, StyleSheet } from 'react-native';
import { GOLD } from '@/lib/colors';

const { height: SCREEN_H } = Dimensions.get('window');

// Color tokens sourced from app/(tabs)/recordStyles.ts to keep clinic visually consistent with capture screens.
// BG_BLACK = '#000'                      (recordStyles.ts:7)
// BG_PLACEHOLDER = '#111'                (recordStyles.ts:13)
// BG_CARD = '#1A1A1C'                    (recordStyles.ts:55)
// TEXT_PRIMARY = '#FFFFFF'               (recordStyles.ts:32, 68)
// TEXT_SECONDARY = 'rgba(255,255,255,0.7)' (recordStyles.ts:39)
// TEXT_DIM = '#999999'                   (recordStyles.ts:74)
// ACCENT_GOLD via @/lib/colors           (recordStyles.ts:2 imports GOLD)
// Delta colors are inline (not in recordStyles): semantic green/red/gray for live-feedback bars.

const DELTA_GREEN = '#3DDC84';
const DELTA_RED = '#FF4D4F';
const DELTA_NEUTRAL = '#444444';

export const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000', // recordStyles.ts:7
  },
  header: {
    color: GOLD, // recordStyles.ts:2,61
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  body: {
    flex: 1,
    backgroundColor: '#111', // recordStyles.ts:13
    paddingHorizontal: 20,
  },
  formRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  label: {
    color: 'rgba(255,255,255,0.7)', // recordStyles.ts:39
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: '#1A1A1C', // recordStyles.ts:55
    borderRadius: 10,
    padding: 4,
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
  },
  segmentButtonActive: {
    backgroundColor: GOLD, // recordStyles.ts:2,61
  },
  primaryButton: {
    backgroundColor: GOLD, // recordStyles.ts:2,61
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#1A0E00', // recordStyles.ts:7
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    backgroundColor: '#1A1A1C', // recordStyles.ts:55
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  secondaryButtonText: {
    color: '#FFFFFF', // recordStyles.ts:32
    fontSize: 15,
    fontWeight: '600',
  },
  capturePanel: {
    flex: 1,
    backgroundColor: '#000', // recordStyles.ts:7
    alignItems: 'center',
    justifyContent: 'center',
  },
  swingCounter: {
    color: GOLD, // recordStyles.ts:2,61
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  reviewBlock: {
    backgroundColor: '#1A1A1C', // recordStyles.ts:55
    borderRadius: 14,
    padding: 16,
    marginVertical: 8,
  },
  dashboardTabBar: {
    flexDirection: 'row',
    backgroundColor: '#000', // recordStyles.ts:7
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  dashboardTab: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
  },
  dashboardTabActive: {
    borderTopWidth: 2,
    borderTopColor: GOLD, // recordStyles.ts:2,61
  },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  cueRow: {
    backgroundColor: '#1A1A1C', // recordStyles.ts:55
    padding: 14,
    borderRadius: 12,
    marginVertical: 8,
  },
  flagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#1A1A1C', // recordStyles.ts:55
    borderRadius: 10,
    marginVertical: 6,
  },

  // ── Coach Mode additions ──

  coachTabBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    backgroundColor: '#000', // recordStyles.ts:7
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)',
    height: SCREEN_H * 0.08,
  },
  coachTabBarItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
  },
  coachTabBarItemActive: {
    borderTopWidth: 3,
    borderTopColor: GOLD, // recordStyles.ts:2,61
  },
  metricBlock: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
  },
  // Tab 1 LiveView: ~60% of screen height for arm's-length readability per UX CONSTRAINTS.
  metricValueLarge: {
    color: '#FFFFFF', // recordStyles.ts:32
    fontSize: Math.round(SCREEN_H * 0.18), // visual height ≈ 60% screen with line spacing
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
  // Tab 2 KidView: ~70%+ of screen height.
  metricValueKid: {
    color: '#FFFFFF', // recordStyles.ts:32
    fontSize: Math.round(SCREEN_H * 0.22),
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
  deltaBar: {
    height: 12,
    borderRadius: 6,
    marginVertical: 8,
    backgroundColor: DELTA_NEUTRAL,
  },
  deltaBarPositive: {
    backgroundColor: DELTA_GREEN,
  },
  deltaBarNegative: {
    backgroundColor: DELTA_RED,
  },
  deltaBarNeutral: {
    backgroundColor: DELTA_NEUTRAL,
  },
  kidQueueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  nextKidCta: {
    backgroundColor: GOLD, // recordStyles.ts:2,61
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderRadius: 12,
    alignItems: 'center',
  },
  nextKidDrawer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#1A1A1C', // recordStyles.ts:55
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  drawerHandle: {
    alignSelf: 'center',
    width: 48,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.25)',
    marginTop: 8,
    marginBottom: 12,
  },
  rawDebugMono: {
    color: '#FFFFFF', // recordStyles.ts:32
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 14,
  },
});
