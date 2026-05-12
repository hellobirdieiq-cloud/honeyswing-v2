import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import {
  clinicSessionActive,
  getCurrentClinicSession,
} from '@/lib/clinic/clinicSessionStore';
import { getSwingsBySession, upsertSwingRecord } from '@/lib/clinic/swingRecordStore';
import { getPersonalBand } from '@/lib/clinic/personalBandStore';
import { getCueBlocksBySession } from '@/lib/clinic/cueBlockStore';
import { getQueue } from '@/lib/clinic/kidQueueStore';
import {
  seedMotionFrames,
  type FetchMotionFramesResult,
  type MotionFrame,
} from '@/lib/clinic/fetchMotionFrames';
import type { ClinicMetricKey } from '@/packages/domain/clinic/enums';
import type { SwingRecord } from '@/packages/domain/clinic/SwingRecord';
import { styles } from '../clinicStyles';

const DEV_SEED_SWING_ID = 'dev-seed-swing-0001';

function buildSeedFrames(): MotionFrame[] {
  return Array.from({ length: 30 }, (_, i) => {
    const wristArc = 0.6 - 0.3 * Math.sin((i / 29) * Math.PI);
    return {
      timestampMs: i * 33.33,
      joints: {
        leftHip:       { x: 0.45, y: 0.55, z: 0 },
        rightHip:      { x: 0.55, y: 0.55, z: 0 },
        leftShoulder:  { x: 0.40, y: 0.30, z: 0 },
        rightShoulder: { x: 0.60, y: 0.30, z: 0 },
        leftElbow:     { x: 0.42, y: 0.45, z: 0 },
        rightElbow:    { x: 0.58, y: 0.45, z: 0 },
        leftWrist:     { x: 0.48, y: wristArc, z: 0 },
        rightWrist:    { x: 0.52, y: wristArc, z: 0 },
        leftKnee:      { x: 0.46, y: 0.75, z: 0 },
        rightKnee:     { x: 0.54, y: 0.75, z: 0 },
        leftAnkle:     { x: 0.46, y: 0.92, z: 0 },
        rightAnkle:    { x: 0.54, y: 0.92, z: 0 },
      },
    };
  });
}

function buildSeedResult(): FetchMotionFramesResult {
  return {
    frames: buildSeedFrames(),
    handedness: 'right',
    msPerFrame: 33.33,
    angleBucket: 'dtl',
  };
}

function buildSeedSwing(sessionId: string, kidId: string, clinicNumber: number): SwingRecord {
  return {
    id: DEV_SEED_SWING_ID,
    kidId,
    sessionId,
    clinicNumber,
    recordedAt: Date.now(),
    metrics: {
      spineAngle: 35,
      spineDrift: 2,
      tempoRatio: 3,
      hipSpreadDelta: 0.05,
      leftElbowAngle: 160,
      rightElbowAngle: 155,
      leftKneeAngle: 165,
      rightKneeAngle: 168,
      shoulderTilt: 20,
    },
    phaseTags: [
      { phase: 'address',   startFrameIndex: 0,  endFrameIndex: 3  },
      { phase: 'takeaway',  startFrameIndex: 4,  endFrameIndex: 9  },
      { phase: 'top',       startFrameIndex: 10, endFrameIndex: 13 },
      { phase: 'downswing', startFrameIndex: 14, endFrameIndex: 19 },
      { phase: 'impact',    startFrameIndex: 20, endFrameIndex: 22 },
      { phase: 'finish',    startFrameIndex: 23, endFrameIndex: 29 },
    ],
  };
}

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

      {__DEV__ && (
        <>
          <View style={{ height: 12 }} />
          <Text style={styles.rawDebugMono}>━━ DEV SEED ━━</Text>
          <Pressable
            onPress={() => {
              const s = getCurrentClinicSession();
              if (!s) {
                console.warn('Dev seed: no active session');
                return;
              }
              seedMotionFrames(DEV_SEED_SWING_ID, buildSeedResult());
              upsertSwingRecord(buildSeedSwing(s.id, s.kidId, s.clinicNumber));
            }}
            style={{
              marginTop: 8,
              padding: 12,
              backgroundColor: '#3A3A3C',
              borderRadius: 8,
              alignSelf: 'flex-start',
            }}
            accessibilityRole="button"
          >
            <Text style={{ color: '#FFFFFF', fontWeight: '700' }}>Seed Signal Cards</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}
