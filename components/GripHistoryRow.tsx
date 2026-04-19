import { useCallback, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase, getUserId } from '../lib/supabase';

// Duplicate of the const at app/analysis/result.tsx:38-42.
// Extraction to a shared lib is deferred — see plan FUTURE ONLY.
const GRIP_CHIP_COLORS: Record<string, string> = {
  solid: '#00FF66',
  playable: '#FFB020',
  needs_adjustment: '#FF4444',
};

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_ROWS = 3;

type Row = {
  id: string;
  created_at: string;
  grip_overall: string | null;
  grip_failed: string | null;
};

export default function GripHistoryRow() {
  const [rows, setRows] = useState<Row[] | null>(null);
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
        const userId = await getUserId();
        if (!userId) {
          if (!cancelled) setRows([]);
          return;
        }
        const since = new Date(Date.now() - WINDOW_MS).toISOString();
        const { data, error } = await supabase
          .from('swings')
          .select(
            'id, created_at, grip_overall:swing_debug->grip_cloud->>overall, grip_failed:swing_debug->grip_cloud->>analysis_failed',
          )
          .eq('user_id', userId)
          .gte('created_at', since)
          .not('swing_debug->grip_cloud', 'is', null)
          .not('swing_debug->grip_cloud->>overall', 'is', null)
          .or(
            'swing_debug->grip_cloud->>analysis_failed.is.null,swing_debug->grip_cloud->>analysis_failed.neq.true',
          )
          .order('created_at', { ascending: false });
        if (cancelled) return;
        if (error) {
          console.error('[HoneySwing] grip history fetch error:', error.message);
          setRows([]);
          return;
        }
        setRows((data ?? []) as Row[]);
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
