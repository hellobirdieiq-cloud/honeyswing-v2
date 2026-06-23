import React from 'react';
import { View, Image, StyleSheet } from 'react-native';

// Asset intrinsic aspect (323×657 ≈ 0.4916 w/h). Width is derived from height so
// the guide fits the preview height without distortion; resizeMode="contain" is a
// belt-and-suspenders guard against rounding drift. Do NOT stretch to fill width.
const GUIDE_ASPECT = 323 / 657;

// Render translucency for the setup guide. Named constant so it's a one-line
// on-device tune. 0 = invisible, 1 = opaque.
const GUIDE_OPACITY = 0.5;

/**
 * Translucent face-on alignment guide for the Record screen (#11).
 * In-tree View (never a Modal — see bdc3f72), pointerEvents="none" so it never
 * intercepts the pinch-zoom gesture or shutter. Parent gates visibility.
 */
export default function FaceOnSetupOverlay({
  height,
  mirrored,
}: {
  height: number;
  mirrored: boolean;
}) {
  if (height <= 0) return null;
  return (
    <View style={styles.container} pointerEvents="none">
      <Image
        source={require('../assets/images/faceOnGuide.png')}
        style={[
          styles.guide,
          { height, width: height * GUIDE_ASPECT, opacity: GUIDE_OPACITY },
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
    alignItems: 'center', // center horizontally
    justifyContent: 'center', // center vertically within preview height
  },
  guide: {},
  mirrored: {
    transform: [{ scaleX: -1 }], // lefty flip
  },
});
