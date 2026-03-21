import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';

export default function TabsHomeScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <Text style={styles.title}>HoneySwing</Text>
        <Text style={styles.subtitle}>Your pocket swing coach</Text>
      </View>

      <TouchableOpacity
        style={styles.cta}
        onPress={() => router.push('/(tabs)/record')}
        activeOpacity={0.8}
      >
        <Text style={styles.ctaText}>Start Swinging</Text>
      </TouchableOpacity>

      <Text style={styles.hint}>Record a swing and get instant feedback</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
    padding: 24,
  },
  hero: {
    alignItems: 'center',
    marginBottom: 48,
  },
  title: {
    color: '#F5A623',
    fontSize: 36,
    fontWeight: '800',
    marginBottom: 8,
  },
  subtitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '500',
  },
  cta: {
    backgroundColor: '#F5A623',
    paddingVertical: 18,
    paddingHorizontal: 48,
    borderRadius: 16,
    marginBottom: 20,
  },
  ctaText: {
    color: '#111',
    fontSize: 20,
    fontWeight: '700',
  },
  hint: {
    color: '#666',
    fontSize: 14,
  },
});
