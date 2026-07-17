import React from 'react';
import { View, Image, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AgeTier } from '@/lib/ageTier';
import { GUIDE_HEIGHT_FRACTION_BY_TIER } from './faceOnGuideSizing';

// Asset intrinsic aspect (323×657 ≈ 0.4916 w/h). Width is derived from height so
// the guide fits without distortion; resizeMode="contain" is a belt-and-suspenders
// guard against rounding drift. Do NOT stretch to fill width.
const GUIDE_ASPECT = 323 / 657;

// Render translucency for the setup guide. Named constant so it's a one-line
// on-device tune. 0 = invisible, 1 = opaque.
// EXTERNAL ASSUMPTION — untuned, pending on-device calibration (was 0.5).
const GUIDE_OPACITY = 0.35;

// Bottom anchor: keep the clubhead (bottom edge of the asset) clear above the
// FloatingTabBar. Its center record button is the tallest element, reaching
// ~104px above the safe-area inset (centerButton bottom = paddingBottom+24,
// height 80; see FloatingTabBar.tsx), plus a 16px breathing gap.
const CONTROL_BAR_HEIGHT = 104;
const BOTTOM_GAP = 16;

/**
 * Translucent face-on alignment guide for the Record screen (#11).
 * In-tree View (never a Modal — see bdc3f72), pointerEvents="none" so it never
 * intercepts the pinch-zoom gesture or shutter. Parent gates visibility.
 *
 * Bottom-anchored (not centered): the clubhead sits a fixed margin above the
 * control bar so it's never hidden behind it on any device.
 */
export default function FaceOnSetupOverlay({
  height,
  mirrored,
  ageTier,
  mode = 'swing',
}: {
  height: number;
  mirrored: boolean;
  // Active player's age tier. Optional only for type-compat with
  // PlayerProfile.ageTier — addProfile stamps it and getProfiles backfills
  // legacy rows, so runtime callers always pass one; undefined falls back to
  // the adult (pre-tier) size.
  ageTier?: AgeTier;
  /**
   * Putt mode PLACEHOLDER (Phase C, decision C-1a): no putting-posture asset
   * exists, so putt mode hides the swing silhouette PNG and shows putting
   * caption text only. A real putting asset drops in later as a pure swap
   * (add the source + a putting fraction map beside faceOnGuideSizing.ts).
   */
  mode?: 'swing' | 'putt';
}) {
  const insets = useSafeAreaInsets(); // hook before the early return (rules of hooks)
  if (height <= 0) return null;
  const guideHeight = height * GUIDE_HEIGHT_FRACTION_BY_TIER[ageTier ?? 'adult'];
  const bottomOffset = insets.bottom + CONTROL_BAR_HEIGHT + BOTTOM_GAP;
  return (
    <View style={[styles.container, { paddingBottom: bottomOffset }]} pointerEvents="none">
      {mode === 'swing' && (
        <Image
          source={require('../assets/images/faceOnGuide.png')}
          style={[
            { height: guideHeight, width: guideHeight * GUIDE_ASPECT, opacity: GUIDE_OPACITY },
            mirrored && styles.mirrored,
          ]}
          resizeMode="contain"
        />
      )}
      <Text style={styles.caption}>
        {mode === 'putt'
          ? 'Face-on — whole body and ball on screen'
          : 'Stand so your whole body is on screen'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', // keep horizontal centering
    justifyContent: 'flex-end', // bottom-anchored (was 'center')
  },
  mirrored: {
    transform: [{ scaleX: -1 }], // lefty flip — unchanged
  },
  caption: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.75)',
    textShadowColor: 'rgba(0, 0, 0, 0.5)',
    textShadowRadius: 4,
    textAlign: 'center',
  },
});
