import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useSignIn, useSignUp } from '@clerk/expo';
import { GOLD } from '../lib/colors';

export default function SignInScreen() {
  const router = useRouter();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSendCode() {
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter your email address.');
      return;
    }

    setError('');
    setLoading(true);
    try {
      const createResult = await signIn.create({
        identifier: trimmed,
        signUpIfMissing: true,
      });
      if (createResult.error) {
        setError(createResult.error.message ?? 'Could not start sign-in.');
        return;
      }

      const sendResult = await signIn.emailCode.sendCode();
      if (sendResult.error) {
        setError(sendResult.error.message ?? 'Could not send code.');
        return;
      }

      setStep('code');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyCode() {
    if (!code.trim()) {
      setError('Enter the 6-digit code.');
      return;
    }

    setError('');
    setLoading(true);
    const verifyResult = await signIn.emailCode.verifyCode({ code: code.trim() });
    const clerkError = verifyResult.error;

    if (clerkError) {
      const errorCode = (clerkError as any).errors?.[0]?.code;

      if (errorCode === 'sign_up_if_missing_transfer') {
        const transferResult = await signUp.create({ transfer: true });
        if (transferResult.error) {
          setError(transferResult.error.message ?? 'Could not complete sign-up.');
          setCode('');
          setLoading(false);
          return;
        }

        if (signUp.status === 'complete') {
          router.replace('/(tabs)' as Href);
          setLoading(false);
          return;
        }

        // Transfer carried the verified email. Go straight to finalize.
        const finalizeResult = await signUp.finalize();
        if (finalizeResult.error) {
          setError(finalizeResult.error.message ?? 'Could not complete sign-up.');
          setLoading(false);
          return;
        }

        router.replace('/(tabs)' as Href);
        setLoading(false);
        return;
      }

      setError(clerkError.message ?? 'Invalid code.');
      setCode('');
      setLoading(false);
      return;
    }

    if (signIn.status !== 'complete') {
      setError('Verification incomplete. Please try again.');
      setCode('');
      setLoading(false);
      return;
    }

    const finalizeResult = await signIn.finalize();
    if (finalizeResult.error) {
      setError(finalizeResult.error.message ?? 'Could not complete sign-in.');
      setLoading(false);
      return;
    }

    router.replace('/(tabs)' as Href);
    setLoading(false);
  }

  async function handleSendNewCode() {
    setCode('');
    setError('');
    await signIn.reset();
    await signUp.reset();
    setStep('email');
  }

  if (step === 'code') {
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Text style={styles.title}>Enter your code</Text>
        <Text style={styles.subtitle}>
          We sent a 6-digit code to {email.trim()}. Enter it below.
        </Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <Text style={styles.label}>Verification code</Text>
        <TextInput
          style={styles.input}
          placeholder="000000"
          placeholderTextColor="#666"
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={6}
          returnKeyType="go"
          onSubmitEditing={handleVerifyCode}
        />

        <TouchableOpacity
          style={[styles.cta, loading && styles.ctaDisabled]}
          onPress={handleVerifyCode}
          activeOpacity={0.8}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#111" />
          ) : (
            <Text style={styles.ctaText}>Verify</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.skipButton}
          onPress={handleSendNewCode}
          activeOpacity={0.7}
        >
          <Text style={styles.textLink}>Send new code</Text>
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

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>Save your swings</Text>
      <Text style={styles.subtitle}>
        Enter your email to create a free account and keep practicing.
      </Text>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <Text style={styles.label}>Email</Text>
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
        onSubmitEditing={handleSendCode}
      />

      <TouchableOpacity
        style={[styles.cta, loading && styles.ctaDisabled]}
        onPress={handleSendCode}
        activeOpacity={0.8}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color="#111" />
        ) : (
          <Text style={styles.ctaText}>Send Code</Text>
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
    color: GOLD,
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
    backgroundColor: GOLD,
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
  errorText: {
    color: '#E53935',
    fontSize: 14,
    marginBottom: 12,
  },
  textLink: {
    color: '#888',
    fontSize: 14,
    fontWeight: '500',
  },
});
