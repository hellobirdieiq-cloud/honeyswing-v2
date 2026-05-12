import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import {
  getCurrentClinicSession,
  subscribe as subscribeSession,
} from '@/lib/clinic/clinicSessionStore';
import {
  getSwingsBySession,
  subscribe as subscribeSwings,
} from '@/lib/clinic/swingRecordStore';
import {
  getPersonalBand,
  subscribe as subscribeBands,
} from '@/lib/clinic/personalBandStore';
import { getKidProfile } from '@/lib/clinic/kidProfileStore';
import { isWithinBand } from '@/packages/domain/clinic/personalBandCalculator';
import type { ClinicMetricKey } from '@/packages/domain/clinic/enums';
import type { PersonalBand } from '@/packages/domain/clinic/PersonalBand';
import { styles } from '../clinicStyles';

const ACTIVE_METRIC: ClinicMetricKey = 'spineAngle';

const COLOR_GREEN = '#3DDC84';
const COLOR_YELLOW = '#FFD23F';
const COLOR_RED = '#FF4D4F';
const COLOR_GRAY = '#777777';

function deltaWord(
  band: PersonalBand | null,
  value: number,
  metric: ClinicMetricKey,
): string {
  if (!band || band.sampleCount === 0) return 'Same';
  const delta = value - band.average;
  if (Math.abs(delta) < band.standardDeviation) return 'Same';
  // spineDrift: smaller is better. Outside-1SD on the negative side is "Better".
  if (metric === 'spineDrift') return delta < 0 ? 'Better' : 'Try Again';
  // For every other metric, no monotonic "improving" direction is defined,
  // so being outside 1 SD is treated as "Try Again".
  return 'Try Again';
}

function valueColor(band: PersonalBand | null, value: number): string {
  if (!band || band.sampleCount === 0) return COLOR_GRAY;
  if (isWithinBand(band, value, 1)) return COLOR_GREEN;
  if (isWithinBand(band, value, 2)) return COLOR_YELLOW;
  return COLOR_RED;
}

// Kid-facing one-metric view. Shown to the kid between swings.
// One giant value, one word. No scores. Color encodes "where you are vs your norm".
export default function Tab2KidView(): React.ReactElement {
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
    const unsub = subscribeBands(refresh);
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

  const color = value !== null && value !== undefined ? valueColor(band, value) : COLOR_GRAY;
  const word =
    value !== null && value !== undefined ? deltaWord(band, value, ACTIVE_METRIC) : '—';
  const display = value !== null && value !== undefined ? value.toFixed(1) : '—';

  return (
    <View style={[styles.screen, { paddingTop: 64, paddingBottom: 96 }]}>
      <Text
        style={{
          color: '#FFFFFF',
          fontSize: 28,
          fontWeight: '700',
          textAlign: 'center',
          paddingHorizontal: 16,
        }}
        numberOfLines={1}
      >
        {kid ? kid.id : '—'}
      </Text>

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={[styles.metricValueKid, { color }]} numberOfLines={1}>
          {display}
        </Text>
        <Text
          style={{
            color,
            fontSize: 36,
            fontWeight: '800',
            marginTop: 12,
            letterSpacing: 1,
          }}
        >
          {word}
        </Text>
      </View>
    </View>
  );
}
