import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import {
  getSwingHistory,
  getSwingMotionFramesBatch,
  type SwingHistoryRecord,
  type SwingMotionEntry,
} from '../../lib/swingStore';
import { toggleSwingFavorite } from '../../lib/toggleSwingFavorite';
import { getUserId } from '../../lib/supabase';
import SwingArtCard from '../../components/SwingArtCard';
import { GOLD } from '../../lib/colors';

// SVG art cards are expensive to render, so reveal the grid in pages and let
// FlatList virtualize. Each page also drives one batched motion_frames fetch.
const PAGE_SIZE = 8;
const COLUMNS = 2;
const H_PADDING = 16;
const GAP = 12;
// SwingArtCard wraps its square art box in a `card` View with marginTop 24 +
// marginBottom 12. Each cell reserves that chrome so its height is fixed and
// identical to the placeholder's, regardless of render state (prevents the
// collapse that detached the hearts).
const CARD_CHROME = 36;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'ready'; rows: SwingHistoryRecord[] };

export default function GalleryScreen() {
  const router = useRouter();
  const { width: screenW } = useWindowDimensions();
  const cellWidth = (screenW - H_PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS;

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [filter, setFilter] = useState<'all' | 'favorites'>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [framesMap, setFramesMap] = useState<Map<string, SwingMotionEntry>>(new Map());
  // Ids we've already issued a fetch for (loaded or returned null) — guards
  // against re-fetching frames for cells that scroll in and out of view, and
  // against re-requesting failed-stub swings that will never have frames.
  const requestedRef = useRef<Set<string>>(new Set());

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

  const rows = state.kind === 'ready' ? state.rows : [];
  // Favorites filter is purely local — is_favorite already rides along in the
  // SWING_HISTORY_COLUMNS list query, so no extra fetch.
  const filteredRows = filter === 'favorites' ? rows.filter((r) => r.is_favorite) : rows;
  const visibleRows = filteredRows.slice(0, visibleCount);

  // Batch-load frames for any visible swing we haven't requested yet.
  const loadFramesFor = useCallback(async (items: SwingHistoryRecord[]) => {
    const toFetch = items
      .map((r) => r.id)
      .filter((id) => !requestedRef.current.has(id));
    if (toFetch.length === 0) return;
    toFetch.forEach((id) => requestedRef.current.add(id));
    const fetched = await getSwingMotionFramesBatch(toFetch);
    if (fetched.size === 0) return;
    setFramesMap((prev) => {
      const next = new Map(prev);
      fetched.forEach((entry, id) => next.set(id, entry));
      return next;
    });
  }, []);

  // Whenever the visible window grows, the filter changes, or a focus refresh
  // swaps the rows, ensure the visible cells' frames are loading. Recompute the
  // filtered window here (not via filteredRows) to keep deps primitive/stable.
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const base =
      filter === 'favorites' ? state.rows.filter((r) => r.is_favorite) : state.rows;
    loadFramesFor(base.slice(0, visibleCount));
  }, [state, filter, visibleCount, loadFramesFor]);

  const onEndReached = useCallback(() => {
    setVisibleCount((c) => (c < filteredRows.length ? c + PAGE_SIZE : c));
  }, [filteredRows.length]);

  const renderItem = useCallback(
    ({ item }: { item: SwingHistoryRecord }) => (
      <GalleryCell
        swingId={item.id}
        initialFavorite={item.is_favorite}
        entry={framesMap.get(item.id)}
        width={cellWidth}
      />
    ),
    [framesMap, cellWidth],
  );

  if (state.kind === 'loading') {
    return <View style={styles.container} />;
  }

  if (state.kind === 'anonymous') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Swing Art</Text>
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>Sign in to see your swing art.</Text>
          <Text style={styles.emptyBody}>Swings are saved to your account.</Text>
          <TouchableOpacity
            style={styles.signInButton}
            onPress={() => router.push('/signin')}
            activeOpacity={0.7}
          >
            <Text style={styles.signInButtonText}>Sign In</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Swing Art</Text>
      {rows.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyBody}>No swings recorded yet.</Text>
        </View>
      ) : (
        <>
          <View style={styles.filterRow}>
            <FilterButton label="All" active={filter === 'all'} onPress={() => setFilter('all')} />
            <FilterButton
              label="Favorites"
              active={filter === 'favorites'}
              onPress={() => setFilter('favorites')}
            />
          </View>
          {filteredRows.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyBody}>No favorites yet.</Text>
            </View>
          ) : (
            <FlatList
              data={visibleRows}
              keyExtractor={(item) => item.id}
              numColumns={COLUMNS}
              columnWrapperStyle={styles.columnWrapper}
              contentContainerStyle={styles.listContent}
              renderItem={renderItem}
              onEndReached={onEndReached}
              onEndReachedThreshold={0.6}
              initialNumToRender={PAGE_SIZE}
              maxToRenderPerBatch={PAGE_SIZE}
              windowSize={5}
            />
          )}
        </>
      )}
    </View>
  );
}

function FilterButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={[styles.filterButton, active && styles.filterButtonActive]}
    >
      <Text style={[styles.filterText, active && styles.filterTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// Memoized so updates to framesMap for other cells don't re-render (and
// re-rasterize the SVG of) this one. Props are all stable references (string,
// boolean, number, and the map entry which we merge rather than rebuild), so
// the default shallow compare keeps idle cells from re-rendering.
const GalleryCell = React.memo(function GalleryCell({
  swingId,
  initialFavorite,
  entry,
  width,
}: {
  swingId: string;
  initialFavorite: boolean;
  entry: SwingMotionEntry | undefined;
  width: number;
}) {
  const router = useRouter();
  const [favorite, setFavorite] = useState(initialFavorite);
  const [pending, setPending] = useState(false);

  // Re-sync if the underlying row's flag changes (e.g. a focus-driven refresh
  // after the swing was favorited elsewhere). Within a session the list only
  // refreshes on focus, so this never clobbers an in-flight optimistic toggle.
  useEffect(() => {
    setFavorite(initialFavorite);
  }, [initialFavorite]);

  const onToggleFavorite = useCallback(async () => {
    if (pending) return;
    const next = !favorite;
    setFavorite(next); // optimistic
    setPending(true);
    const ok = await toggleSwingFavorite(swingId, next);
    setPending(false);
    if (!ok) {
      setFavorite(!next); // revert — never show a state the DB didn't save
    }
  }, [favorite, pending, swingId]);

  const onPress = useCallback(
    () =>
      router.push({
        pathname: '/analysis/result',
        params: { swingId },
      } as Href),
    [router, swingId],
  );

  // SwingArtCard returns null for sub-6-frame / degenerate swings, so gate on
  // frame count up front rather than relying on its null (which used to collapse
  // the cell and detach the heart).
  const hasArt = !!entry && entry.frames.length >= 6;

  // The cell is a FIXED-SIZE box (width × width + card chrome). Every state —
  // art, loading, no-art — renders inside it, so the footprint never collapses
  // and the absolutely-positioned heart is always anchored to a bounded parent.
  // Art and heart are SIBLINGS (not nested) so a heart tap never navigates.
  return (
    <View style={{ width, height: width + CARD_CHROME }}>
      <TouchableOpacity activeOpacity={0.8} onPress={onPress}>
        {entry && entry.frames.length >= 6 ? (
          <SwingArtCard
            frames={entry.frames}
            phases={entry.phases ?? []}
            width={width}
            showLabel={false}
          />
        ) : (
          // Loading or not enough frames for art — keep the bounded footprint.
          <View style={[styles.cellPlaceholder, { width, height: width }]} />
        )}
      </TouchableOpacity>
      {hasArt && (
        <TouchableOpacity
          style={styles.heartButton}
          onPress={onToggleFavorite}
          disabled={pending}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          activeOpacity={0.7}
        >
          <Ionicons
            name={favorite ? 'heart' : 'heart-outline'}
            size={22}
            color={favorite ? '#FF4D6D' : '#FFFFFF'}
          />
        </TouchableOpacity>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    paddingHorizontal: H_PADDING,
    paddingTop: 80,
  },
  title: {
    color: GOLD,
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 8,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 8,
  },
  filterButton: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  filterButtonActive: {
    backgroundColor: `${GOLD}26`,
    borderColor: GOLD,
  },
  filterText: {
    color: '#999',
    fontSize: 13,
    fontWeight: '600',
  },
  filterTextActive: {
    color: GOLD,
  },
  listContent: {
    paddingTop: 8,
    paddingBottom: 24,
  },
  columnWrapper: {
    gap: GAP,
    marginBottom: GAP,
    alignItems: 'flex-start',
  },
  cellPlaceholder: {
    borderRadius: 16,
    backgroundColor: '#15151A',
    marginTop: 24,
  },
  heartButton: {
    position: 'absolute',
    // +24 clears SwingArtCard's marginTop so the heart sits inside the art box.
    top: 24 + 8,
    right: 8,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
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
});
