import { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter, type Href } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteAccount } from '../lib/supabase';

export default function SettingsScreen() {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

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
