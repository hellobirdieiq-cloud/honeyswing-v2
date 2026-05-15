import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { GOLD } from '../../lib/colors';

export default function TabLayout() {
  return (
    <Tabs
      initialRouteName="record"
      screenOptions={{
        tabBarActiveTintColor: GOLD,
        tabBarStyle: { backgroundColor: '#111' },
        headerShown: false,
      }}
    >
      <Tabs.Screen name="record" options={{
        title: 'Record',
        tabBarIcon: ({ color, size }) => <Ionicons name="videocam-outline" size={size} color={color} />,
      }} />
      <Tabs.Screen name="history" options={{
        title: 'History',
        tabBarIcon: ({ color, size }) => <Ionicons name="time-outline" size={size} color={color} />,
      }} />
      <Tabs.Screen name="settings" options={{
        title: 'Settings',
        tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" size={size} color={color} />,
      }} />
      <Tabs.Screen name="recordStyles" options={{ href: null }} />
    </Tabs>
  );
}