import { useCallback, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { getSwingHistory, type SwingHistoryRecord } from '../lib/swingStore';
import { getUserId } from '../lib/supabase';
import {
  scoreTempoTrafficLight,
  TEMPO_BAND_COLORS,
} from '../packages/domain/swing/scoring';
import { GOLD } from '../lib/colors';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'ready'; rows: SwingHistoryRecord[] };

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function SwingHistoryList() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const userId = await getUserId();
        if (cancelled) return;
        if (!userId) {
          setState({ kind: 'anonymous' });
          return;
        }
        const rows = await getSwingHistory();
        if (cancelled) return;
        setState({ kind: 'ready', rows });
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  if (state.kind === 'loading') {
    return null;
  }

  if (state.kind === 'anonymous') {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyTitle}>Sign in to see your history.</Text>
        <Text style={styles.emptyBody}>Swings are saved to your account.</Text>
        <TouchableOpacity
          style={styles.signInButton}
          onPress={() => router.push('/signin')}
          activeOpacity={0.7}
        >
          <Text style={styles.signInButtonText}>Sign In</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (state.rows.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyBody}>No swings recorded yet.</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={state.rows}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.listContent}
      renderItem={({ item }) => <SwingRow item={item} />}
    />
  );
}

function SwingRow({ item }: { item: SwingHistoryRecord }) {
  const router = useRouter();
  const hasTempo = item.tempo_ratio != null && Number.isFinite(item.tempo_ratio);
  const band = hasTempo ? scoreTempoTrafficLight(item.tempo_ratio as number).band : null;
  const dotColor = band ? TEMPO_BAND_COLORS[band] : '#555';
  const ratioText = hasTempo
    ? (item.tempo_ratio as number).toFixed(2)
    : 'Tempo unavailable';

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={() => router.push({ pathname: '/analysis/result', params: { swingId: item.id } })}
      activeOpacity={0.7}
    >
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <View style={styles.rowText}>
        <Text style={styles.rowDate}>{formatDate(item.created_at)}</Text>
        <Text style={styles.rowRatio}>{ratioText}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingTop: 8,
    paddingBottom: 24,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1C',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    marginRight: 14,
  },
  rowText: {
    flex: 1,
  },
  rowDate: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  rowRatio: {
    color: '#999',
    fontSize: 13,
    marginTop: 2,
  },
  emptyWrap: {
    marginTop: 24,
    alignItems: 'center',
  },
  emptyTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
    textAlign: 'center',
  },
  emptyBody: {
    color: '#999',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  signInButton: {
    backgroundColor: GOLD,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 28,
    marginTop: 4,
  },
  signInButtonText: {
    color: '#111',
    fontSize: 16,
    fontWeight: '700',
  },
});
