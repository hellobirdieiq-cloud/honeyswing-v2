import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, Linking } from 'react-native';
import { Stack, useRouter, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { handleReferralUrl, commitPendingReferral } from '../lib/referralAttribution';
import { tryNavigate, resetNavigationLock } from '../lib/navigationLock';
import { configurePurchases, syncAuthState } from '../lib/purchases';
import { invalidateSwingLimitCache } from '../lib/swingLimit';
import { tipFrequencyLimiter } from '../lib/tipFrequency';
import { positiveReinforcementEngine } from '../lib/positiveReinforcement';
import { sessionAccumulator } from '../lib/sessionAccumulator';
import { STORAGE_KEYS } from '../lib/storageKeys';
import { getAgeTier } from '../lib/ageTier';
import { migrateAnonSwings } from '../lib/migrateAnonSwings';

/** Session resets after this many ms in background */
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const ONBOARDING_KEY = STORAGE_KEYS.onboardingComplete;

// Keep splash visible while we initialize
SplashScreen.preventAutoHideAsync();

function extractCodeFromUrl(url: string): string | null {
  // PKCE flow: Supabase redirects with ?code=XXXXXX (query param, not fragment).
  // Short code in query params avoids the iOS/Hermes fragment-truncation bug
  // that caused ~12-char refresh_tokens under the implicit flow.
  const match = url.match(/[?&]code=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

let pkceSessionEstablished = false;

function exchangeWithTimeout(code: string, ms: number) {
  return Promise.race([
    supabase.auth.exchangeCodeForSession(code),
    new Promise<{ data: null; error: { message: string } }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: { message: 'Exchange timeout' } }), ms),
    ),
  ]);
}

async function handleAuthUrl(url: string): Promise<boolean> {
  const code = extractCodeFromUrl(url);
  if (!code) return false;

  pkceSessionEstablished = false;

  const { error } = await exchangeWithTimeout(code, 6000);

  if (error) {
    if (!pkceSessionEstablished) {
      return false;
    }
  }

  return pkceSessionEstablished || !error;
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
      }
      await commitPendingReferral();

      // Determine auth + onboarding state
      const { data: { session } } = await supabase.auth.getSession();
      const onboarded = await AsyncStorage.getItem(ONBOARDING_KEY);

      setReady(true);
      SplashScreen.hideAsync();

      // Redirect after splash hides so the navigator is fully mounted
      if (initialUrl) {
        if (tryNavigate()) router.replace(onboarded ? '/(tabs)' as Href : '/onboarding' as Href);
      } else if (session && !onboarded) {
        router.replace('/onboarding' as Href);
      }
    }

    init().catch((err) => {
      console.error('[HoneySwing] init crashed:', err);
      SplashScreen.hideAsync();
    });

    // Listen for magic link while app is already open (warm start)
    const subscription = Linking.addEventListener('url', async ({ url }) => {
      if (url.includes('code=')) {
        tryNavigate(); // consume lock — blocks onAuthStateChange from navigating
        await new Promise(resolve => setTimeout(resolve, 500));

        handleAuthUrl(url)
          .then(async () => {
            resetNavigationLock();
            const onboarded = await AsyncStorage.getItem(ONBOARDING_KEY);
            if (tryNavigate()) router.replace(onboarded ? '/(tabs)' as Href : '/onboarding' as Href);
          })
          .catch(async () => {
            resetNavigationLock();

            if (!pkceSessionEstablished) {
              const onboarded = await AsyncStorage.getItem(ONBOARDING_KEY);
              if (tryNavigate()) router.replace(onboarded ? '/(tabs)' as Href : '/onboarding' as Href);
            }
          });
        return;
      }

      // Non-auth deep links (referrals, etc.)
      resetNavigationLock();
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
            pkceSessionEstablished = true;
            invalidateSwingLimitCache();
            await commitPendingReferral();
            const user = session?.user ?? null;
            if (user) await syncAuthState(user.id);
            if (session) await migrateAnonSwings(session.user.id);
            const onboarded = await AsyncStorage.getItem(ONBOARDING_KEY);
            if (tryNavigate()) router.replace(onboarded ? '/(tabs)' as Href : '/onboarding' as Href);
          } else if (event === 'INITIAL_SESSION') {
            invalidateSwingLimitCache();
            const user = session?.user ?? null;
            if (user) {
              await syncAuthState(user.id);
            }
          } else if (event === 'SIGNED_OUT') {
            invalidateSwingLimitCache();
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
