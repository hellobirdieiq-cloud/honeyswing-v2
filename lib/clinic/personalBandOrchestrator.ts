import type { SwingRecord } from '@/packages/domain/clinic/SwingRecord';
import type { ClinicMetricKey } from '@/packages/domain/clinic/enums';
import { getPersonalBand, upsertPersonalBand } from './personalBandStore';
import {
  createPersonalBand,
  appendSample,
} from '@/packages/domain/clinic/personalBandCalculator';

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

// Folds every non-null metric on a finalized clinic swing into that kid's personal bands.
// No-op when the swing isn't tied to a clinic session (no kidId or clinicNumber).
export function updateBandsForSwing(record: SwingRecord): void {
  if (!record.kidId || record.clinicNumber === undefined) return;
  for (const key of METRIC_KEYS) {
    const value = record.metrics[key];
    if (value === null || value === undefined) continue;
    const existing =
      getPersonalBand(record.kidId, record.clinicNumber, key) ??
      createPersonalBand(record.kidId, key);
    const updated = appendSample(existing, value);
    upsertPersonalBand(updated, record.clinicNumber);
  }
}
