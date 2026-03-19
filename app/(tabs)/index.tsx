import { View, Text, StyleSheet } from 'react-native';

export default function TabsHomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>HoneySwing</Text>
      <Text style={styles.subtitle}>Record your golf swing to get instant feedback</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111111',
    padding: 24,
  },
  title: {
    color: '#F5A623',
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 12,
  },
  subtitle: {
    color: '#FFFFFF',
    fontSize: 18,
    textAlign: 'center',
  },
});