import React from 'react';
import { View, Image, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Asset intrinsic aspect (323×657 ≈ 0.4916 w/h). Width is derived from height so
// the guide fits without distortion; resizeMode="contain" is a belt-and-suspenders
// guard against rounding drift. Do NOT stretch to fill width.
const GUIDE_ASPECT = 323 / 657;

// Render translucency for the setup guide. Named constant so it's a one-line
// on-device tune. 0 = invisible, 1 = opaque.
const GUIDE_OPACITY = 0.5;

// Guide height as a fraction of the camera-preview height (containerH). 0.57 ≈
// 70% of the prior full-height build. One-line tunable, like GUIDE_OPACITY.
const GUIDE_HEIGHT_FRACTION = 0.57;

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
}: {
  height: number;
  mirrored: boolean;
}) {
  const insets = useSafeAreaInsets(); // hook before the early return (rules of hooks)
  if (height <= 0) return null;
  const guideHeight = height * GUIDE_HEIGHT_FRACTION;
  const bottomOffset = insets.bottom + CONTROL_BAR_HEIGHT + BOTTOM_GAP;
  return (
    <View style={[styles.container, { paddingBottom: bottomOffset }]} pointerEvents="none">
      <Image
        source={require('../assets/images/faceOnGuide.png')}
        style={[
          { height: guideHeight, width: guideHeight * GUIDE_ASPECT, opacity: GUIDE_OPACITY },
          mirrored && styles.mirrored,
        ]}
        resizeMode="contain"
      />
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
});
