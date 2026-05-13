import type { CueBlockRecord } from '@/packages/domain/clinic/CueBlock';
import type { CueEfficacyScore } from '@/packages/domain/clinic/clinicTypes';
import {
  scoreCueBlock,
  CUE_FAMILY_TO_METRIC,
  CLINIC_METRIC_IDEALS,
} from '@/packages/domain/clinic/cueEfficacyScorer';
import { getSwingsByIds } from './swingRecordStore';
import { getPersonalBand } from './personalBandStore';

// EXTERNAL_ASSUMPTION: require 3 band samples before trusting kid-specific average.
const BAND_MIN_SAMPLES_FOR_TARGET = 3;

// Returns null when the cue family is unmappable; otherwise the scorer's output.
export function computeCueEfficacy(
  block: CueBlockRecord,
  baselineSwingIds: string[],
): CueEfficacyScore | null {
  const metric = CUE_FAMILY_TO_METRIC[block.cueFamily];
  if (!metric) return null;

  const baselineSwings = getSwingsByIds(baselineSwingIds);
  const postCueSwings = getSwingsByIds(block.postCueSwingIds);
  const retentionSwings = getSwingsByIds(block.retentionProbeSwingIds);

  const band = getPersonalBand(block.kidId, block.clinicNumber, metric);
  const targetValue =
    band && band.sampleCount >= BAND_MIN_SAMPLES_FOR_TARGET
      ? band.average
      : CLINIC_METRIC_IDEALS[metric];

  return scoreCueBlock(
    block,
    baselineSwings,
    postCueSwings,
    retentionSwings,
    metric,
    targetValue,
  );
}
