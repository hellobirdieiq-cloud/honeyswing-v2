import React, { useState } from 'react';
import { Pressable, Text, Vibration, View } from 'react-native';
import Tab1LiveView from './Tab1LiveView';
import Tab2KidView from './Tab2KidView';
import Tab3DrillDown from './Tab3DrillDown';
import Tab4Raw from './Tab4Raw';
import { GOLD } from '@/lib/colors';
import { styles } from '../clinicStyles';

type TabIndex = 0 | 1 | 2 | 3;

const TABS: { index: TabIndex; label: string }[] = [
  { index: 0, label: 'LIVE' },
  { index: 1, label: 'KID' },
  { index: 2, label: 'DRILL' },
  { index: 3, label: 'RAW' },
];

function tap(): void {
  Vibration.vibrate(10);
}

export default function CoachModeScreen(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<TabIndex>(0);

  return (
    <View style={styles.screen}>
      {activeTab === 0 ? <Tab1LiveView /> : null}
      {activeTab === 1 ? <Tab2KidView /> : null}
      {activeTab === 2 ? <Tab3DrillDown /> : null}
      {activeTab === 3 ? <Tab4Raw /> : null}

      <View style={styles.coachTabBar}>
        {TABS.map((t) => {
          const isActive = activeTab === t.index;
          return (
            <Pressable
              key={t.index}
              onPress={() => {
                tap();
                setActiveTab(t.index);
              }}
              style={[styles.coachTabBarItem, isActive && styles.coachTabBarItemActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <Text
                style={{
                  color: isActive ? GOLD : 'rgba(255,255,255,0.7)',
                  fontSize: 12,
                  fontWeight: '700',
                  letterSpacing: 1,
                }}
              >
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
