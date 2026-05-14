import React from 'react';
import { Dimensions, Text, View } from 'react-native';
import type { ClinicSession } from '@/lib/clinic/clinicSessionStore';
import type { CueBlockRecord } from '@/packages/domain/clinic/CueBlock';
import type { KidProfile } from '@/packages/domain/clinic/KidProfile';
import type { SwingRecord } from '@/packages/domain/clinic/SwingRecord';
import type { SpineAngleSummary } from '@/packages/domain/clinic/spineAngleSummary';
import { GOLD } from '@/lib/colors';
import { styles } from '../clinicStyles';

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;

interface SpineAngleCardProps {
  kid: KidProfile | null;
  session: ClinicSession | null;
  lastSwing: SwingRecord | null;
  summary: SpineAngleSummary;
  cue: CueBlockRecord | null;
}

function fmtAngle(v: number | null): string {
  return v !== null ? `${Math.round(v)}°` : '—';
}

function fmtDelta(v: number | null): string | null {
  if (v === null) return null;
  const rounded = Math.round(v);
  const sign = rounded >= 0 ? '+' : '';
  return `Δ ${sign}${rounded}°`;
}

export default function SpineAngleCard(props: SpineAngleCardProps): React.ReactElement {
  const { kid, session, lastSwing, summary, cue } = props;

  return (
    <View style={{ width: SCREEN_W }}>
      <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
        <Text style={{ color: '#FFFFFF', fontSize: 32, fontWeight: '800' }} numberOfLines={1}>
          {kid ? kid.name : '—'}
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
          {fmtAngle(summary.range)}
        </Text>
        <Text
          style={{
            color: 'rgba(255,255,255,0.7)',
            fontSize: 13,
            marginTop: 8,
            letterSpacing: 1,
          }}
        >
          SPINE ANGLE RANGE
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginTop: 6 }}>
          {summary.min !== null && summary.max !== null
            ? `${Math.round(summary.min)}° → ${Math.round(summary.max)}°`
            : '—'}
        </Text>
      </View>

      <View style={{ paddingHorizontal: 20 }}>
        <PhaseRow label="ADDRESS" value={summary.address} delta={null} />
        <PhaseRow
          label="TOP"
          value={summary.top}
          delta={fmtDelta(summary.deltaTopFromAddress)}
        />
        <PhaseRow
          label="IMPACT"
          value={summary.impact}
          delta={fmtDelta(summary.deltaImpactFromAddress)}
        />
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

interface PhaseRowProps {
  label: string;
  value: number | null;
  delta: string | null;
}

function PhaseRow({ label, value, delta }: PhaseRowProps): React.ReactElement {
  return (
    <View style={styles.metricRow}>
      <Text
        style={{
          color: 'rgba(255,255,255,0.7)',
          fontSize: 13,
          fontWeight: '600',
          letterSpacing: 0.5,
        }}
      >
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text
          style={{
            color: '#FFFFFF',
            fontSize: 18,
            fontWeight: '700',
            fontVariant: ['tabular-nums'],
          }}
        >
          {value !== null ? `${Math.round(value)}°` : '—'}
        </Text>
        {delta !== null ? (
          <Text
            style={{
              color: 'rgba(255,255,255,0.6)',
              fontSize: 13,
              fontVariant: ['tabular-nums'],
            }}
          >
            {delta}
          </Text>
        ) : null}
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
