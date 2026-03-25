import { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ONBOARDING_KEY = 'honeyswing:onboardingComplete';

export default function AuthCallbackScreen() {
  const router = useRouter();

  useEffect(() => {
    async function handleCallback() {
      // Session is already set by _layout.tsx via Linking.getInitialURL()
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
