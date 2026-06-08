import { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { getSwingHistory, type SwingHistoryRecord } from '../lib/swingStore';
import { getUserId } from '../lib/supabase';
import {
  scoreTempoTrafficLight,
  TEMPO_BAND_COLORS,
} from '../packages/domain/swing/scoring';
import { GOLD } from '../lib/colors';
import { getProfiles, getDisplayName, type PlayerProfile } from '../lib/playerProfiles';
import { parseDbTimestamp } from '../lib/datetime';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'ready'; rows: SwingHistoryRecord[] };

function formatDate(iso: string): string {
  const d = parseDbTimestamp(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function SwingHistoryList() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [profiles, setProfiles] = useState<PlayerProfile[]>([]);
  const [profileMap, setProfileMap] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<string>('all');

  useEffect(() => {
    getProfiles().then((ps) => {
      setProfiles(ps);
      setProfileMap(Object.fromEntries(ps.map((p) => [p.id, getDisplayName(p)])));
    }).catch((err) => console.error('[HoneySwing]', err));
  }, []);

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

  const isIndividualTab = activeTab !== 'all';
  const filteredRows =
    activeTab === 'all'
      ? state.rows
      : state.rows.filter((r) => r.player_profile_id === activeTab);

  const showTabs = profiles.length >= 2;

  return (
    <View style={{ flex: 1 }}>
      {showTabs && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabsRow}
        >
          <TabButton
            label="All"
            active={activeTab === 'all'}
            onPress={() => setActiveTab('all')}
          />
          {profiles.map((p) => (
            <TabButton
              key={p.id}
              label={getDisplayName(p)}
              active={activeTab === p.id}
              onPress={() => setActiveTab(p.id)}
            />
          ))}
        </ScrollView>
      )}
      {filteredRows.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyBody}>No swings recorded yet.</Text>
        </View>
      ) : (
        <FlatList
          data={filteredRows}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <SwingRow item={item} profileMap={profileMap} isIndividualTab={isIndividualTab} />
          )}
        />
      )}
    </View>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[styles.tab, active && styles.tabActive]}
    >
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function SwingRow({
  item,
  profileMap,
  isIndividualTab,
}: {
  item: SwingHistoryRecord;
  profileMap: Record<string, string>;
  isIndividualTab: boolean;
}) {
  const router = useRouter();
  const hasTempo = item.tempo_ratio != null && Number.isFinite(item.tempo_ratio);
  const band = hasTempo ? scoreTempoTrafficLight(item.tempo_ratio as number).band : null;
  const dotColor = band ? TEMPO_BAND_COLORS[band] : '#555';
  const ratioText = hasTempo
    ? (item.tempo_ratio as number).toFixed(2)
    : 'Tempo unavailable';
  const showScore = item.score != null;
  const scoreColor =
    hasTempo && scoreTempoTrafficLight(item.tempo_ratio as number).isGreen
      ? '#44CC44'
      : '#FFFFFF';
  const playerLabel = item.player_profile_id ? profileMap[item.player_profile_id] : null;
  const secondLine =
    playerLabel && !isIndividualTab ? `${playerLabel} · ${ratioText}` : ratioText;

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={() => router.push({ pathname: '/analysis/result', params: { swingId: item.id } })}
      activeOpacity={0.7}
    >
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      {showScore && (
        <Text style={[styles.rowScore, { color: scoreColor }]}>{item.score}</Text>
      )}
      <View style={styles.rowText}>
        <Text style={styles.rowDate}>{formatDate(item.created_at)}</Text>
        <Text style={styles.rowRatio}>{secondLine}</Text>
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
  rowScore: {
    fontSize: 18,
    fontWeight: '700',
    marginRight: 12,
    minWidth: 32,
    textAlign: 'right',
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
    color: '#1A0E00',
    fontSize: 16,
    fontWeight: '700',
  },
  tabsRow: {
    paddingVertical: 8,
    paddingHorizontal: 4,
    gap: 8,
  },
  tab: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#333',
    marginRight: 8,
    alignSelf: 'flex-start',
  },
  tabActive: {
    backgroundColor: `${GOLD}26`,
    borderColor: GOLD,
  },
  tabText: {
    color: '#999',
    fontSize: 13,
    fontWeight: '600',
  },
  tabTextActive: {
    color: GOLD,
  },
});
