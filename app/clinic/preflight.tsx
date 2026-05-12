import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type {
  GripClassification,
  StanceClassification,
  LumbarCupClassification,
  FaceAngleClassification,
  Handedness,
} from '@/packages/domain/clinic/enums';
import type { KidAgeTier, KidProfile } from '@/packages/domain/clinic/KidProfile';
import {
  endClinicSession,
  getCurrentClinicSession,
  setPreflight,
  startClinicSession,
} from '@/lib/clinic/clinicSessionStore';
import { listKidProfiles, upsertKidProfile } from '@/lib/clinic/kidProfileStore';
import { dequeueNext } from '@/lib/clinic/kidQueueStore';
import { styles } from './clinicStyles';

interface PreflightFormState {
  grip: GripClassification;
  stance: StanceClassification;
  lumbarCup: LumbarCupClassification;
  faceAngle: FaceAngleClassification;
}

const GRIP_OPTIONS: readonly GripClassification[] = ['weak', 'neutral', 'strong', 'mixed', 'unknown'];
const STANCE_OPTIONS: readonly StanceClassification[] = ['narrow', 'shoulder-width', 'wide', 'unknown'];
const LUMBAR_OPTIONS: readonly LumbarCupClassification[] = ['flat', 'slight', 'pronounced', 'unknown'];
const FACE_OPTIONS: readonly FaceAngleClassification[] = ['open', 'square', 'closed', 'unknown'];
const HANDEDNESS_OPTIONS: readonly Handedness[] = ['left', 'right'];
const AGE_TIER_OPTIONS: readonly KidAgeTier[] = ['junior', 'youth', 'teen', 'adult'];

function generateKidId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Pre-flight gate screen — Dave picks or creates a kid, sets the per-session classifications, then starts the clinic session.
export default function PreflightScreen(): React.ReactElement {
  const params = useLocalSearchParams<{
    kidId?: string;
    clinicNumber?: string;
    fromQueue?: string;
  }>();
  const clinicNum = Number(params.clinicNumber ?? '1');
  const fromQueue = params.fromQueue === 'true';

  const existingProfiles = listKidProfiles();

  const initialMode: 'pick' | 'create' = params.kidId && existingProfiles.some((k) => k.id === params.kidId)
    ? 'pick'
    : existingProfiles.length > 0
      ? 'pick'
      : 'create';
  const initialSelected =
    params.kidId && existingProfiles.some((k) => k.id === params.kidId)
      ? params.kidId
      : existingProfiles[0]?.id ?? null;

  const [mode, setMode] = useState<'pick' | 'create'>(initialMode);
  const [selectedKidId, setSelectedKidId] = useState<string | null>(initialSelected);
  const [name, setName] = useState<string>('');
  const [handedness, setHandedness] = useState<Handedness>('right');
  const [ageTier, setAgeTier] = useState<KidAgeTier>('junior');
  const [classifications, setClassifications] = useState<PreflightFormState>({
    grip: 'unknown',
    stance: 'unknown',
    lumbarCup: 'unknown',
    faceAngle: 'unknown',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitDisabled =
    submitting || (mode === 'create' && name.trim().length === 0);

  async function onSubmit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      // endClinicSession lives here (not in Tab1LiveView NEXT KID) so a cancel/back from preflight
      // leaves the prior session alive.
      if (getCurrentClinicSession() !== null) {
        endClinicSession();
      }

      let kidId: string | null = selectedKidId;
      if (mode === 'create') {
        const now = Date.now();
        const newId = generateKidId();
        const newProfile: KidProfile = {
          id: newId,
          name: name.trim(),
          ageTier,
          handedness,
          gripHistory: [],
          faceAngleHistory: [],
          lumbarCupHistory: [],
          physicalScreenResults: [],
          createdAt: now,
          updatedAt: now,
        };
        upsertKidProfile(newProfile);
        kidId = newId;
      }

      if (!kidId) {
        setError('Pick or create a kid before starting.');
        setSubmitting(false);
        return;
      }

      await startClinicSession(kidId, clinicNum);
      setPreflight({
        grip: classifications.grip,
        stance: classifications.stance,
        lumbarCup: classifications.lumbarCup,
        faceAngle: classifications.faceAngle,
        capturedAt: Date.now(),
      });

      if (fromQueue) {
        dequeueNext();
      }

      router.replace('/clinic/baseline');
    } catch {
      setError('Could not start session — are you signed in?');
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
        {/* SECTION A — Kid identity */}
        <Text style={styles.header}>{"WHO'S UP?"}</Text>
        <View style={styles.body}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 12 }}>
            {existingProfiles.map((profile) => {
              const active = mode === 'pick' && selectedKidId === profile.id;
              return (
                <Pressable
                  key={profile.id}
                  onPress={() => {
                    setMode('pick');
                    setSelectedKidId(profile.id);
                  }}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    borderRadius: 10,
                    backgroundColor: active ? '#D4A017' : '#1A1A1C',
                  }}
                >
                  <Text style={{ color: active ? '#000' : '#FFF', fontSize: 14, fontWeight: '600' }}>
                    {profile.name}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => {
                setMode('create');
                setSelectedKidId(null);
              }}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 10,
                borderRadius: 10,
                backgroundColor: mode === 'create' ? '#D4A017' : '#1A1A1C',
              }}
            >
              <Text
                style={{
                  color: mode === 'create' ? '#000' : '#FFF',
                  fontSize: 14,
                  fontWeight: '600',
                }}
              >
                + New
              </Text>
            </Pressable>
          </View>

          {mode === 'create' ? (
            <View>
              <View style={styles.formRow}>
                <Text style={styles.label}>Name</Text>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  placeholder="Kid's name"
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  style={{
                    backgroundColor: '#1A1A1C',
                    color: '#FFFFFF',
                    fontSize: 16,
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    borderRadius: 10,
                  }}
                />
              </View>

              <View style={styles.formRow}>
                <Text style={styles.label}>Handedness</Text>
                <SegmentedRow
                  options={HANDEDNESS_OPTIONS}
                  value={handedness}
                  onChange={setHandedness}
                />
              </View>

              <View style={styles.formRow}>
                <Text style={styles.label}>Age Tier</Text>
                <SegmentedRow
                  options={AGE_TIER_OPTIONS}
                  value={ageTier}
                  onChange={setAgeTier}
                />
              </View>
            </View>
          ) : null}
        </View>

        {/* SECTION B — Per-session classifications */}
        <Text style={styles.header}>SESSION SETUP</Text>
        <View style={styles.body}>
          <ClassificationPicker
            label="Grip"
            value={classifications.grip}
            options={GRIP_OPTIONS}
            onChange={(v) => setClassifications((s) => ({ ...s, grip: v }))}
          />
          <ClassificationPicker
            label="Stance"
            value={classifications.stance}
            options={STANCE_OPTIONS}
            onChange={(v) => setClassifications((s) => ({ ...s, stance: v }))}
          />
          <ClassificationPicker
            label="Lumbar Cup"
            value={classifications.lumbarCup}
            options={LUMBAR_OPTIONS}
            onChange={(v) => setClassifications((s) => ({ ...s, lumbarCup: v }))}
          />
          <ClassificationPicker
            label="Face Angle"
            value={classifications.faceAngle}
            options={FACE_OPTIONS}
            onChange={(v) => setClassifications((s) => ({ ...s, faceAngle: v }))}
          />
        </View>

        {/* SUBMIT */}
        <View style={{ paddingHorizontal: 20, paddingTop: 20 }}>
          <Pressable
            onPress={onSubmit}
            disabled={submitDisabled}
            style={[styles.primaryButton, submitDisabled ? { opacity: 0.5 } : null]}
            accessibilityRole="button"
          >
            <Text style={styles.primaryButtonText}>
              {submitting ? 'Starting…' : 'Start Session'}
            </Text>
          </Pressable>
          {error ? (
            <Text
              style={{
                color: '#FF4D4F',
                fontSize: 13,
                marginTop: 12,
                textAlign: 'center',
              }}
            >
              {error}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

// Renders a labelled segmented control for one classification field. Inline-only; not extracted.
function ClassificationPicker<T extends string>(props: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
}): React.ReactElement {
  return (
    <View style={styles.formRow}>
      <Text style={styles.label}>{props.label}</Text>
      <SegmentedRow options={props.options} value={props.value} onChange={props.onChange} />
    </View>
  );
}

function SegmentedRow<T extends string>(props: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}): React.ReactElement {
  return (
    <View style={styles.segmentedControl}>
      {props.options.map((opt) => {
        const active = opt === props.value;
        return (
          <Pressable
            key={opt}
            onPress={() => props.onChange(opt)}
            style={[styles.segmentButton, active ? styles.segmentButtonActive : null]}
          >
            <Text
              style={{
                color: active ? '#000000' : '#FFFFFF',
                fontSize: 12,
                fontWeight: '700',
                letterSpacing: 0.5,
                textTransform: 'uppercase',
              }}
              numberOfLines={1}
            >
              {opt}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
