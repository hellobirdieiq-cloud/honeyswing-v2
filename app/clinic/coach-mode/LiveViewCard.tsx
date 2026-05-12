import React from 'react';
import { Dimensions, Text, View } from 'react-native';
import type { ClinicSession } from '@/lib/clinic/clinicSessionStore';
import type { CueBlockRecord } from '@/packages/domain/clinic/CueBlock';
import type { ClinicMetricKey } from '@/packages/domain/clinic/enums';
import type { KidProfile } from '@/packages/domain/clinic/KidProfile';
import type { PersonalBand } from '@/packages/domain/clinic/PersonalBand';
import type { SwingRecord } from '@/packages/domain/clinic/SwingRecord';
import { GOLD } from '@/lib/colors';
import { styles } from '../clinicStyles';

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;

interface LiveViewCardProps {
  kid: KidProfile | null;
  session: ClinicSession | null;
  lastSwing: SwingRecord | null;
  activeMetricKey: ClinicMetricKey;
  value: number | null;
  band: PersonalBand | null;
  hasBandData: boolean;
  delta: number | null;
  deltaVariant: 'positive' | 'negative' | 'neutral';
  barRatio: number;
  cue: CueBlockRecord | null;
}

export default function LiveViewCard(props: LiveViewCardProps): React.ReactElement {
  const {
    kid,
    session,
    lastSwing,
    activeMetricKey,
    value,
    band,
    hasBandData,
    delta,
    deltaVariant,
    barRatio,
    cue,
  } = props;

  return (
    <View style={{ width: SCREEN_W }}>
      <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
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
        <Text
          style={{
            color: 'rgba(255,255,255,0.7)',
            fontSize: 13,
            marginTop: 8,
            letterSpacing: 1,
          }}
        >
          {activeMetricKey.toUpperCase()}
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
            {hasBandData && delta !== null && band
              ? `Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} vs band avg ${band.average.toFixed(2)} (n=${band.sampleCount})`
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

      <View
        style={{
          paddingHorizontal: 20,
          marginTop: 16,
          alignItems: 'flex-end',
        }}
      >
        <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>PHASES →</Text>
      </View>
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
