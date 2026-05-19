import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { GOLD } from '../../lib/colors';
import { presentLiDARDemo } from '../../lib/lidarDemo';

export default function GripScreen() {
  const router = useRouter();
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Grip</Text>
      <View style={styles.buttonGroup}>
        <TouchableOpacity
          style={styles.btn}
          activeOpacity={0.8}
          onPress={() => Alert.alert('Coming soon', 'Apple Vision Hand Pose support is not available yet.')}
        >
          <Text style={styles.btnText}>Vision</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          activeOpacity={0.8}
          onPress={() => router.push('/grip/capture' as Href)}
        >
          <Text style={styles.btnText}>Media Pose</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          activeOpacity={0.8}
          onPress={() => Alert.alert('Coming soon', 'RTMPose support is not available yet.')}
        >
          <Text style={styles.btnText}>RTM</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.btn}
          activeOpacity={0.8}
          onPress={() => { presentLiDARDemo(); }}
        >
          <Text style={styles.btnText}>LiDAR Demo</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111', padding: 24, paddingTop: 80 },
  title: { color: GOLD, fontSize: 28, fontWeight: '800', marginBottom: 8 },
  buttonGroup: {
    marginTop: 32,
    gap: 12,
    alignItems: 'center',
  },
  btn: {
    width: '65%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(245, 166, 35, 0.2)',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 12,
  },
  btnText: { color: GOLD, fontSize: 14, fontWeight: '600' },
});
