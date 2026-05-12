import type { PersonalBand } from './PersonalBand';
import type { SwingRecord } from './SwingRecord';
import type { CueBlockRecord } from './CueBlock';
import type { PhysicalScreenResult } from './KidProfile';
import type { ClinicMetricKey } from './enums';

export type PhysicalLimitFlag =
  | 'within-band'
  | 'plateau-not-yet-cued'
  | 'plateau-despite-cues'
  | 'physical-limit-suspected';

export interface PhysicalLimitEvaluation {
  kidId: string;
  metric: ClinicMetricKey;
  flag: PhysicalLimitFlag;
  reason: string;
  evaluatedAt: number;
}

// Flags when a metric plateaus despite repeated cue intervention AND a related physical screen test failed.
export function evaluatePhysicalLimit(
  band: PersonalBand,
  recentSwings: SwingRecord[],
  cueHistory: CueBlockRecord[],
  physicalScreens: PhysicalScreenResult[],
): PhysicalLimitEvaluation {
  // stub: returns 'within-band' when SD is shrinking; 'physical-limit-suspected' when plateau + matching screen failure.
  throw new Error('Not implemented');
}
