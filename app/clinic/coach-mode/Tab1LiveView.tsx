import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  Vibration,
  View,
} from 'react-native';
import { router } from 'expo-router';
import {
  appendBaselineSwing,
  clinicSessionActive,
  getCurrentClinicSession,
  subscribe as subscribeSession,
} from '@/lib/clinic/clinicSessionStore';
import {
  getSwingRecord,
  getSwingsBySession,
  subscribe as subscribeSwings,
  upsertSwingRecord,
} from '@/lib/clinic/swingRecordStore';
import {
  getActiveCueBlock,
  subscribe as subscribeCueBlocks,
} from '@/lib/clinic/cueBlockStore';
import {
  getPersonalBand,
  subscribe as subscribeBands,
} from '@/lib/clinic/personalBandStore';
import {
  enqueueKid,
  getQueue,
  peekNext,
  subscribe as subscribeQueue,
} from '@/lib/clinic/kidQueueStore';
import { getKidProfile, listKidProfiles } from '@/lib/clinic/kidProfileStore';
import {
  fetchMotionFrames,
  type FetchMotionFramesResult,
} from '@/lib/clinic/fetchMotionFrames';
import type { BallContact, ClinicMetricKey } from '@/packages/domain/clinic/enums';
import type { KidProfile } from '@/packages/domain/clinic/KidProfile';
import { GOLD } from '@/lib/colors';
import { styles } from '../clinicStyles';
import LiveViewCard from './LiveViewCard';
import PhaseSignalCard from './PhaseSignalCard';
import CaptureSwingPanel from '../components/CaptureSwingPanel';

const ACTIVE_METRIC: ClinicMetricKey = 'spineAngle';
const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;
const DRAWER_HEIGHT = SCREEN_H * 0.5;
const DRAWER_HANDLE_PEEK = 32;
const DRAWER_CLOSED_OFFSET = DRAWER_HEIGHT - DRAWER_HANDLE_PEEK;

const PHASE_INDICES = [0, 1, 2, 3, 4, 5] as const;
const PHASE_CHIP_LABELS = ['LIVE', 'Start', 'Address', 'Takeaway', 'Top', 'Impact', 'Finish'];
const TOTAL_CARDS = 7;

function tap(): void {
  Vibration.vibrate(10);
}

interface MotionCache {
  swingId: string;
  result: FetchMotionFramesResult | null;
  loading: boolean;
}

export default function Tab1LiveView(): React.ReactElement {
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Auto-route to preflight whenever no active session exists. Guards on clinicSessionActive()
  // so it cannot fire while a session is live.
  useEffect(() => {
    if (!clinicSessionActive()) {
      router.replace({
        pathname: '/clinic/preflight',
        params: { clinicNumber: '1' },
      });
    }
  }, [tick]);

  useEffect(() => {
    refresh();
    const unsub = subscribeSession(refresh);
    return unsub;
  }, [refresh]);

  useEffect(() => {
    refresh();
    const unsub = subscribeSwings(refresh);
    return unsub;
  }, [refresh]);

  useEffect(() => {
    refresh();
    const unsub = subscribeCueBlocks(refresh);
    return unsub;
  }, [refresh]);

  useEffect(() => {
    refresh();
    const unsub = subscribeBands(refresh);
    return unsub;
  }, [refresh]);

  useEffect(() => {
    refresh();
    const unsub = subscribeQueue(refresh);
    return unsub;
  }, [refresh]);

  const session = getCurrentClinicSession();
  const kid = session ? getKidProfile(session.kidId) : null;
  const swings = session ? getSwingsBySession(session.id) : [];
  const lastSwing = swings.length > 0 ? swings[swings.length - 1] : null;
  const value = lastSwing ? lastSwing.metrics[ACTIVE_METRIC] : null;
  const band = session
    ? getPersonalBand(session.kidId, session.clinicNumber, ACTIVE_METRIC)
    : null;
  const cue = session ? getActiveCueBlock(session.id) : null;
  const queue = getQueue();
  const next = peekNext();

  const hasBandData = !!band && band.sampleCount > 0 && band.standardDeviation > 0;
  const delta =
    value !== null && value !== undefined && band ? value - band.average : null;
  const barRatio =
    delta !== null && hasBandData
      ? Math.min(1, Math.abs(delta) / (band as NonNullable<typeof band>).standardDeviation)
      : 0;
  let deltaVariant: 'positive' | 'negative' | 'neutral' = 'neutral';
  if (hasBandData && delta !== null) {
    if (ACTIVE_METRIC === 'spineDrift') {
      deltaVariant = delta < 0 ? 'positive' : 'negative';
    }
  }

  // ── Pager state ──
  const scrollRef = useRef<ScrollView | null>(null);
  const [cardIndex, setCardIndex] = useState(0);
  const [motionCache, setMotionCache] = useState<MotionCache | null>(null);

  // Free-form capture state. CaptureSwingPanel is mounted only when capturePhase === 'capturing'
  // so the camera releases on every transition out of capture — see CaptureSwingPanel.tsx:182-186.
  const [capturePhase, setCapturePhase] = useState<'idle' | 'capturing' | 'done'>('idle');
  const [currentSwingId, setCurrentSwingId] = useState<string | null>(null);
  const [selectedContact, setSelectedContact] = useState<BallContact | null>(null);

  // Clear cache when the underlying swing changes.
  useEffect(() => {
    setMotionCache(null);
  }, [lastSwing?.id]);

  // Lazy-fetch motion frames the first time the user swipes to a signal card.
  useEffect(() => {
    if (cardIndex < 1) return;
    if (!lastSwing?.id) return;
    if (motionCache?.swingId === lastSwing.id) return;

    const mounted = { current: true };
    setMotionCache({ swingId: lastSwing.id, result: null, loading: true });

    fetchMotionFrames(lastSwing.id).then((result) => {
      if (!mounted.current) return;
      setMotionCache({ swingId: lastSwing.id, result, loading: false });
    });

    return () => {
      mounted.current = false;
    };
  }, [cardIndex, lastSwing?.id, motionCache?.swingId]);

  const onMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
      setCardIndex(idx);
    },
    [],
  );

  const scrollToCard = useCallback((idx: number) => {
    scrollRef.current?.scrollTo({ x: idx * SCREEN_W, animated: true });
    setCardIndex(idx);
  }, []);

  // ── NextKid ──
  const [confirmingNext, setConfirmingNext] = useState(false);
  const onNextKidPress = async (): Promise<void> => {
    tap();
    if (!confirmingNext) {
      setConfirmingNext(true);
      return;
    }
    if (!next || !session) {
      setConfirmingNext(false);
      return;
    }
    // endClinicSession moved to preflight submit — prior session stays alive until Dave confirms
    router.push({
      pathname: '/clinic/preflight',
      params: {
        kidId: next.id,
        clinicNumber: String(session.clinicNumber),
        fromQueue: 'true',
      },
    });
    setConfirmingNext(false);
  };

  // ── Free-form capture handlers ──
  // appendBaselineSwing is called AFTER upsertSwingRecord — matches baseline.tsx:105,115 ordering.
  const onLogAndNext = (): void => {
    tap();
    if (currentSwingId) {
      const existing = getSwingRecord(currentSwingId);
      if (existing) {
        upsertSwingRecord({
          ...existing,
          ballOutcome: {
            direction: 'unknown',
            contact: selectedContact ?? 'unknown',
          },
        });
      }
      appendBaselineSwing(currentSwingId);
    }
    setCurrentSwingId(null);
    setSelectedContact(null);
    setCapturePhase('idle');
  };

  const onSkipLog = (): void => {
    tap();
    if (currentSwingId) {
      appendBaselineSwing(currentSwingId);
    }
    setCurrentSwingId(null);
    setSelectedContact(null);
    setCapturePhase('idle');
  };

  // ── Bottom drawer ──
  const translateY = useRef(new Animated.Value(DRAWER_CLOSED_OFFSET)).current;
  const drawerOpenRef = useRef(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const animateDrawer = useCallback(
    (toOpen: boolean) => {
      drawerOpenRef.current = toOpen;
      setDrawerOpen(toOpen);
      Animated.timing(translateY, {
        toValue: toOpen ? 0 : DRAWER_CLOSED_OFFSET,
        duration: 220,
        useNativeDriver: true,
      }).start();
    },
    [translateY],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, gs) => Math.abs(gs.dy) > 6,
        onPanResponderGrant: () => {
          translateY.extractOffset();
        },
        onPanResponderMove: (_e, gs) => {
          const base = (translateY as Animated.Value & { _value?: number })._value ?? 0;
          const nextY = Math.max(
            -DRAWER_CLOSED_OFFSET,
            Math.min(DRAWER_HANDLE_PEEK, base + gs.dy),
          );
          translateY.setValue(nextY);
        },
        onPanResponderRelease: (_e, gs) => {
          translateY.flattenOffset();
          const shouldOpen = drawerOpenRef.current
            ? gs.vy < 0.3 && gs.dy < 80
            : gs.vy < -0.3 || gs.dy < -60;
          animateDrawer(shouldOpen);
        },
      }),
    [animateDrawer, translateY],
  );

  const drawerCandidates = useMemo<KidProfile[]>(() => {
    const all = listKidProfiles();
    const queuedIds = new Set(queue.map((k) => k.id));
    const activeId = session?.kidId;
    return all.filter((k) => k.id !== activeId && !queuedIds.has(k.id));
  }, [queue, session]);

  // ── Derived motion-frame inputs for signal cards ──
  const motionFrames = motionCache?.result?.frames ?? null;
  const motionLoading = motionCache?.loading === true;
  const fallbackHandedness: 'left' | 'right' = kid?.handedness === 'left' ? 'left' : 'right';
  const handedness: 'left' | 'right' = motionCache?.result?.handedness ?? fallbackHandedness;
  const msPerFrame = motionCache?.result?.msPerFrame ?? 8.33;
  const cameraAngle: 'dtl' | 'face_on' = motionCache?.result?.angleBucket ?? 'dtl';
  const phaseTags = lastSwing?.phaseTags ?? [];
  const baselineCount = session?.baselineSwingIds.length ?? 0;

  // Early-return capture overlay. Unmounting Tab1's main tree releases the camera owned by
  // CaptureSwingPanel (see CaptureSwingPanel.tsx:182-186 cleanup).
  if (capturePhase === 'capturing') {
    return (
      <View style={styles.screen}>
        <CaptureSwingPanel
          swingLabel={`SWING ${baselineCount + 1}`}
          immediateStart={true}
          onSwingPersisted={(id) => {
            setCurrentSwingId(id);
            setCapturePhase('done');
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={{ paddingTop: 32, paddingBottom: 8 }}>
        <PhaseChipRow
          labels={PHASE_CHIP_LABELS}
          activeIndex={cardIndex}
          onSelect={(i) => {
            tap();
            scrollToCard(i);
          }}
        />
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onMomentumScrollEnd}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ paddingBottom: SCREEN_H * 0.4 }}
      >
        <LiveViewCard
          kid={kid}
          session={session}
          lastSwing={lastSwing}
          activeMetricKey={ACTIVE_METRIC}
          value={value ?? null}
          band={band}
          hasBandData={hasBandData}
          delta={delta}
          deltaVariant={deltaVariant}
          barRatio={barRatio}
          cue={cue}
        />
        {PHASE_INDICES.map((p) => (
          <PhaseSignalCard
            key={p}
            frames={motionFrames}
            phaseIndex={p}
            phaseTags={phaseTags}
            handedness={handedness}
            msPerFrame={msPerFrame}
            cameraAngle={cameraAngle}
            loading={motionLoading}
          />
        ))}
      </ScrollView>

      <PageDots count={TOTAL_CARDS} activeIndex={cardIndex} />

      {capturePhase === 'idle' ? (
        <View
          style={{
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: SCREEN_H * 0.18,
            flexDirection: 'row',
            gap: 12,
          }}
        >
          <Pressable
            style={[styles.primaryButton, { flex: 1 }]}
            onPress={() => {
              tap();
              setCapturePhase('capturing');
            }}
            accessibilityRole="button"
          >
            <Text style={styles.primaryButtonText}>RECORD</Text>
          </Pressable>
          <Pressable
            style={[
              styles.primaryButton,
              { flex: 1 },
              baselineCount < 3 ? { opacity: 0.4 } : null,
            ]}
            disabled={baselineCount < 3}
            onPress={() => {
              tap();
              router.push('/clinic/cue-block');
            }}
            accessibilityRole="button"
          >
            <Text style={styles.primaryButtonText}>START CUE BLOCK</Text>
          </Pressable>
        </View>
      ) : null}

      {capturePhase === 'done' ? (
        <View
          style={{
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: SCREEN_H * 0.18,
            backgroundColor: '#1A1A1C',
            borderRadius: 12,
            padding: 12,
            gap: 10,
          }}
        >
          <Text
            style={{
              color: 'rgba(255,255,255,0.7)',
              fontSize: 11,
              fontWeight: '700',
              letterSpacing: 0.5,
            }}
          >
            BALL CONTACT
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {(['solid', 'thin', 'fat', 'sky', 'shank', 'whiff'] as const).map((c) => {
              const active = selectedContact === c;
              return (
                <Pressable
                  key={c}
                  onPress={() => setSelectedContact(c)}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 8,
                    backgroundColor: active ? GOLD : '#000',
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.15)',
                  }}
                >
                  <Text
                    style={{
                      color: active ? '#000' : '#FFF',
                      fontSize: 12,
                      fontWeight: '700',
                      textTransform: 'uppercase',
                    }}
                  >
                    {c}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable
              style={[styles.secondaryButton, { flex: 1 }]}
              onPress={onSkipLog}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryButtonText}>SKIP</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryButton, { flex: 1 }]}
              onPress={onLogAndNext}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>LOG + NEXT</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: SCREEN_H * 0.08,
          paddingHorizontal: 16,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
            {queue.length === 0 ? (
              <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, paddingVertical: 10 }}>
                queue empty
              </Text>
            ) : (
              queue.map((k, i) => (
                <View
                  key={k.id}
                  style={{
                    backgroundColor: '#1A1A1C',
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 8,
                    marginRight: 8,
                  }}
                >
                  <Text style={{ color: '#FFFFFF', fontSize: 12 }}>
                    {i + 1}. {k.name ?? k.id}
                  </Text>
                </View>
              ))
            )}
          </ScrollView>
          {next ? (
            <Pressable
              onPress={onNextKidPress}
              style={[styles.nextKidCta, { marginLeft: 8 }]}
              accessibilityRole="button"
            >
              <Text style={styles.primaryButtonText}>
                {confirmingNext ? 'CONFIRM →' : 'NEXT KID'}
              </Text>
            </Pressable>
          ) : null}
          {confirmingNext ? (
            <Pressable
              onPress={() => {
                tap();
                setConfirmingNext(false);
              }}
              style={{
                marginLeft: 8,
                paddingHorizontal: 14,
                paddingVertical: 14,
                borderRadius: 12,
                backgroundColor: '#1A1A1C',
              }}
            >
              <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '600' }}>CANCEL</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <Animated.View
        style={[
          styles.nextKidDrawer,
          {
            height: DRAWER_HEIGHT,
            transform: [{ translateY }],
          },
        ]}
      >
        <View {...panResponder.panHandlers}>
          <View style={styles.drawerHandle} />
          <Pressable
            onPress={() => {
              tap();
              animateDrawer(!drawerOpenRef.current);
            }}
            style={{ paddingVertical: 4 }}
          >
            <Text
              style={{
                color: 'rgba(255,255,255,0.7)',
                fontSize: 12,
                textAlign: 'center',
                letterSpacing: 1,
              }}
            >
              {drawerOpen ? 'SWIPE DOWN TO CLOSE' : 'SWIPE UP TO ADD KIDS'}
            </Text>
          </Pressable>
        </View>
        <ScrollView style={{ marginTop: 8 }} contentContainerStyle={{ paddingBottom: 32 }}>
          {drawerCandidates.length === 0 ? (
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, paddingVertical: 12 }}>
              No more kids available.
            </Text>
          ) : (
            drawerCandidates.map((profile) => (
              <Pressable
                key={profile.id}
                onPress={() => {
                  tap();
                  enqueueKid(profile);
                }}
                style={{
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: 'rgba(255,255,255,0.08)',
                }}
              >
                <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '600' }}>
                  {profile.name ?? profile.id}
                </Text>
                <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 }}>
                  {profile.ageTier} · {profile.handedness}-handed
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

interface PhaseChipRowProps {
  labels: string[];
  activeIndex: number;
  onSelect: (i: number) => void;
}

function PhaseChipRow({ labels, activeIndex, onSelect }: PhaseChipRowProps): React.ReactElement {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
    >
      {labels.map((label, i) => {
        const active = i === activeIndex;
        return (
          <Pressable
            key={label}
            onPress={() => onSelect(i)}
            style={{
              backgroundColor: active ? GOLD : '#1A1A1C',
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 8,
            }}
          >
            <Text
              style={{
                color: active ? '#000000' : '#FFFFFF',
                fontSize: 12,
                fontWeight: '700',
                letterSpacing: 0.5,
              }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function PageDots({
  count,
  activeIndex,
}: {
  count: number;
  activeIndex: number;
}): React.ReactElement {
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 6,
        marginTop: 4,
      }}
    >
      {Array.from({ length: count }).map((_, i) => {
        const active = i === activeIndex;
        return (
          <View
            key={i}
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: active ? GOLD : 'rgba(255,255,255,0.3)',
            }}
          />
        );
      })}
    </View>
  );
}
