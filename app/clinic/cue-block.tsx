import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import type {
  CueFamily,
  AttentionTarget,
} from '@/packages/domain/clinic/enums';
import type { CueBlockRecord, PredictionTap } from '@/packages/domain/clinic/CueBlock';
import { upsertCueBlock, getActiveCueBlock } from '@/lib/clinic/cueBlockStore';
import { appendCueBlock } from '@/lib/clinic/clinicSessionStore';
import { styles } from './clinicStyles';

type CueBlockStep =
  | 'prediction'
  | 'cue-selection'
  | 'attention-intent'
  | 'capture-post-cue'
  | 'attention-actual'
  | 'review';

interface CueBlockFormState {
  step: CueBlockStep;
  prediction: PredictionTap;
  cueText: string;
  cueFamily: CueFamily;
  attentionIntent: AttentionTarget;
  attentionActual: AttentionTarget;
  postCueSwingIds: string[];
  notes: string;
}

// Cue block screen — drives the prediction → cue → attention-intent → 5 post-cue swings → attention-actual flow in one screen.
export default function CueBlockScreen(): React.ReactElement {
  // stub: holds CueBlockFormState; renders one of <PredictionTapForm/>, <CueSelectionForm/>, <AttentionField/>, <CaptureSwingPanel/>, <ReviewPanel/> based on step.
  return null as unknown as React.ReactElement;
}

// Renders the pre-cue prediction tap form (direction × contact × confidence slider).
function PredictionTapForm(props: {
  value: PredictionTap;
  onChange: (next: PredictionTap) => void;
  onSubmit: () => void;
}): React.ReactElement {
  // stub
  return null as unknown as React.ReactElement;
}

// Renders the cue selection form (free-text cue + cue family picker).
function CueSelectionForm(props: {
  cueText: string;
  cueFamily: CueFamily;
  onChange: (cueText: string, cueFamily: CueFamily) => void;
  onSubmit: () => void;
}): React.ReactElement {
  // stub
  return null as unknown as React.ReactElement;
}

// Renders an attention-target picker reused for both intent and actual.
function AttentionField(props: {
  label: string;
  value: AttentionTarget;
  onChange: (next: AttentionTarget) => void;
  onSubmit: () => void;
}): React.ReactElement {
  // stub
  return null as unknown as React.ReactElement;
}

// Renders the capture panel for the next post-cue swing in the block (1 of 5, 2 of 5, ...).
function CaptureSwingPanel(props: {
  swingIndex: number;
  totalSwings: number;
  onSwingSaved: (swingId: string) => void;
}): React.ReactElement {
  // stub: drives Vision Camera capture + per-swing logging, calls onSwingSaved with the new SwingRecord.id.
  return null as unknown as React.ReactElement;
}

// Renders the review panel and saves the assembled CueBlockRecord on confirm.
function ReviewPanel(props: {
  state: CueBlockFormState;
  onConfirm: () => void;
}): React.ReactElement {
  // stub: shows summary then calls upsertCueBlock + appendCueBlock + navigates onwards.
  return null as unknown as React.ReactElement;
}
