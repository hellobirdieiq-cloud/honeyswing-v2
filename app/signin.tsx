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
import { supabase } from '../lib/supabase';

export default function SignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSendLink() {
    const trimmed = email.trim();
    if (!trimmed) {
      Alert.alert('Email required', 'Enter your parent or guardian\'s email address.');
      return;
    }

    setSending(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: {
          emailRedirectTo: 'honeyswingv2://auth/callback',
        },
      });

      if (error) {
        Alert.alert('Error', error.message);
      } else {
        setSent(true);
      }
    } catch {
      Alert.alert('Error', 'Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Check your email</Text>
        <Text style={styles.subtitle}>
          We sent a sign-in link to {email.trim()}. Tap the link to continue.
        </Text>
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => setSent(false)}
          activeOpacity={0.7}
        >
          <Text style={styles.secondaryButtonText}>Try a different email</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.skipButton}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Text style={styles.skipText}>Back to app</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>Save your swings</Text>
      <Text style={styles.subtitle}>
        Enter your parent or guardian's email to create a free account and keep practicing.
      </Text>

      <Text style={styles.label}>Parent's email</Text>
      <TextInput
        style={styles.input}
        placeholder="you@example.com"
        placeholderTextColor="#666"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        returnKeyType="go"
        onSubmitEditing={handleSendLink}
      />

      <TouchableOpacity
        style={[styles.cta, sending && styles.ctaDisabled]}
        onPress={handleSendLink}
        activeOpacity={0.8}
        disabled={sending}
      >
        {sending ? (
          <ActivityIndicator color="#111" />
        ) : (
          <Text style={styles.ctaText}>Send Sign-In Link</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.skipButton}
        onPress={() => router.back()}
        activeOpacity={0.7}
      >
        <Text style={styles.skipText}>Not now</Text>
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
    marginBottom: 8,
  },
  subtitle: {
    color: '#ccc',
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 22,
    marginBottom: 32,
  },
  label: {
    color: '#999',
    fontSize: 14,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#1A1A1C',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    color: '#fff',
    fontSize: 16,
    marginBottom: 24,
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
  skipButton: {
    alignItems: 'center',
    marginTop: 20,
    padding: 8,
  },
  skipText: {
    color: '#666',
    fontSize: 15,
    fontWeight: '500',
  },
  secondaryButton: {
    backgroundColor: '#1A1A1C',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 4,
  },
  secondaryButtonText: {
    color: '#F5A623',
    fontSize: 16,
    fontWeight: '600',
  },
});
