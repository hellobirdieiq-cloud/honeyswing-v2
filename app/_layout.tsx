import { useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';
import { Stack, useRouter, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { handleReferralUrl, commitPendingReferral } from '../lib/referralAttribution';
import { configurePurchases, syncAuthState } from '../lib/purchases';
import { tipFrequencyLimiter } from '../lib/tipFrequency';

const ONBOARDING_KEY = 'honeyswing:onboardingComplete';

// Keep splash visible while we initialize
SplashScreen.preventAutoHideAsync();

function extractTokensFromUrl(url: string): { accessToken: string; refreshToken: string } | null {
  // Supabase magic link redirects with fragment: #access_token=...&refresh_token=...
  const hash = url.split('#')[1];
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken && refreshToken) return { accessToken, refreshToken };
  return null;
}

async function handleAuthUrl(url: string): Promise<boolean> {
  const tokens = extractTokensFromUrl(url);
  if (!tokens) return false;
  const { error } = await supabase.auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  });
  if (error) {
    console.error('[HoneySwing] setSession error:', error.message);
    return false;
  }
  return true;
}

export default function RootLayout() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    async function init() {
      configurePurchases();

      // Check for magic link or referral link that opened the app (cold start)
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl) await handleAuthUrl(initialUrl);
      if (initialUrl) {
        await handleReferralUrl(initialUrl);
        router.replace('/(tabs)' as Href);
      }
      await commitPendingReferral();

      // Determine auth + onboarding state
      const { data: { session } } = await supabase.auth.getSession();
      const onboarded = await AsyncStorage.getItem(ONBOARDING_KEY);

      setReady(true);
      SplashScreen.hideAsync();

      // Redirect after splash hides so the navigator is fully mounted
      if (session && !onboarded) {
        router.replace('/onboarding' as Href);
      }
    }

    init();

    // Listen for magic link while app is already open (warm start)
    const subscription = Linking.addEventListener('url', async ({ url }) => {
      const success = await handleAuthUrl(url);
      if (success) {
        const onboarded = await AsyncStorage.getItem(ONBOARDING_KEY);
        if (!onboarded) {
          router.replace('/onboarding' as Href);
        } else {
          router.replace('/(tabs)' as Href);
        }
      }
      await handleReferralUrl(url);
      router.replace('/(tabs)' as Href);
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event) => {
        if (event === 'SIGNED_IN') {
          await commitPendingReferral();
          const { data: { user } } = await supabase.auth.getUser();
          if (user) await syncAuthState(user.id);
          router.replace('/(tabs)' as Href);
        } else if (event === 'SIGNED_OUT') {
          await syncAuthState(null);
        }
      }
    );
    return () => subscription.unsubscribe();
  }, []);

  // Task 7: reset tip frequency limiter when app returns from background
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        tipFrequencyLimiter.reset();
      }
    });
    return () => sub.remove();
  }, []);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="signin" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="paywall" />
      <Stack.Screen name="auth/callback" />
      <Stack.Screen name="analysis/result" />
      <Stack.Screen name="grip/capture" />
      <Stack.Screen name="grip/result" />
    </Stack>
  );
}
