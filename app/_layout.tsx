import { useEffect } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';

// Keep splash visible while we initialize
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  useEffect(() => {
    // Hide splash screen after layout mounts
    SplashScreen.hideAsync();
  }, []);

  return <Stack screenOptions={{ headerShown: false }} />;
}