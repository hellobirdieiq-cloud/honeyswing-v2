import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { GOLD } from '../../lib/colors';
import FloatingTabBar from '../../components/FloatingTabBar';

export default function TabLayout() {
  return (
    <Tabs
      initialRouteName="record"
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        tabBarActiveTintColor: GOLD,
        headerShown: false,
      }}
    >
      <Tabs.Screen name="record" options={{
        title: 'Record',
        tabBarIcon: ({ color, size }) => <Ionicons name="videocam-outline" size={size} color={color} />,
      }} />
      <Tabs.Screen name="history" options={{
        title: 'Progress',
        tabBarIcon: ({ color, size }) => <Ionicons name="stats-chart-outline" size={size} color={color} />,
      }} />
      <Tabs.Screen name="gallery" options={{
        title: 'Art',
        tabBarIcon: ({ color, size }) => <Ionicons name="images-outline" size={size} color={color} />,
      }} />
      <Tabs.Screen name="grip" options={{
        title: 'Grip',
        tabBarIcon: ({ color, size }) => <Ionicons name="hand-right-outline" size={size} color={color} />,
      }} />
      <Tabs.Screen name="settings" options={{
        title: 'Settings',
        tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" size={size} color={color} />,
      }} />
      <Tabs.Screen name="recordStyles" options={{ href: null }} />
    </Tabs>
  );
}