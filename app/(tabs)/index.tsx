import { useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter, useFocusEffect, type Href } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { loadFocus, type FocusData } from '../../lib/swingMotionStore';

function focusScoreColor(score: number): string {
  if (score >= 80) return '#00FF66';
  if (score >= 50) return '#FFB020';
  return '#FF4444';
}

export default function TabsHomeScreen() {
  const router = useRouter();
  const [focus, setFocus] = useState<FocusData | null>(null);

  useFocusEffect(
    useCallback(() => {
      loadFocus().then(setFocus);
    }, []),
  );

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.settingsButton}
        onPress={() => router.push('/settings' as Href)}
        activeOpacity={0.7}
      >
        <Ionicons name="settings-outline" size={24} color="#999" />
      </TouchableOpacity>

      <View style={styles.hero}>
        <Text style={styles.title}>HoneySwing</Text>
        <Text style={styles.subtitle}>Your pocket swing coach</Text>
      </View>

      {focus && (
        <View style={styles.focusCard}>
          <Text style={styles.focusTitle}>Today's Focus</Text>
          <View style={styles.focusRow}>
            <View style={[styles.focusDot, { backgroundColor: focusScoreColor(focus.score) }]} />
            <Text style={[styles.focusLabel, { color: focusScoreColor(focus.score) }]}>
              {focus.label}
            </Text>
          </View>
          <Text style={styles.focusCue}>{focus.cue}</Text>
        </View>
      )}

      <TouchableOpacity
        style={styles.cta}
        onPress={() => router.push('/(tabs)/record')}
        activeOpacity={0.8}
      >
        <Text style={styles.ctaText}>Start Swinging</Text>
      </TouchableOpacity>

      <Text style={styles.hint}>
        {focus ? 'Record a swing to update your focus' : "Let's see that swing"}
      </Text>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
    padding: 24,
  },
  hero: {
    alignItems: 'center',
    marginBottom: 48,
  },
  title: {
    color: '#F5A623',
    fontSize: 36,
    fontWeight: '800',
    marginBottom: 8,
  },
  subtitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '500',
  },
  focusCard: {
    backgroundColor: '#1A1A1C',
    borderRadius: 14,
    padding: 16,
    width: '100%',
    marginBottom: 24,
  },
  focusTitle: {
    color: '#F5A623',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  focusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  focusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 10,
  },
  focusLabel: {
    fontSize: 17,
    fontWeight: '700',
  },
  focusCue: {
    color: '#ccc',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
    paddingLeft: 20,
  },
  cta: {
    backgroundColor: '#F5A623',
    paddingVertical: 18,
    paddingHorizontal: 48,
    borderRadius: 16,
    marginBottom: 20,
  },
  ctaText: {
    color: '#111',
    fontSize: 20,
    fontWeight: '700',
  },
  hint: {
    color: '#666',
    fontSize: 14,
  },
  settingsButton: {
    position: 'absolute',
    top: 60,
    right: 24,
    padding: 8,
  },
});
