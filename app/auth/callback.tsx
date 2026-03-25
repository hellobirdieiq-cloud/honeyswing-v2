import { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter, useLocalSearchParams, type Href } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../lib/supabase';

const ONBOARDING_KEY = 'honeyswing:onboardingComplete';

export default function AuthCallbackScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  useEffect(() => {
    async function handleCallback() {
      // Expo Router delivers the fragment as search params on this screen
      const accessToken =
        (params.access_token as string) ?? (params['#access_token'] as string);
      const refreshToken = params.refresh_token as string;

      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });

        if (error) {
          console.error('[HoneySwing] auth callback setSession error:', error.message);
          router.replace('/(tabs)' as Href);
          return;
        }
      }

      const onboarded = await AsyncStorage.getItem(ONBOARDING_KEY);
      if (onboarded) {
        router.replace('/(tabs)' as Href);
      } else {
        router.replace('/onboarding' as Href);
      }
    }

    handleCallback();
  }, []);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#F5A623" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
