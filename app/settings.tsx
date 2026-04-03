import { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter, useFocusEffect, type Href } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteAccount } from '../lib/supabase';
import { getCoachCode, clearCoachCode, resolveCoachName } from '../lib/coachCode';
import { getIsLeftHanded, setIsLeftHanded } from '../lib/handedness';
import { restorePurchases, ENTITLEMENT_ID } from '../lib/purchases';

export default function SettingsScreen() {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [coachName, setCoachName] = useState<string | null>(null);
  const [isLeftHanded, setIsLeftHandedState] = useState(false);

  useFocusEffect(
    useCallback(() => {
      getCoachCode().then((code) => setCoachName(resolveCoachName(code)));
      getIsLeftHanded().then(setIsLeftHandedState);
    }, []),
  );

  function handleRemoveCoach() {
    Alert.alert(
      'Remove Coach?',
      'This will disconnect you from your coach.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await clearCoachCode();
            setCoachName(null);
          },
        },
      ],
    );
  }

  async function handleRestore() {
    setRestoring(true);
    try {
      const info = await restorePurchases();
      if (info?.entitlements.active[ENTITLEMENT_ID]) {
        Alert.alert('Restored', 'Your subscription has been restored.');
      } else {
        Alert.alert('No Previous Purchases', 'No previous purchases found.');
      }
    } catch {
      Alert.alert('Restore Failed', 'Something went wrong. Please try again.');
    } finally {
      setRestoring(false);
    }
  }

  function handleDelete() {
    Alert.alert(
      'Delete Account',
      'Are you sure? This will permanently delete your account and all swing data.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteAccount();
              await AsyncStorage.multiRemove([
                'honeyswing:onboardingComplete',
                'honeyswing:profileId',
                'honeyswing:isLeftHanded',
                'honeyswing:coachCode',
              'honeyswing:pendingReferralCode',
              ]);
              router.replace('/(tabs)' as Href);
            } catch (err: unknown) {
              const message =
                err instanceof Error ? err.message : 'Something went wrong';
              Alert.alert('Error', message);
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>

      <TouchableOpacity
        style={styles.backButton}
        onPress={() => router.back()}
        activeOpacity={0.7}
      >
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      <View style={styles.coachSection}>
        <Text style={styles.coachLabel}>Coach</Text>
        <Text style={styles.coachStatus}>
          {coachName ? `Connected to Coach ${coachName}` : 'No coach linked'}
        </Text>
        {coachName ? (
          <TouchableOpacity
            style={styles.removeCoachButton}
            onPress={handleRemoveCoach}
            activeOpacity={0.7}
          >
            <Text style={styles.removeCoachText}>Remove Coach</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.handednessSection}>
        <Text style={styles.coachLabel}>Dominant hand</Text>
        <View style={styles.toggleRow}>
          <TouchableOpacity
            style={[styles.toggleOption, !isLeftHanded && styles.optionSelected]}
            onPress={() => {
              setIsLeftHandedState(false);
              setIsLeftHanded(false);
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.optionText, !isLeftHanded && styles.optionTextSelected]}>
              Right-handed
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.toggleOption, isLeftHanded && styles.optionSelected]}
            onPress={() => {
              setIsLeftHandedState(true);
              setIsLeftHanded(true);
            }}
            activeOpacity={0.7}
          >
            <Text style={[styles.optionText, isLeftHanded && styles.optionTextSelected]}>
              Left-handed
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.restoreSection}>
        <TouchableOpacity
          style={styles.restoreButton}
          onPress={handleRestore}
          disabled={restoring}
          activeOpacity={0.7}
        >
          <Text style={styles.restoreText}>
            {restoring ? 'Restoring...' : 'Restore Purchases'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <TouchableOpacity
          style={styles.deleteButton}
          onPress={handleDelete}
          activeOpacity={0.8}
          disabled={deleting}
        >
          {deleting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.deleteText}>Delete My Account</Text>
          )}
        </TouchableOpacity>
        <Text style={styles.deleteHint}>
          This will permanently remove your profile and all swing data.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    padding: 24,
    paddingTop: 80,
  },
  title: {
    color: '#F5A623',
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 8,
  },
  backButton: {
    marginBottom: 40,
  },
  backText: {
    color: '#999',
    fontSize: 15,
    fontWeight: '500',
  },
  coachSection: {
    marginTop: 32,
  },
  coachLabel: {
    color: '#999',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  coachStatus: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
  },
  removeCoachButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
  },
  removeCoachText: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
  },
  handednessSection: {
    marginTop: 32,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 10,
  },
  toggleOption: {
    flex: 1,
    backgroundColor: '#1A1A1C',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  optionSelected: {
    borderColor: '#F5A623',
  },
  optionText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#999',
  },
  optionTextSelected: {
    color: '#fff',
  },
  restoreSection: {
    marginTop: 32,
  },
  restoreButton: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
  },
  restoreText: {
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
  },
  section: {
    marginTop: 'auto',
    marginBottom: 60,
  },
  deleteButton: {
    backgroundColor: '#CC2222',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  deleteText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  deleteHint: {
    color: '#666',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 12,
  },
});
