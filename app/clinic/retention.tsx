import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { getActiveCueBlock, upsertCueBlock } from '@/lib/clinic/cueBlockStore';
import { appendRetentionSwing, getCurrentClinicSession } from '@/lib/clinic/clinicSessionStore';
import { styles } from './clinicStyles';

const RETENTION_SWING_COUNT = 5;

// Retention probe screen — captures N swings tied to the active cue block to test whether the cue's effect persisted.
export default function RetentionScreen(): React.ReactElement {
  // stub: loops RETENTION_SWING_COUNT captures, appends each swing id to active cue block + session.
  return null as unknown as React.ReactElement;
}

// Appends the retention swing id to the active cue block's retentionProbeSwingIds and to the session.
function recordRetentionSwing(swingId: string): void {
  // stub
  throw new Error('Not implemented');
}
