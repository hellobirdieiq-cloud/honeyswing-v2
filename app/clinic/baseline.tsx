import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { router, useRouter } from 'expo-router';
import type {
  BallContact,
  BallDirection,
  EffortLevel,
} from '@/packages/domain/clinic/enums';
import {
  appendBaselineSwing,
  getCurrentClinicSession,
  subscribe,
} from '@/lib/clinic/clinicSessionStore';
import { getKidProfile } from '@/lib/clinic/kidProfileStore';
import { getSwingRecord, upsertSwingRecord } from '@/lib/clinic/swingRecordStore';
import {
  BALL_CONTACT_OPTIONS,
  BALL_DIRECTION_OPTIONS,
  EFFORT_OPTIONS,
  KID_SIMPLE_OUTCOMES,
} from './components/swingLogControls';
import { styles } from './clinicStyles';
import CaptureSwingPanel from './components/CaptureSwingPanel';

type Phase = 'capturing' | 'logging' | 'complete';

interface PerSwingLogState {
  ballContact: BallContact;
  ballDirection: BallDirection;
  setupOk: boolean | null;
  effortLevel: EffortLevel | null;
}

export default function BaselineScreen(): React.ReactElement | null {
  const navRouter = useRouter();

  // Reactive read of clinic session — subscribe to store changes.
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    refresh();
    return subscribe(refresh);
  }, [refresh]);

  const session = getCurrentClinicSession();
  const swingsSaved = session?.baselineSwingIds.length ?? 0;
  const kid = session ? getKidProfile(session.kidId) : null;

  // Guard: no active session → bounce to preflight.
  const guardedRef = useRef(false);
  useEffect(() => {
    if (!session && !guardedRef.current) {
      guardedRef.current = true;
      navRouter.replace('/clinic/preflight');
    }
  }, [session, navRouter]);

  const [phase, setPhase] = useState<Phase>('capturing');
  const [currentSwingId, setCurrentSwingId] = useState<string | null>(null);
  const [draftLog, setDraftLog] = useState<PerSwingLogState>({
    ballContact: 'unknown',
    ballDirection: 'unknown',
    setupOk: null,
    effortLevel: null,
  });

  if (!session) {
    return null;
  }

  // Phase: complete — render summary card and CTA into cue-block.
  if (phase === 'complete' || swingsSaved >= 5) {
    return (
      <View style={styles.screen}>
        <Text style={styles.header}>BASELINE COMPLETE</Text>
        <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 24, gap: 24 }}>
          <Text style={{ color: '#FFFFFF', fontSize: 18, fontWeight: '600' }}>
            {kid?.name ?? 'Kid'} — 5 swings saved
          </Text>
          <Pressable
            style={styles.primaryButton}
            onPress={() => router.replace('/clinic/cue-block')}
          >
            <Text style={styles.primaryButtonText}>Begin Cue Block</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // Phase: logging — per-swing log form.
  if (phase === 'logging') {
    const onSave = () => {
      if (!currentSwingId) {
        setPhase('capturing');
        return;
      }
      const existing = getSwingRecord(currentSwingId);
      if (existing) {
        upsertSwingRecord({
          ...existing,
          ballOutcome: {
            direction: draftLog.ballDirection,
            contact: draftLog.ballContact,
          },
          setupOk: draftLog.setupOk ?? undefined,
          effortLevel: draftLog.effortLevel ?? undefined,
        });
      }
      appendBaselineSwing(currentSwingId);
      const nextCount = swingsSaved + 1;
      setCurrentSwingId(null);
      setPhase(nextCount >= 5 ? 'complete' : 'capturing');
    };

    const onDiscard = () => {
      // orphan SwingRecord stays in store — acceptable per v1 decision
      setCurrentSwingId(null);
      setPhase('capturing');
    };

    const isJunior = kid?.ageTier === 'junior';
    const kidSelectionLabel = (() => {
      const match = KID_SIMPLE_OUTCOMES.find(
        (o) => o.direction === draftLog.ballDirection && o.contact === draftLog.ballContact,
      );
      return match?.label;
    })();

    return (
      <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 48 }}>
        <Text style={styles.swingCounter}>BASELINE {swingsSaved + 1} OF 5</Text>
        <View style={{ paddingHorizontal: 20, paddingTop: 16, gap: 16 }}>
          {isJunior ? (
            <View style={styles.formRow}>
              <Text style={styles.label}>Ball Outcome</Text>
              <View style={[styles.segmentedControl, { flexWrap: 'wrap' }]}>
                {KID_SIMPLE_OUTCOMES.map((opt) => {
                  const active = opt.label === kidSelectionLabel;
                  return (
                    <Pressable
                      key={opt.label}
                      onPress={() =>
                        setDraftLog((s) => ({
                          ...s,
                          ballDirection: opt.direction,
                          ballContact: opt.contact,
                        }))
                      }
                      style={[
                        styles.segmentButton,
                        active ? styles.segmentButtonActive : null,
                        { flexGrow: 1, flexBasis: '30%' },
                      ]}
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
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : (
            <>
              <View style={styles.formRow}>
                <Text style={styles.label}>Ball Contact</Text>
                <SegmentedRow
                  options={BALL_CONTACT_OPTIONS}
                  value={draftLog.ballContact}
                  onChange={(v) => setDraftLog((s) => ({ ...s, ballContact: v }))}
                />
              </View>
              <View style={styles.formRow}>
                <Text style={styles.label}>Ball Direction</Text>
                <SegmentedRow
                  options={BALL_DIRECTION_OPTIONS}
                  value={draftLog.ballDirection}
                  onChange={(v) => setDraftLog((s) => ({ ...s, ballDirection: v }))}
                />
              </View>
            </>
          )}
          <View style={styles.formRow}>
            <Text style={styles.label}>Setup OK?</Text>
            <View style={[styles.segmentedControl, { flexWrap: 'wrap' }]}>
              {(['yes', 'no'] as const).map((opt) => {
                const value = opt === 'yes';
                const active = draftLog.setupOk === value;
                return (
                  <Pressable
                    key={opt}
                    onPress={() => setDraftLog((s) => ({ ...s, setupOk: value }))}
                    style={[
                      styles.segmentButton,
                      active ? styles.segmentButtonActive : null,
                      { flexGrow: 1, flexBasis: '30%' },
                    ]}
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
          </View>
          <View style={styles.formRow}>
            <Text style={styles.label}>Effort</Text>
            <View style={[styles.segmentedControl, { flexWrap: 'wrap' }]}>
              {EFFORT_OPTIONS.map((opt) => {
                const active = draftLog.effortLevel === opt;
                return (
                  <Pressable
                    key={opt}
                    onPress={() => setDraftLog((s) => ({ ...s, effortLevel: opt }))}
                    style={[
                      styles.segmentButton,
                      active ? styles.segmentButtonActive : null,
                      { flexGrow: 1, flexBasis: '30%' },
                    ]}
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
          </View>
          <Pressable style={styles.primaryButton} onPress={onSave}>
            <Text style={styles.primaryButtonText}>Save Swing</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={onDiscard}>
            <Text style={styles.secondaryButtonText}>Discard</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  // Phase: capturing — delegate to shared CaptureSwingPanel.
  return (
    <View style={styles.screen}>
      <CaptureSwingPanel
        swingLabel={`BASELINE ${swingsSaved + 1} OF 5`}
        immediateStart={true}
        onSwingPersisted={(id) => {
          setCurrentSwingId(id);
          setDraftLog({
            ballContact: 'unknown',
            ballDirection: 'unknown',
            setupOk: null,
            effortLevel: null,
          });
          setPhase('logging');
        }}
      />
    </View>
  );
}

function SegmentedRow<T extends string>(props: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}): React.ReactElement {
  return (
    <View style={[styles.segmentedControl, { flexWrap: 'wrap' }]}>
      {props.options.map((opt) => {
        const active = opt === props.value;
        return (
          <Pressable
            key={opt}
            onPress={() => props.onChange(opt)}
            style={[
              styles.segmentButton,
              active ? styles.segmentButtonActive : null,
              { flexGrow: 1, flexBasis: '30%' },
            ]}
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
