/**
 * Coach view (coach pivot Phase 3): all linked kids' swings in one feed.
 *
 * Data comes RLS-scoped through lib/coachData.ts (roster = coach-granted
 * player_profiles rows; feed = coach-granted swings, own excluded). Chip/row
 * visuals deliberately copy SwingHistoryList's patterns rather than extract
 * shared components — the shipped history list stays untouched (dedup parked).
 */
import { useCallback, useState } from 'react';
import { View, Text, FlatList, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { getUserId } from '../../lib/supabase';
import { checkIsCoach } from '../../lib/referralAttribution';
import { getCoachSelf, getCoachRoster, getCoachSwings, type CoachSelf } from '../../lib/coachData';
import {
  buildKidLabelMap,
  resolveKidLabel,
  hasOrphanSwings,
  filterSwingsForTab,
  UNKNOWN_PLAYER_LABEL,
  UNKNOWN_TAB_ID,
  type CoachKid,
} from '../../lib/coachDataCore';
import type { SwingHistoryRecord } from '../../lib/swingStore';
import { scoreTempoTrafficLight, TEMPO_BAND_COLORS } from '../../packages/domain/swing/scoring';
import { parseDbTimestamp } from '../../lib/datetime';
import { GOLD } from '../../lib/colors';

type LoadState = 'loading' | 'notCoach' | 'ready';

function formatDate(iso: string): string {
  const d = parseDbTimestamp(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function CoachViewScreen() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>('loading');
  const [self, setSelf] = useState<CoachSelf | null>(null);
  const [roster, setRoster] = useState<CoachKid[]>([]);
  const [swings, setSwings] = useState<SwingHistoryRecord[]>([]);
  const [activeTab, setActiveTab] = useState<string>('all');

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const userId = await getUserId();
        const isCoach = await checkIsCoach(userId);
        if (cancelled) return;
        if (!isCoach) {
          setState('notCoach');
          return;
        }
        const [selfRow, kids, rows] = await Promise.all([
          getCoachSelf(),
          getCoachRoster(),
          getCoachSwings(),
        ]);
        if (cancelled) return;
        setSelf(selfRow);
        setRoster(kids);
        setSwings(rows);
        setState('ready');
      })().catch((err) => console.error('[HoneySwing]', err));
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const labelMap = buildKidLabelMap(roster);
  const filteredRows = filterSwingsForTab(swings, labelMap, activeTab);
  const showUnknownTab = hasOrphanSwings(swings, labelMap);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: 'My Players' }} />
      {state === 'loading' && (
        <View style={styles.centerWrap}>
          <ActivityIndicator color={GOLD} />
        </View>
      )}
      {state === 'notCoach' && (
        <View style={styles.centerWrap}>
          <Text style={styles.emptyTitle}>Coach access required</Text>
          <Text style={styles.emptyBody}>This view is for linked coaches.</Text>
        </View>
      )}
      {state === 'ready' && (
        <>
          {self && (
            <View style={styles.codeChip}>
              <Text style={styles.codeChipText}>
                Coach {self.name} · code: {self.code}
              </Text>
            </View>
          )}
          {roster.length === 0 && swings.length === 0 ? (
            <View style={styles.centerWrap}>
              <Text style={styles.emptyTitle}>No linked players yet</Text>
              <Text style={styles.emptyBody}>
                Parents add you in Settings → Add Coach
                {self ? ` with code: ${self.code}` : ''}.
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.tabsWrap}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.tabsRow}
                >
                  <TabButton label="All" active={activeTab === 'all'} onPress={() => setActiveTab('all')} />
                  {roster.map((k) => (
                    <TabButton
                      key={k.id}
                      label={k.display_name}
                      active={activeTab === k.id}
                      onPress={() => setActiveTab(k.id)}
                    />
                  ))}
                  {showUnknownTab && (
                    <TabButton
                      label={UNKNOWN_PLAYER_LABEL}
                      active={activeTab === UNKNOWN_TAB_ID}
                      onPress={() => setActiveTab(UNKNOWN_TAB_ID)}
                    />
                  )}
                </ScrollView>
              </View>
              {filteredRows.length === 0 ? (
                <View style={styles.centerWrap}>
                  <Text style={styles.emptyBody}>No swings yet.</Text>
                </View>
              ) : (
                <FlatList
                  data={filteredRows}
                  keyExtractor={(item) => item.id}
                  contentContainerStyle={styles.listContent}
                  renderItem={({ item }) => (
                    <SwingRow
                      item={item}
                      kidLabel={resolveKidLabel(labelMap, item.player_profile_id)}
                      onPress={() =>
                        router.push({ pathname: '/analysis/result', params: { swingId: item.id } })
                      }
                    />
                  )}
                />
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={[styles.tab, active && styles.tabActive]}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function SwingRow({
  item,
  kidLabel,
  onPress,
}: {
  item: SwingHistoryRecord;
  kidLabel: string;
  onPress: () => void;
}) {
  const hasTempo = item.tempo_ratio != null && Number.isFinite(item.tempo_ratio);
  const band = hasTempo ? scoreTempoTrafficLight(item.tempo_ratio as number).band : null;
  const dotColor = band ? TEMPO_BAND_COLORS[band] : '#555';
  const ratioText = hasTempo ? (item.tempo_ratio as number).toFixed(2) : 'Tempo unavailable';

  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      {item.score != null && <Text style={styles.rowScore}>{item.score}</Text>}
      <View style={styles.rowText}>
        <Text style={styles.rowDate}>{formatDate(item.created_at)}</Text>
        <Text style={styles.rowRatio}>{`${kidLabel} · ${ratioText}`}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    paddingHorizontal: 16,
  },
  centerWrap: {
    marginTop: 48,
    alignItems: 'center',
    paddingHorizontal: 24,
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
  },
  codeChip: {
    alignSelf: 'flex-start',
    backgroundColor: '#1A1A1C',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: GOLD,
    paddingVertical: 6,
    paddingHorizontal: 14,
    marginTop: 12,
  },
  codeChipText: {
    color: GOLD,
    fontSize: 13,
    fontWeight: '600',
  },
  tabsWrap: {
    marginTop: 8,
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
    color: '#fff',
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
});
