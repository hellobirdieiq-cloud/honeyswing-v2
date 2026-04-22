import { useCallback, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { getGripHistory, type GripHistoryRecord } from '../lib/swingStore';

// Duplicate of the const at app/analysis/result.tsx:38-42.
// Extraction to a shared lib is deferred — see plan FUTURE ONLY.
const GRIP_CHIP_COLORS: Record<string, string> = {
  solid: '#00FF66',
  playable: '#FFB020',
  needs_adjustment: '#FF4444',
};

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_ROWS = 3;

export default function GripHistoryRow() {
  const [rows, setRows] = useState<GripHistoryRecord[] | null>(null);
  const loggedOnceRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      if (!loggedOnceRef.current) {
        loggedOnceRef.current = true;
        setTimeout(() => {
        }, 500);
      }

      let cancelled = false;
      (async () => {
        const fetched = await getGripHistory({ windowMs: WINDOW_MS });
        if (cancelled) return;
        setRows(fetched);
      })();

      return () => {
        cancelled = true;
      };
    }, []),
  );

  if (rows === null) return null;

  // Plan §4 exception: enum membership validated client-side because SQL cannot express it cleanly.
  const usable = rows.filter(
    (r) => r.grip_overall != null && r.grip_overall in GRIP_CHIP_COLORS,
    // Type narrow for `in` operator — null filtering already done server-side
  );

  if (usable.length < MIN_ROWS) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.empty}>Record a few swings to see your grip history</Text>
      </View>
    );
  }

  // Reverse DESC → ASC so newest sits on the right edge of the scroll content.
  const forRender = [...usable].reverse();

  return (
    <View style={styles.wrap}>
      <Text style={styles.header}>Last 30 days — {usable.length} swings</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {forRender.map((r) => (
          <View
            key={r.id}
            style={[styles.tile, { backgroundColor: GRIP_CHIP_COLORS[r.grip_overall as string] }]}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    marginTop: 24,
  },
  header: {
    color: '#999',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
    marginBottom: 8,
    textAlign: 'center',
  },
  row: {
    gap: 6,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  tile: {
    width: 56,
    height: 56,
    borderRadius: 8,
  },
  empty: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
  },
});
