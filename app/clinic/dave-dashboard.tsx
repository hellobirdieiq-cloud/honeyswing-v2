import React from 'react';
import { View, ScrollView } from 'react-native';
import type { PersonalBand } from '@/packages/domain/clinic/PersonalBand';
import type { CueEfficacyScore } from '@/packages/domain/clinic/cueEfficacyScorer';
import type { PhysicalLimitEvaluation } from '@/packages/domain/clinic/physicalLimitFlagEvaluator';
import { listKidProfiles } from '@/lib/clinic/kidProfileStore';
import { getBandsByKid } from '@/lib/clinic/personalBandStore';
import { getCueBlocksByKid } from '@/lib/clinic/cueBlockStore';
import { getSwingsByKid } from '@/lib/clinic/swingRecordStore';
import { styles } from './clinicStyles';

type DashboardTab = 'metric-history' | 'cue-efficacy' | 'physical-flags';

// Dave dashboard — top-level screen with kid picker + tabs for metric history, cue efficacy, and physical flags.
export default function DaveDashboardScreen(): React.ReactElement {
  // stub: holds selected kidId + active tab; renders <KidPicker/> + tab-specific panel.
  return null as unknown as React.ReactElement;
}

// Renders the kid selector at the top of the dashboard.
function KidPicker(props: {
  selectedKidId: string | null;
  onSelect: (kidId: string) => void;
}): React.ReactElement {
  // stub
  return null as unknown as React.ReactElement;
}

// Renders the per-metric history view (bands over session timeline).
function MetricHistoryPanel(props: {
  kidId: string;
  bands: PersonalBand[];
}): React.ReactElement {
  // stub: one row per metric, each showing average + SD trajectory across sessions.
  return null as unknown as React.ReactElement;
}

// Renders the cue efficacy table (one row per cue block: cue text, accommodation, retention).
function CueEfficacyPanel(props: {
  scores: CueEfficacyScore[];
}): React.ReactElement {
  // stub
  return null as unknown as React.ReactElement;
}

// Renders the physical-flag view (one row per metric currently flagged as 'plateau-despite-cues' or 'physical-limit-suspected').
function PhysicalFlagsPanel(props: {
  evaluations: PhysicalLimitEvaluation[];
}): React.ReactElement {
  // stub
  return null as unknown as React.ReactElement;
}
