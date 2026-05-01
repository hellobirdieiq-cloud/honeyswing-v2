import { View, Text, StyleSheet } from 'react-native';
import { GOLD } from '../../lib/colors';
import GripHistoryRow from '../../components/GripHistoryRow';

export default function HistoryScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>History</Text>
      <GripHistoryRow />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    padding: 24,
    paddingTop: 80,
  },
  title: {
    color: GOLD,
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 8,
  },
});
