import { useCallback, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ScrollView, Alert } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useFocusEffect, useRouter } from 'expo-router';
import { getSwingHistory, type SwingHistoryRecord } from '../lib/swingStore';
import { getUserId } from '../lib/supabase';
import { deleteSwing } from '../lib/deleteSwing';
import {
  scoreTempoTrafficLight,
  TEMPO_BAND_COLORS,
} from '../packages/domain/swing/scoring';
import { GOLD } from '../lib/colors';
import { getProfiles, getDisplayName, type PlayerProfile } from '../lib/playerProfiles';
import { reassignSwing } from '../lib/reassignSwing';
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

// Putt accents (History v2) — matches the record screen's Putt pill orange.
const PUTT_COLOR = '#FF9500';

export default function SwingHistoryList() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [profiles, setProfiles] = useState<PlayerProfile[]>([]);
  const [profileMap, setProfileMap] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<string>('all');
  // History v2 type filter — combines with the kid tab (kid AND type).
  const [typeFilter, setTypeFilter] = useState<'all' | 'swing' | 'putt'>('all');

  // Profiles refresh on focus (not mount-only): rows already refetch on focus,
  // so a kid added/renamed/deleted while away would otherwise desync the tabs.
  // If the active tab's profile vanished, fall back to 'all' — filtering rows
  // by a deleted profile_id otherwise shows a permanently empty list.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      getProfiles().then((ps) => {
        if (cancelled) return;
        setProfiles(ps);
        setProfileMap(Object.fromEntries(ps.map((p) => [p.id, getDisplayName(p)])));
        setActiveTab((cur) => (cur !== 'all' && !ps.some((p) => p.id === cur) ? 'all' : cur));
      }).catch((err) => console.error('[HoneySwing]', err));
      return () => { cancelled = true; };
    }, []),
  );

  // Move-to-profile picker: one Alert button per player (≤4 kids in practice;
  // switch to an action sheet if profile counts grow). Also the manual fix
  // for legacy swings with null / orphaned player_profile_id (found in "All").
  const handleMoveRequest = useCallback(
    (swingId: string, currentProfileId: string | null) => {
      const targets = profiles.filter((p) => p.id !== currentProfileId);
      if (targets.length === 0) {
        Alert.alert('No other players', 'Add another player in Settings first.');
        return;
      }
      Alert.alert('Move swing', 'Assign this swing to:', [
        ...targets.map((p) => ({
          text: getDisplayName(p),
          onPress: () => {
            void (async () => {
              const ok = await reassignSwing(swingId, p.id);
              if (!ok) {
                Alert.alert('Move failed', 'Could not move the swing. Please try again.');
                return;
              }
              setState((prev) =>
                prev.kind === 'ready'
                  ? {
                      kind: 'ready',
                      rows: prev.rows.map((r) =>
                        r.id === swingId ? { ...r, player_profile_id: p.id } : r,
                      ),
                    }
                  : prev,
              );
            })();
          },
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    },
    [profiles],
  );

  const handleDeleteRequest = useCallback((swingId: string) => {
    Alert.alert(
      'Delete swing?',
      'This removes the swing and its video permanently.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const ok = await deleteSwing(swingId);
              if (ok) {
                setState((prev) =>
                  prev.kind === 'ready'
                    ? { kind: 'ready', rows: prev.rows.filter((r) => r.id !== swingId) }
                    : prev,
                );
              } else {
                Alert.alert('Delete failed', 'Could not delete the swing. Please try again.');
              }
            })();
          },
        },
      ],
    );
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
        // History v2: this list is the ONE consumer that opts into putt rows
        // (gallery/coach keep the default putt-free query).
        const rows = await getSwingHistory({ includePutts: true });
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
  // Kid AND type (History v2). Client-side by design at current scale — see
  // the threshold note on getSwingHistory.
  const filteredRows = state.rows.filter((r) => {
    const matchesKid = activeTab === 'all' || r.player_profile_id === activeTab;
    const isPutt = r.analysis_version === 'putt-v1';
    const matchesType = typeFilter === 'all' || (typeFilter === 'putt') === isPutt;
    return matchesKid && matchesType;
  });

  const showKidTabs = profiles.length >= 2;

  return (
    // Local root view (app root has none — record.tsx does the same): required
    // ancestor for the row Swipeables.
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Filter block — two rows, CONTENT-SIZED. The previous layout put the
          filters in a bare horizontal ScrollView, which as a flex child grows
          to split the column's height with the list — that inflated band
          (with the stretch divider through it) was the ~200pt dead gap. The
          block is plain Views + a flexGrow:0 scroller, so cards start
          directly below with normal spacing. */}
      <View style={styles.filtersBlock}>
        {showKidTabs && (
          <View style={styles.filterGroup}>
            <Text style={styles.filterCaption}>Player</Text>
            {/* Chips scroll HORIZONTALLY only if players ever overflow one
                row (5+ kids at 390pt); content-sized chips never clip or
                ellipsize names. No dropdown by design. */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.playerScroll}
              contentContainerStyle={styles.playerRow}
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
          </View>
        )}
        <View style={styles.filterGroup}>
          <Text style={styles.filterCaption}>Type</Text>
          {/* All | Swing | Putt segmented control (result-screen View/Speed
              idiom, duplicated locally — resultStyles is analysis-only by
              convention). All = today's combined default; the segmented
              radio replaces the old tap-active-clears chip gesture, same
              capability. Content-sized, never stretched. */}
          <View style={styles.segmentedControl}>
            {([
              { value: 'all', label: 'All' },
              { value: 'swing', label: 'Swing' },
              { value: 'putt', label: 'Putt' },
            ] as const).map(({ value, label }) => (
              <TouchableOpacity
                key={value}
                style={[styles.segment, typeFilter === value && styles.segmentActive]}
                onPress={() => setTypeFilter(value)}
                activeOpacity={0.7}
              >
                <Text
                  style={[styles.segmentText, typeFilter === value && styles.segmentTextActive]}
                  numberOfLines={1}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>
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
            <SwingRow
              item={item}
              profileMap={profileMap}
              isIndividualTab={isIndividualTab}
              onDeleteRequest={handleDeleteRequest}
              onMoveRequest={handleMoveRequest}
            />
          )}
        />
      )}
    </GestureHandlerRootView>
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
  onDeleteRequest,
  onMoveRequest,
}: {
  item: SwingHistoryRecord;
  profileMap: Record<string, string>;
  isIndividualTab: boolean;
  onDeleteRequest: (swingId: string) => void;
  onMoveRequest: (swingId: string, currentProfileId: string | null) => void;
}) {
  const router = useRouter();
  const isPutt = item.analysis_version === 'putt-v1';
  const hasTempo = item.tempo_ratio != null && Number.isFinite(item.tempo_ratio);
  const band = hasTempo ? scoreTempoTrafficLight(item.tempo_ratio as number).band : null;
  // Putt rows skip the full-swing traffic light (its bands are swing-tempo
  // anchored — a good putt ratio ~2.0 would band misleadingly) and use the
  // putt orange (matches the record-screen mode pill).
  const dotColor = isPutt ? PUTT_COLOR : band ? TEMPO_BAND_COLORS[band] : '#555';
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
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={(_progress, _translation, methods) => (
        <View style={styles.rowActions}>
          <TouchableOpacity
            style={styles.moveAction}
            activeOpacity={0.7}
            onPress={() => {
              methods.close();
              onMoveRequest(item.id, item.player_profile_id ?? null);
            }}
          >
            <Text style={styles.moveActionText}>Move</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.deleteAction}
            activeOpacity={0.7}
            onPress={() => {
              methods.close();
              onDeleteRequest(item.id);
            }}
          >
            <Text style={styles.deleteActionText}>Delete</Text>
          </TouchableOpacity>
        </View>
      )}
    >
      <TouchableOpacity
        style={styles.row}
        onPress={() =>
          router.push({
            pathname: isPutt ? '/putting/result' : '/analysis/result',
            params: { swingId: item.id },
          })
        }
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
        {isPutt && (
          <View style={styles.puttTag}>
            <Text style={styles.puttTagText}>PUTT</Text>
          </View>
        )}
      </TouchableOpacity>
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create({
  // ── filter block (two content-sized rows; no divider — the rows separate
  //    themselves). Captions mirror the result screen's VIEW/SPEED muted-caps
  //    convention (controlGroupLabel). ──
  filtersBlock: {
    paddingVertical: 8,
    paddingHorizontal: 4,
    gap: 10,
  },
  filterGroup: {
    gap: 4,
  },
  filterCaption: {
    color: '#666',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginLeft: 4,
  },
  // flexGrow:0 is the gap fix — without it a ScrollView flex-child inflates
  // vertically and pushes the list down.
  playerScroll: {
    flexGrow: 0,
  },
  playerRow: {
    gap: 8,
    alignItems: 'center',
  },
  // Segmented control — result-screen View/Speed styling, duplicated locally
  // (resultStyles is analysis-only by convention).
  segmentedControl: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    backgroundColor: '#1A1A1C',
    borderRadius: 10,
    padding: 3,
    gap: 3,
  },
  segment: {
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  segmentActive: {
    backgroundColor: GOLD,
  },
  segmentText: {
    color: '#999',
    fontSize: 13,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: '#111',
  },
  puttTag: {
    borderWidth: 1,
    borderColor: PUTT_COLOR,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginLeft: 8,
  },
  puttTagText: {
    color: PUTT_COLOR,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
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
  rowActions: {
    flexDirection: 'row',
  },
  // marginBottom matches styles.row so the revealed buttons track row height.
  moveAction: {
    backgroundColor: '#2C2C2E',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    width: 88,
    marginBottom: 10,
    marginLeft: 8,
  },
  moveActionText: {
    color: GOLD,
    fontSize: 15,
    fontWeight: '700',
  },
  deleteAction: {
    backgroundColor: '#CC3333',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    width: 88,
    marginBottom: 10,
    marginLeft: 8,
  },
  deleteActionText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
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
  // Player chips — compact, content-sized (names render fully, no ellipsis;
  // spacing via the row's gap, no per-chip margin).
  tab: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#333',
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
