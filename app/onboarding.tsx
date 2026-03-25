import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, getUserId } from '../lib/supabase';

const ONBOARDING_KEY = 'honeyswing:onboardingComplete';

const COACH_OPTIONS = ['Dave Donnellan', 'No coach'] as const;

export default function OnboardingScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [coach, setCoach] = useState<string>('No coach');
  const [isLeftHanded, setIsLeftHanded] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert('Name required', "What's your name?");
      return;
    }

    setSaving(true);
    try {
      const userId = await getUserId();
      const coachName = coach === 'No coach' ? null : coach;

      const row: Record<string, unknown> = {
        display_name: trimmedName,
        coach_name: coachName,
        is_left_handed: isLeftHanded,
      };

      // If authenticated, set profile id = auth uid so it's linked
      if (userId) {
        row.id = userId;
      }

      const { data, error } = await supabase
        .from('profiles')
        .upsert(row)
        .select('id')
        .single();

      if (error) throw error;

      await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
      await AsyncStorage.setItem('honeyswing:isLeftHanded', String(isLeftHanded));
      if (data?.id) {
        await AsyncStorage.setItem('honeyswing:profileId', data.id);
      }
      router.replace('/(tabs)');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      Alert.alert('Error', message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>Welcome to HoneySwing</Text>
      <Text style={styles.subtitle}>Let's set up your profile</Text>

      {/* Name input */}
      <Text style={styles.label}>What's your name?</Text>
      <TextInput
        style={styles.input}
        placeholder="First name"
        placeholderTextColor="#666"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        autoCorrect={false}
        autoComplete="given-name"
        returnKeyType="next"
      />

      {/* Coach picker */}
      <Text style={styles.label}>Who's your coach?</Text>
      <View style={styles.optionGroup}>
        {COACH_OPTIONS.map((option) => (
          <TouchableOpacity
            key={option}
            style={[styles.option, coach === option && styles.optionSelected]}
            onPress={() => setCoach(option)}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.optionText,
                coach === option && styles.optionTextSelected,
              ]}
            >
              {option}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Handedness toggle */}
      <Text style={styles.label}>Dominant hand</Text>
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.toggleOption, !isLeftHanded && styles.optionSelected]}
          onPress={() => setIsLeftHanded(false)}
          activeOpacity={0.7}
        >
          <Text
            style={[
              styles.optionText,
              !isLeftHanded && styles.optionTextSelected,
            ]}
          >
            Right-handed
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleOption, isLeftHanded && styles.optionSelected]}
          onPress={() => setIsLeftHanded(true)}
          activeOpacity={0.7}
        >
          <Text
            style={[
              styles.optionText,
              isLeftHanded && styles.optionTextSelected,
            ]}
          >
            Left-handed
          </Text>
        </TouchableOpacity>
      </View>

      {/* Submit */}
      <TouchableOpacity
        style={[styles.cta, saving && styles.ctaDisabled]}
        onPress={handleSubmit}
        activeOpacity={0.8}
        disabled={saving}
      >
        {saving ? (
          <ActivityIndicator color="#111" />
        ) : (
          <Text style={styles.ctaText}>Let's Go</Text>
        )}
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    padding: 24,
    justifyContent: 'center',
  },
  title: {
    color: '#F5A623',
    fontSize: 32,
    fontWeight: '800',
    marginBottom: 6,
  },
  subtitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 36,
  },
  label: {
    color: '#999',
    fontSize: 14,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  input: {
    backgroundColor: '#1A1A1C',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    color: '#fff',
    fontSize: 16,
    marginBottom: 28,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  optionGroup: {
    marginBottom: 28,
  },
  option: {
    backgroundColor: '#1A1A1C',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    marginBottom: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  optionSelected: {
    borderColor: '#F5A623',
  },
  optionText: {
    color: '#999',
    fontSize: 16,
    fontWeight: '600',
  },
  optionTextSelected: {
    color: '#fff',
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 36,
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
  cta: {
    backgroundColor: '#F5A623',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  ctaDisabled: {
    opacity: 0.6,
  },
  ctaText: {
    color: '#111',
    fontSize: 18,
    fontWeight: '700',
  },
});
