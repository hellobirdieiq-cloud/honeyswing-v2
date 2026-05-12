import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import type {
  EffortLevel,
  StructuralProblem,
  BallContact,
  BallDirection,
} from '@/packages/domain/clinic/enums';
import type { SwingRecord } from '@/packages/domain/clinic/SwingRecord';
import { upsertSwingRecord } from '@/lib/clinic/swingRecordStore';
import { appendBaselineSwing, getCurrentClinicSession } from '@/lib/clinic/clinicSessionStore';
import { styles } from './clinicStyles';

interface PerSwingLogState {
  setupOk: boolean;
  effortLevel: EffortLevel;
  normalSwing: boolean;
  structuralProblem: StructuralProblem;
  ballDirection: BallDirection;
  ballContact: BallContact;
  notes: string;
}

// Baseline capture screen — records a swing then surfaces a per-swing logging form before saving + capturing the next.
export default function BaselineScreen(): React.ReactElement {
  // stub: drives a Vision Camera capture (reusing app/(tabs)/record.tsx hooks), then renders <PerSwingLogForm/> on capture-complete.
  return null as unknown as React.ReactElement;
}

// Renders the per-swing logging form (setup ok, effort, normal swing, structural problem, ball outcome).
function PerSwingLogForm(props: {
  initial: PerSwingLogState;
  onSave: (state: PerSwingLogState) => void;
  onDiscard: () => void;
}): React.ReactElement {
  // stub
  return null as unknown as React.ReactElement;
}

// Builds a SwingRecord from the captured pose data + log state and the active clinic session, then persists it.
function persistBaselineSwing(log: PerSwingLogState): SwingRecord {
  // stub: pulls active session, generates id, calls upsertSwingRecord + appendBaselineSwing.
  throw new Error('Not implemented');
}
