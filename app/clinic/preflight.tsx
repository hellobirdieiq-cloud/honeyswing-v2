import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import type {
  GripClassification,
  StanceClassification,
  LumbarCupClassification,
  FaceAngleClassification,
} from '@/packages/domain/clinic/enums';
import { startClinicSession, setPreflight } from '@/lib/clinic/clinicSessionStore';
import { styles } from './clinicStyles';

interface PreflightFormState {
  grip: GripClassification;
  stance: StanceClassification;
  lumbarCup: LumbarCupClassification;
  faceAngle: FaceAngleClassification;
}

// Pre-flight gate screen — Dave taps grip / stance / lumbar cup / face angle classifications before swings begin.
export default function PreflightScreen(): React.ReactElement {
  // stub: holds PreflightFormState locally; submit calls startClinicSession + setPreflight then router.push('/clinic/baseline').
  return null as unknown as React.ReactElement;
}

// Renders a labelled segmented control for one classification field.
function ClassificationPicker<T extends string>(props: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
}): React.ReactElement {
  // stub
  return null as unknown as React.ReactElement;
}
