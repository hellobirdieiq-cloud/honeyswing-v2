import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, Linking } from 'react-native';
import { Stack, useRouter, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { handleReferralUrl, commitPendingReferral } from '../lib/referralAttribution';
import { configurePurchases, syncAuthState } from '../lib/purchases';
import { tipFrequencyLimiter } from '../lib/tipFrequency';
import { positiveReinforcementEngine } from '../lib/positiveReinforcement';
import { sessionAccumulator } from '../lib/sessionAccumulator';
import { STORAGE_KEYS } from '../lib/storageKeys';
import { getAgeTier } from '../lib/ageTier';

/** Session resets after this many ms in background */
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const ONBOARDING_KEY = STORAGE_KEYS.onboardingComplete;

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

  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await supabase.auth.setSession({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    });
    if (!error) {
      const { data: { session } } = await supabase.auth.getSession();
      return session !== null;
    }
    console.error('[HoneySwing] setSession error (attempt ' + (attempt + 1) + '):', error.message);
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export default function RootLayout() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    async function init() {
      configurePurchases();

      // Task 15: load age tier and apply to frequency limiter
      getAgeTier().then((tier) => tipFrequencyLimiter.setAgeTier(tier)).catch((err) => console.error('[HoneySwing]', err));

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

    init().catch((err) => {
      console.error('[HoneySwing] init crashed:', err);
      SplashScreen.hideAsync();
    });

    // Listen for magic link while app is already open (warm start)
    const subscription = Linking.addEventListener('url', async ({ url }) => {
      await handleAuthUrl(url);

      // Auth URLs: let onAuthStateChange own post-auth navigation.
      // handleAuthUrl may return false even though SIGNED_IN already fired
      // (setSession triggers onAuthStateChange as a side effect before resolving).
      if (url.includes('#access_token=')) return;

      await handleReferralUrl(url);
      router.replace('/(tabs)' as Href);
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        try {
          if (event === 'SIGNED_IN') {
            await commitPendingReferral();
            const user = session?.user ?? null;
            if (user) await syncAuthState(user.id);
            router.replace('/(tabs)' as Href);
          } else if (event === 'INITIAL_SESSION') {
            const user = session?.user ?? null;
            if (user) {
              await syncAuthState(user.id);
            }
          } else if (event === 'SIGNED_OUT') {
            await syncAuthState(null);
          }
        } catch (err) {
          console.error('[HoneySwing] auth state change error:', err);
        }
      }
    );
    return () => subscription.unsubscribe();
  }, []);

  // Task 7 + 14: reset tip frequency, positive reinforcement, and session accumulator
  const backgroundAtRef = useRef<number | null>(null);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background' || state === 'inactive') {
        backgroundAtRef.current = Date.now();
      } else if (state === 'active') {
        tipFrequencyLimiter.reset();
        positiveReinforcementEngine.reset();

        // Task 14: reset session accumulator if backgrounded >5 minutes
        const bg = backgroundAtRef.current;
        if (bg !== null && Date.now() - bg >= SESSION_TIMEOUT_MS) {
          sessionAccumulator.reset();
        }
        backgroundAtRef.current = null;
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
