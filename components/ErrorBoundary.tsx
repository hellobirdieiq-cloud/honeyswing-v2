import { Text, View, TouchableOpacity, StyleSheet } from 'react-native';
import type { ErrorBoundaryProps } from 'expo-router';
import { GOLD } from '../lib/colors';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.subtitle}>
        The app hit an unexpected error. Tap below to try again.
      </Text>
      {__DEV__ && <Text style={styles.devDetail}>{error.message}</Text>}
      <TouchableOpacity style={styles.cta} onPress={retry} activeOpacity={0.8}>
        <Text style={styles.ctaText}>Try Again</Text>
      </TouchableOpacity>
    </View>
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
  devDetail: {
    color: '#999',
    fontSize: 13,
    fontFamily: 'Courier',
    marginBottom: 24,
  },
  cta: {
    backgroundColor: GOLD,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  ctaText: {
    color: '#1A0E00',
    fontSize: 18,
    fontWeight: '700',
  },
});
