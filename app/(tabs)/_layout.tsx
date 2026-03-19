import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default function TabLayout() {
  return (
    <Tabs screenOptions={{
      tabBarActiveTintColor: '#F5A623',
      tabBarStyle: { backgroundColor: '#111' },
      headerShown: false,
    }}>
      <Tabs.Screen name="index" options={{
        title: 'Home',
        tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={color} />,
      }} />
      <Tabs.Screen name="record" options={{
        title: 'Record',
        tabBarIcon: ({ color, size }) => <Ionicons name="videocam-outline" size={size} color={color} />,
      }} />
    </Tabs>
  );
}