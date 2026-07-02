import React, { useSyncExternalStore } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { GOLD } from '../lib/colors';
import {
  fireShutter,
  fireStop,
  subscribe,
  getRecordingSnapshot,
  getProcessingSnapshot,
} from '../lib/shutterStore';

const INACTIVE = '#8A8A8E';

// Visual order of the outer pills (the center ● is the `record` route, rendered separately).
// Declared route order in _layout.tsx is record-first, so we resolve everything BY NAME.
const LEFT_PILLS = ['history'];
const RIGHT_PILLS = ['gallery', 'settings'];

export default function FloatingTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const isRecording = useSyncExternalStore(subscribe, getRecordingSnapshot);
  const isProcessing = useSyncExternalStore(subscribe, getProcessingSnapshot);
  const activeName = state.routes[state.index]?.name;
  const paddingBottom = Math.max(insets.bottom, 12);

  function renderPill(name: string) {
    const route = state.routes.find((r) => r.name === name);
    if (!route) return null;
    const { options } = descriptors[route.key];
    const focused = activeName === name;
    const color = focused ? GOLD : INACTIVE;
    const label = options.title ?? name;

    const onPress = () => {
      const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
      if (!focused && !event.defaultPrevented) {
        navigation.navigate(route.name);
      }
    };

    return (
      <TouchableOpacity
        key={name}
        style={styles.pill}
        onPress={onPress}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={focused ? { selected: true } : {}}
      >
        {options.tabBarIcon?.({ focused, color, size: 24 })}
        <Text style={[styles.pillLabel, { color }]} numberOfLines={1}>
          {label}
        </Text>
      </TouchableOpacity>
    );
  }

  const onCenterPress = () => {
    if (isProcessing) return; // inert during analysis — spinner is showing
    if (activeName === 'record') {
      if (isRecording) fireStop();
      else fireShutter();
    } else {
      navigation.navigate('record');
    }
  };

  return (
    <View style={[styles.wrap, { paddingBottom }]} pointerEvents="box-none">
      {isProcessing && (
        <Text style={styles.processingCaption}>Analyzing swing…</Text>
      )}

      <View style={styles.pillBar}>
        <View style={styles.sideGroup}>{LEFT_PILLS.map(renderPill)}</View>
        <View style={styles.centerSpacer} />
        <View style={styles.sideGroup}>{RIGHT_PILLS.map(renderPill)}</View>
      </View>

      <TouchableOpacity
        style={[styles.centerButton, { bottom: paddingBottom + 24 }]}
        onPress={onCenterPress}
        disabled={isProcessing}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={
          isProcessing ? 'Analyzing swing' : isRecording ? 'Stop recording' : 'Record swing'
        }
      >
        {isProcessing ? (
          <ActivityIndicator color="#fff" />
        ) : isRecording ? (
          <View style={styles.stopSquare} />
        ) : (
          <Ionicons name="videocam" size={30} color="#fff" />
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
  },
  pillBar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginHorizontal: 16,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#1C1C1E',
    paddingHorizontal: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  pill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 8,
  },
  pillLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  sideGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Must stay wider than the 80pt center FAB so pills clear it on both sides.
  centerSpacer: {
    width: 88,
  },
  centerButton: {
    position: 'absolute',
    alignSelf: 'center',
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: GOLD,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 6,
    borderColor: '#000',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 6,
  },
  stopSquare: {
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: '#fff',
  },
  processingCaption: {
    color: '#C8C8CE',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    // Clears the elevated center button (which rises above the pill bar) plus
    // its drop shadow, so the caption never clips against the button.
    marginBottom: 72,
  },
});
