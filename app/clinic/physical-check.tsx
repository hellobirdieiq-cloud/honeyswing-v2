import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import type { PhysicalTest, PhysicalTestResult } from '@/packages/domain/clinic/enums';
import type { PhysicalScreenResult } from '@/packages/domain/clinic/KidProfile';
import {
  appendPhysicalCheckResult,
  endClinicSession,
  getCurrentClinicSession,
} from '@/lib/clinic/clinicSessionStore';
import { upsertKidProfile, getKidProfile } from '@/lib/clinic/kidProfileStore';
import { styles } from './clinicStyles';

interface PhysicalCheckFormState {
  selectedTest: PhysicalTest | null;
  result: PhysicalTestResult | null;
  notes: string;
}

// End-of-session physical check screen — Dave selects a targeted test and logs pass/fail/partial.
export default function PhysicalCheckScreen(): React.ReactElement {
  // stub: renders <PhysicalTestSelector/> + <ResultPicker/>; on submit appends result + offers add-another or end-session.
  return null as unknown as React.ReactElement;
}

// Renders the physical-test selector (filtered by handedness + prior screen history).
function PhysicalTestSelector(props: {
  value: PhysicalTest | null;
  onChange: (next: PhysicalTest) => void;
}): React.ReactElement {
  // stub
  return null as unknown as React.ReactElement;
}

// Renders the pass/fail/partial picker with an optional notes field.
function ResultPicker(props: {
  value: PhysicalTestResult | null;
  notes: string;
  onChange: (result: PhysicalTestResult, notes: string) => void;
  onSubmit: () => void;
}): React.ReactElement {
  // stub
  return null as unknown as React.ReactElement;
}

// Persists the result on the active session AND mirrors it onto the kid profile's physicalScreenResults.
function persistPhysicalResult(result: PhysicalScreenResult): void {
  // stub
  throw new Error('Not implemented');
}
