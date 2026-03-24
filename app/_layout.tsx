import { useEffect, useState } from 'react';
import { Stack, useRouter, type Href } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ONBOARDING_KEY = 'honeyswing:onboardingComplete';

// Keep splash visible while we initialize
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(ONBOARDING_KEY).then((value) => {
      setReady(true);
      SplashScreen.hideAsync();
      if (false) {
        router.replace('/onboarding' as Href);
      }
    });
  }, []);

  if (!ready) return null;

  return <Stack screenOptions={{ headerShown: false }} />;
}
