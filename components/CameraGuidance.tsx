import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { CameraGuidanceColor } from '../lib/cameraGuidance';

interface CameraGuidanceProps {
  color: CameraGuidanceColor | null;
  label: string | null;
}

const DOT_COLORS: Record<CameraGuidanceColor, string> = {
  good: '#34C759',
  borderline: '#FF9500',
  poor: '#FF3B30',
};

const PILL_BG: Record<CameraGuidanceColor, string> = {
  good: 'rgba(52, 199, 89, 0.15)',
  borderline: 'rgba(255, 149, 0, 0.15)',
  poor: 'rgba(255, 59, 48, 0.15)',
};

export default function CameraGuidance({ color, label }: CameraGuidanceProps) {
  if (!color || !label) return null;

  return (
    <View style={styles.container} pointerEvents="none">
      <View style={[styles.pill, { backgroundColor: PILL_BG[color] }]}>
        <View style={[styles.dot, { backgroundColor: DOT_COLORS[color] }]} />
        <Text style={[styles.label, { color: DOT_COLORS[color] }]}>{label}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 60,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
  },
});
