import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import type {
  EffortLevel,
  StructuralProblem,
  BallContact,
  BallDirection,
} from '@/packages/domain/clinic/enums';
import { appendBaselineSwing } from '@/lib/clinic/clinicSessionStore';
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

// Attaches a finalized swing to the active baseline set. persistSwing.ts already wrote the SwingRecord.
function persistBaselineSwing(_log: PerSwingLogState, swingId: string): void {
  appendBaselineSwing(swingId);
}
