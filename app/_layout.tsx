import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus, Linking } from 'react-native';
import { Stack, useRouter, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ClerkProvider, useUser } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { ensureProfile } from '../lib/ensureProfile';
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

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) {
  throw new Error('EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is not set');
}

// Keep splash visible while we initialize
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const router = useRouter();

  useEffect(() => {
    async function init() {
      configurePurchases();

      // Task 15: load age tier and apply to frequency limiter
      getAgeTier().then((tier) => tipFrequencyLimiter.setAgeTier(tier)).catch((err) => console.error('[HoneySwing]', err));

      // Check for referral link that opened the app (cold start)
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl) {
        await handleReferralUrl(initialUrl);
      }
      await commitPendingReferral();

      // Determine auth + onboarding state
      const { data: { session } } = await supabase.auth.getSession();
      const onboarded = await AsyncStorage.getItem(ONBOARDING_KEY);

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

    // Listen for deep links while app is already open (warm start)
    const subscription = Linking.addEventListener('url', async ({ url }) => {
      resetNavigationLock();
      await handleReferralUrl(url);
      router.replace('/(tabs)' as Href);
    });

    return () => subscription.remove();
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
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <AuthListener />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="signin" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="paywall" />
        <Stack.Screen name="analysis/result" />
        <Stack.Screen name="grip/capture" />
        <Stack.Screen name="grip/result" />
      </Stack>
    </ClerkProvider>
  );
}

function AuthListener() {
  const { user, isLoaded, isSignedIn } = useUser();
  const prevSignedInRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn && !user) return;
    const prev = prevSignedInRef.current;

    if (prev === null) {
      if (!isSignedIn) {
        invalidateSwingLimitCache();
      } else {
        (async () => {
          try {
            invalidateSwingLimitCache();
            await ensureProfile(user!.id);
            await syncAuthState(user!.id);
          } catch (err) {
            console.error('[HoneySwing] AuthListener INITIAL_SESSION error:', err);
          }
        })();
      }
      prevSignedInRef.current = isSignedIn === true;
      return;
    }

    if (prev === false && isSignedIn) {
      (async () => {
        try {
          invalidateSwingLimitCache();
          await ensureProfile(user!.id);
          await commitPendingReferral();
          await syncAuthState(user!.id);
          await migrateAnonSwings(user!.id);
        } catch (err) {
          console.error('[HoneySwing] AuthListener SIGNED_IN error:', err);
        }
      })();
      prevSignedInRef.current = true;
      return;
    }

    if (prev === true && !isSignedIn) {
      (async () => {
        try {
          invalidateSwingLimitCache();
          await syncAuthState(null);
        } catch (err) {
          console.error('[HoneySwing] AuthListener SIGNED_OUT error:', err);
        }
      })();
      prevSignedInRef.current = false;
      return;
    }
  }, [isLoaded, isSignedIn, user?.id]);

  return null;
}
