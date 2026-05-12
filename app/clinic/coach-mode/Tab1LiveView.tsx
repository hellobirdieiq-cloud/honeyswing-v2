import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  Vibration,
  View,
} from 'react-native';
import {
  endClinicSession,
  getCurrentClinicSession,
  startClinicSession,
  subscribe as subscribeSession,
} from '@/lib/clinic/clinicSessionStore';
import {
  getSwingsBySession,
  subscribe as subscribeSwings,
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
  dequeueNext,
  enqueueKid,
  getQueue,
  peekNext,
  subscribe as subscribeQueue,
} from '@/lib/clinic/kidQueueStore';
import { getKidProfile, listKidProfiles } from '@/lib/clinic/kidProfileStore';
import type { ClinicMetricKey } from '@/packages/domain/clinic/enums';
import type { KidProfile } from '@/packages/domain/clinic/KidProfile';
import { GOLD } from '@/lib/colors';
import { styles } from '../clinicStyles';

const ACTIVE_METRIC: ClinicMetricKey = 'spineAngle';
const SCREEN_H = Dimensions.get('window').height;
const DRAWER_HEIGHT = SCREEN_H * 0.5;
const DRAWER_HANDLE_PEEK = 32;
const DRAWER_CLOSED_OFFSET = DRAWER_HEIGHT - DRAWER_HANDLE_PEEK;

function tap(): void {
  Vibration.vibrate(10);
}

export default function Tab1LiveView(): React.ReactElement {
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

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
  const delta = value !== null && value !== undefined && band ? value - band.average : null;
  const barRatio =
    delta !== null && hasBandData
      ? Math.min(1, Math.abs(delta) / (band as NonNullable<typeof band>).standardDeviation)
      : 0;
  // For spineDrift, smaller is better → negative delta is improving.
  // Other metrics have no monotonic improving direction defined here; bar stays neutral past 1 SD.
  let deltaVariant: 'positive' | 'negative' | 'neutral' = 'neutral';
  if (hasBandData && delta !== null) {
    if (ACTIVE_METRIC === 'spineDrift') {
      deltaVariant = delta < 0 ? 'positive' : 'negative';
    }
  }

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
    const clinicNumber = session.clinicNumber;
    endClinicSession();
    try {
      await startClinicSession(next.id, clinicNumber);
      dequeueNext();
    } catch {
      // startClinicSession refuses without auth; queue stays intact, session is left ended.
    }
    setConfirmingNext(false);
  };

  // ── Bottom drawer ──
  // drawerOpenRef drives PanResponder logic (closure reads). drawerOpen drives the visible label
  // (refs don't trigger re-renders, state does — both must be kept in sync inside animateDrawer).
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

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ paddingTop: 32, paddingBottom: SCREEN_H * 0.4 }}>
        <View style={{ paddingHorizontal: 20 }}>
          <Text style={{ color: '#FFFFFF', fontSize: 32, fontWeight: '800' }} numberOfLines={1}>
            {kid ? kid.id : '—'}
          </Text>
          {session ? (
            <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 4 }}>
              CLINIC {session.clinicNumber}
            </Text>
          ) : (
            <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 4 }}>
              NO ACTIVE SESSION
            </Text>
          )}
        </View>

        <View style={[styles.metricBlock, { height: SCREEN_H * 0.42 }]}>
          <Text style={styles.metricValueLarge} numberOfLines={1}>
            {value !== null && value !== undefined ? value.toFixed(1) : '—'}
          </Text>
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 8, letterSpacing: 1 }}>
            {ACTIVE_METRIC.toUpperCase()}
          </Text>
          <View style={{ width: '70%', marginTop: 18 }}>
            <View
              style={[
                styles.deltaBar,
                deltaVariant === 'positive' && styles.deltaBarPositive,
                deltaVariant === 'negative' && styles.deltaBarNegative,
                deltaVariant === 'neutral' && styles.deltaBarNeutral,
                { width: `${Math.round(barRatio * 100)}%` },
              ]}
            />
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 4 }}>
              {hasBandData && delta !== null
                ? `Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} vs band avg ${band!.average.toFixed(2)} (n=${band!.sampleCount})`
                : 'No band data yet'}
            </Text>
          </View>
        </View>

        {cue && cue.cueText.length > 0 ? (
          <View style={[styles.cueRow, { marginHorizontal: 20 }]}>
            <Text style={{ color: GOLD, fontSize: 11, letterSpacing: 0.5, fontWeight: '700' }}>
              ACTIVE CUE
            </Text>
            <Text style={{ color: '#FFFFFF', fontSize: 18, fontWeight: '600', marginTop: 4 }}>
              {cue.cueText}
            </Text>
            {cue.attentionActual ? (
              <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 4 }}>
                attention: {cue.attentionActual}
              </Text>
            ) : null}
          </View>
        ) : null}

        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            paddingHorizontal: 20,
            marginTop: 12,
            gap: 8,
          }}
        >
          {lastSwing?.ballOutcome ? (
            <>
              <Chip label={lastSwing.ballOutcome.direction} />
              <Chip label={lastSwing.ballOutcome.contact} />
            </>
          ) : null}
          {lastSwing?.effortLevel ? <Chip label={`effort: ${lastSwing.effortLevel}`} /> : null}
        </View>
      </ScrollView>

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
                    {i + 1}. {k.id}
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
                  {profile.id}
                </Text>
                <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 }}>
                  age {profile.ageYears} · {profile.handedness}-handed
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function Chip({ label }: { label: string }): React.ReactElement {
  return (
    <View
      style={{
        backgroundColor: '#1A1A1C',
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
      }}
    >
      <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}
