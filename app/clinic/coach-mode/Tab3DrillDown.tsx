import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Dimensions, Pressable, ScrollView, Text, Vibration, View } from 'react-native';
import {
  getCurrentClinicSession,
  subscribe as subscribeSession,
} from '@/lib/clinic/clinicSessionStore';
import {
  getSwingsBySession,
  subscribe as subscribeSwings,
} from '@/lib/clinic/swingRecordStore';
import {
  getCueBlocksBySession,
  subscribe as subscribeCueBlocks,
} from '@/lib/clinic/cueBlockStore';
import {
  getPersonalBand,
  subscribe as subscribeBands,
} from '@/lib/clinic/personalBandStore';
import type { ClinicMetricKey, PhaseTag } from '@/packages/domain/clinic/enums';
import { GOLD } from '@/lib/colors';
import { styles } from '../clinicStyles';

const METRIC_KEYS: ClinicMetricKey[] = [
  'spineAngle',
  'spineDrift',
  'tempoRatio',
  'hipSpreadDelta',
  'leftElbowAngle',
  'rightElbowAngle',
  'leftKneeAngle',
  'rightKneeAngle',
  'shoulderTilt',
];

const SCREEN_H = Dimensions.get('window').height;

const VISIBLE_PHASES: readonly PhaseTag[] = ['takeaway', 'top', 'downswing', 'impact'];

function tap(): void {
  Vibration.vibrate(10);
}

export default function Tab3DrillDown(): React.ReactElement {
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

  const session = getCurrentClinicSession();
  const swings = useMemo(
    () =>
      session
        ? getSwingsBySession(session.id).slice().sort((a, b) => a.recordedAt - b.recordedAt)
        : [],
    [session],
  );
  const cueBlocks = useMemo(
    () =>
      session
        ? getCueBlocksBySession(session.id).slice().sort((a, b) => a.recordedAt - b.recordedAt)
        : [],
    [session],
  );

  const [selectedSwingId, setSelectedSwingId] = useState<string | null>(null);
  const selectedSwing = useMemo(() => {
    if (!swings.length) return null;
    if (selectedSwingId) {
      const found = swings.find((s) => s.id === selectedSwingId);
      if (found) return found;
    }
    return swings[swings.length - 1];
  }, [swings, selectedSwingId]);

  const [selectedPhaseIndex, setSelectedPhaseIndex] = useState<number | null>(null);
  // Reset phase selection when the swing changes.
  useEffect(() => {
    setSelectedPhaseIndex(null);
  }, [selectedSwing?.id]);

  const visiblePhases = useMemo(
    () =>
      selectedSwing
        ? selectedSwing.phaseTags.filter((p) => VISIBLE_PHASES.includes(p.phase))
        : [],
    [selectedSwing],
  );
  const totalFrames = visiblePhases.reduce(
    (acc, p) => acc + Math.max(0, p.endFrameIndex - p.startFrameIndex),
    0,
  );
  const selectedPhase =
    selectedPhaseIndex !== null ? (visiblePhases[selectedPhaseIndex] ?? null) : null;
  const selectedPhaseFrames = selectedPhase
    ? Math.max(0, selectedPhase.endFrameIndex - selectedPhase.startFrameIndex)
    : 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingTop: 24, paddingBottom: 120 }}>
      {/* ── Swing selector ── */}
      <Text style={styles.header}>SWING</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16 }}>
        {swings.length === 0 ? (
          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, padding: 12 }}>
            No swings in this session.
          </Text>
        ) : (
          swings.map((s, i) => {
            const isSelected = selectedSwing?.id === s.id;
            return (
              <Pressable
                key={s.id}
                onPress={() => {
                  tap();
                  setSelectedSwingId(s.id);
                }}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderRadius: 10,
                  marginRight: 8,
                  backgroundColor: isSelected ? GOLD : '#1A1A1C',
                }}
              >
                <Text
                  style={{
                    color: isSelected ? '#000' : '#FFFFFF',
                    fontSize: 13,
                    fontWeight: '700',
                  }}
                >
                  #{i + 1}
                </Text>
              </Pressable>
            );
          })
        )}
      </ScrollView>

      {/* ── Phase visualization ── */}
      <Text style={[styles.header, { marginTop: 24 }]}>PHASES</Text>
      {selectedSwing && visiblePhases.length > 0 && totalFrames > 0 ? (
        <>
          <View
            style={{
              flexDirection: 'row',
              marginHorizontal: 16,
              height: 56,
              borderRadius: 8,
              overflow: 'hidden',
              backgroundColor: '#1A1A1C',
            }}
          >
            {visiblePhases.map((p, i) => {
              const span = Math.max(0, p.endFrameIndex - p.startFrameIndex);
              const ratio = totalFrames > 0 ? span / totalFrames : 0;
              const isSelected = selectedPhaseIndex === i;
              return (
                <Pressable
                  key={`${p.phase}-${p.startFrameIndex}-${i}`}
                  onPress={() => {
                    tap();
                    setSelectedPhaseIndex(isSelected ? null : i);
                  }}
                  style={{
                    flexGrow: ratio,
                    flexBasis: 0,
                    backgroundColor: isSelected ? GOLD : '#252528',
                    borderRightWidth: 1,
                    borderRightColor: '#000',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={{
                      color: isSelected ? '#000' : '#FFFFFF',
                      fontSize: 10,
                      fontWeight: '700',
                      letterSpacing: 0.5,
                      paddingHorizontal: 2,
                    }}
                  >
                    {p.phase}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {selectedPhase ? (
            <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 8, paddingHorizontal: 16 }}>
              {selectedPhase.phase}: {selectedPhaseFrames} frames (
              {((selectedPhaseFrames / totalFrames) * 100).toFixed(1)}%)
            </Text>
          ) : (
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 8, paddingHorizontal: 16 }}>
              Tap a segment to inspect.
            </Text>
          )}
        </>
      ) : (
        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, paddingHorizontal: 16 }}>
          No phase data for selected swing.
        </Text>
      )}

      {/* ── Metric breakdown ── */}
      <Text style={[styles.header, { marginTop: 24 }]}>METRICS</Text>
      <View style={{ paddingHorizontal: 16 }}>
        {METRIC_KEYS.map((key) => {
          const v = selectedSwing ? selectedSwing.metrics[key] : null;
          const band = session ? getPersonalBand(session.kidId, session.clinicNumber, key) : null;
          const avg = band ? band.average : null;
          const delta = v !== null && v !== undefined && avg !== null ? v - avg : null;
          return (
            <View key={key} style={styles.metricRow}>
              <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '600', flex: 1.4 }}>
                {key}
              </Text>
              <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13, flex: 1, textAlign: 'right' }}>
                {v !== null && v !== undefined ? v.toFixed(2) : '—'}
              </Text>
              <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, flex: 1, textAlign: 'right' }}>
                {avg !== null ? `avg ${avg.toFixed(2)}` : 'avg —'}
              </Text>
              <Text
                style={{
                  color: delta === null ? 'rgba(255,255,255,0.4)' : delta >= 0 ? '#3DDC84' : '#FF4D4F',
                  fontSize: 12,
                  flex: 1,
                  textAlign: 'right',
                  fontWeight: '700',
                }}
              >
                {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`}
              </Text>
            </View>
          );
        })}
      </View>

      {/* ── Cue history ── */}
      <Text style={[styles.header, { marginTop: 24 }]}>CUES</Text>
      {cueBlocks.length === 0 ? (
        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, paddingHorizontal: 16 }}>
          No cue blocks in this session.
        </Text>
      ) : (
        cueBlocks.map((b) => (
          <View key={b.id} style={[styles.cueRow, { marginHorizontal: 16 }]}>
            <Text style={{ color: GOLD, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 }}>
              {b.cueFamily.toUpperCase()}
            </Text>
            <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600', marginTop: 4 }}>
              {b.cueText || '(no cue text yet)'}
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 4 }}>
              attention: intent={b.attentionIntent} · actual={b.attentionActual} · {b.postCueSwingIds.length} swing
              {b.postCueSwingIds.length === 1 ? '' : 's'}
            </Text>
          </View>
        ))
      )}

      {/* ── Kid band summary ── */}
      <Text style={[styles.header, { marginTop: 24 }]}>BANDS</Text>
      <View style={{ paddingHorizontal: 16 }}>
        {METRIC_KEYS.map((key) => {
          const band = session ? getPersonalBand(session.kidId, session.clinicNumber, key) : null;
          return (
            <View key={key} style={styles.metricRow}>
              <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '600', flex: 1.4 }}>
                {key}
              </Text>
              <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13, flex: 2, textAlign: 'right' }}>
                {band
                  ? `${band.average.toFixed(2)} ± ${band.standardDeviation.toFixed(2)} (n=${band.sampleCount})`
                  : '—'}
              </Text>
            </View>
          );
        })}
      </View>

      {/* footer spacer for tab bar */}
      <View style={{ height: SCREEN_H * 0.12 }} />
    </ScrollView>
  );
}
