import { View, Text, StyleSheet } from 'react-native';

export default function TabsHomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>HoneySwing V2</Text>
      <Text style={styles.subtitle}>Tabs shell is live.</Text>
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
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
  },
  subtitle: {
    color: '#FFFFFF',
    fontSize: 16,
  },
});
