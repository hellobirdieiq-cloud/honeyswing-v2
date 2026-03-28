import { useState, useCallback } from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity, Modal, TextInput } from 'react-native';
import { useRouter, useFocusEffect, type Href } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { loadFocus, type FocusData } from '../../lib/swingMotionStore';
import { getGrip } from '../../lib/gripStore';
import { getCoachCode, setCoachCode, resolveCoachName } from '../../lib/coachCode';

function focusScoreColor(score: number): string {
  if (score >= 80) return '#00FF66';
  if (score >= 50) return '#FFB020';
  return '#FF4444';
}

export default function TabsHomeScreen() {
  const router = useRouter();
  const [focus, setFocus] = useState<FocusData | null>(null);
  const [gripUri, setGripUri] = useState<string | null>(null);
  const [coachName, setCoachName] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [codeInput, setCodeInput] = useState('');

  useFocusEffect(
    useCallback(() => {
      loadFocus().then(setFocus);
      const grip = getGrip();
      setGripUri(grip?.photoUri ?? null);
      getCoachCode().then((code) => setCoachName(resolveCoachName(code)));
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

      <TouchableOpacity
        style={styles.gripBtn}
        onPress={() => router.push('/grip/capture' as Href)}
        activeOpacity={0.8}
      >
        {gripUri ? (
          <Image source={{ uri: gripUri }} style={styles.gripThumb} resizeMode="cover" />
        ) : null}
        <Text style={styles.gripBtnText}>
          {gripUri ? 'Update Grip Photo' : 'Capture Grip'}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.coachBtn}
        onPress={() => setModalVisible(true)}
        activeOpacity={0.8}
      >
        <Ionicons name="person-outline" size={22} color="#F5A623" />
        <Text style={styles.coachBtnText}>
          {coachName ?? 'Link a Coach'}
        </Text>
      </TouchableOpacity>

      <Text style={styles.hint}>
        {focus ? 'Record a swing to update your focus' : "Let's see that swing"}
      </Text>

      <Modal visible={modalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Enter Coach Code</Text>
            <TextInput
              style={styles.modalInput}
              value={codeInput}
              onChangeText={setCodeInput}
              placeholder="Coach code"
              placeholderTextColor="#666"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => { setModalVisible(false); setCodeInput(''); }}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalConfirm}
                onPress={async () => {
                  await setCoachCode(codeInput);
                  setCoachName(resolveCoachName(codeInput));
                  setModalVisible(false);
                  setCodeInput('');
                }}
              >
                <Text style={styles.modalConfirmText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  gripBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#F5A623',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    marginBottom: 20,
    gap: 12,
  },
  gripBtnText: {
    color: '#F5A623',
    fontSize: 16,
    fontWeight: '600',
  },
  gripThumb: {
    width: 36,
    height: 36,
    borderRadius: 6,
    backgroundColor: '#333',
  },
  coachBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    marginBottom: 20,
  },
  coachBtnText: {
    color: '#F5A623',
    fontSize: 16,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#1A1A1C',
    borderRadius: 14,
    padding: 24,
    width: '80%',
  },
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
  modalInput: {
    backgroundColor: '#333',
    color: '#fff',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 20,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  modalCancel: {
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  modalCancelText: {
    color: '#999',
    fontSize: 16,
    fontWeight: '600',
  },
  modalConfirm: {
    backgroundColor: '#F5A623',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  modalConfirmText: {
    color: '#111',
    fontSize: 16,
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
