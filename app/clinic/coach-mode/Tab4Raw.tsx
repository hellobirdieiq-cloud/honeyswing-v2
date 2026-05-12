import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import {
  clinicSessionActive,
  getCurrentClinicSession,
} from '@/lib/clinic/clinicSessionStore';
import { getSwingsBySession } from '@/lib/clinic/swingRecordStore';
import { getPersonalBand } from '@/lib/clinic/personalBandStore';
import { getCueBlocksBySession } from '@/lib/clinic/cueBlockStore';
import { getQueue } from '@/lib/clinic/kidQueueStore';
import type { ClinicMetricKey } from '@/packages/domain/clinic/enums';
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

// Read-once debug surface. No subscriptions — Tab 4 re-mounts on tab switch (per Step 9 unmount-inactive pattern)
// so each visit reads fresh state. UI is unstyled monospace dump.
export default function Tab4Raw(): React.ReactElement {
  const active = clinicSessionActive();
  const session = getCurrentClinicSession();
  const swings = session ? getSwingsBySession(session.id) : [];
  const lastSwing = swings.length > 0 ? swings[swings.length - 1] : null;
  const cueBlocks = session ? getCueBlocksBySession(session.id) : [];
  const queue = getQueue();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 12, paddingBottom: 80 }}>
      <Text style={styles.rawDebugMono}>━━ SESSION ━━</Text>
      <Text style={styles.rawDebugMono}>clinicSessionActive(): {String(active)}</Text>
      <Text style={styles.rawDebugMono}>
        {session ? JSON.stringify(session, null, 2) : 'getCurrentClinicSession(): null'}
      </Text>

      <View style={{ height: 12 }} />
      <Text style={styles.rawDebugMono}>━━ SWINGS (session) ━━</Text>
      <Text style={styles.rawDebugMono}>count: {swings.length}</Text>
      {lastSwing ? (
        <>
          <Text style={styles.rawDebugMono}>last.id: {lastSwing.id}</Text>
          <Text style={styles.rawDebugMono}>last.recordedAt: {lastSwing.recordedAt}</Text>
          <Text style={styles.rawDebugMono}>last.phaseTags:</Text>
          <Text style={styles.rawDebugMono}>{JSON.stringify(lastSwing.phaseTags, null, 2)}</Text>
          <Text style={styles.rawDebugMono}>last.metrics:</Text>
          {METRIC_KEYS.map((key) => (
            <Text key={key} style={styles.rawDebugMono}>
              {'  '}
              {key}: {String(lastSwing.metrics[key])}
            </Text>
          ))}
          <Text style={styles.rawDebugMono}>last.ballOutcome: {JSON.stringify(lastSwing.ballOutcome)}</Text>
          <Text style={styles.rawDebugMono}>last.effortLevel: {String(lastSwing.effortLevel)}</Text>
        </>
      ) : (
        <Text style={styles.rawDebugMono}>(no swings)</Text>
      )}

      <View style={{ height: 12 }} />
      <Text style={styles.rawDebugMono}>━━ BANDS (active kid + clinic) ━━</Text>
      {session && session.kidId ? (
        METRIC_KEYS.map((key) => {
          const band = getPersonalBand(session.kidId, session.clinicNumber, key);
          if (!band) {
            return (
              <Text key={key} style={styles.rawDebugMono}>
                {key}: null
              </Text>
            );
          }
          return (
            <Text key={key} style={styles.rawDebugMono}>
              {key}: avg={band.average.toFixed(3)} sd={band.standardDeviation.toFixed(3)} n={band.sampleCount}
            </Text>
          );
        })
      ) : (
        <Text style={styles.rawDebugMono}>(no active session)</Text>
      )}

      <View style={{ height: 12 }} />
      <Text style={styles.rawDebugMono}>━━ CUE BLOCKS (session) ━━</Text>
      {cueBlocks.length === 0 ? (
        <Text style={styles.rawDebugMono}>(none)</Text>
      ) : (
        cueBlocks.map((b) => (
          <View key={b.id}>
            <Text style={styles.rawDebugMono}>id: {b.id}</Text>
            <Text style={styles.rawDebugMono}>{`  cueText: "${b.cueText}"`}</Text>
            <Text style={styles.rawDebugMono}>  cueFamily: {b.cueFamily}</Text>
            <Text style={styles.rawDebugMono}>
              {'  '}attention: intent={b.attentionIntent} actual={b.attentionActual}
            </Text>
            <Text style={styles.rawDebugMono}>  postCueSwings: {b.postCueSwingIds.length}</Text>
          </View>
        ))
      )}

      <View style={{ height: 12 }} />
      <Text style={styles.rawDebugMono}>━━ KID QUEUE ━━</Text>
      <Text style={styles.rawDebugMono}>length: {queue.length}</Text>
      {queue.map((k, i) => (
        <Text key={k.id} style={styles.rawDebugMono}>
          [{i}] {k.id}
        </Text>
      ))}
    </ScrollView>
  );
}
