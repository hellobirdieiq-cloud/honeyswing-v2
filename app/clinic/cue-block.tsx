import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router, useRouter } from 'expo-router';
import type {
  BallContact,
  BallDirection,
  CueFamily,
  EffortLevel,
} from '@/packages/domain/clinic/enums';
import type { CueBlockRecord } from '@/packages/domain/clinic/CueBlock';
import { upsertCueBlock } from '@/lib/clinic/cueBlockStore';
import { computeCueEfficacy } from '@/lib/clinic/cueEfficacyOrchestrator';
import {
  appendCueBlock,
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
  clampWords,
} from './components/swingLogControls';
import { styles } from './clinicStyles';
import CaptureSwingPanel from './components/CaptureSwingPanel';

const CUE_FAMILY_OPTIONS: readonly CueFamily[] = [
  'tempo',
  'spine-stability',
  'hip-rotation',
  'shoulder-turn',
  'wrist-set',
  'weight-shift',
  'follow-through',
  'setup',
  'other',
];

const CONFIDENCE_OPTIONS = [
  { label: 'Low', value: 0.33 },
  { label: 'Med', value: 0.66 },
  { label: 'High', value: 1.0 },
] as const;

const POST_CUE_SWING_TARGET = 5;

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function confidenceLabel(value: number): string {
  const match = CONFIDENCE_OPTIONS.find((o) => Math.abs(o.value - value) < 1e-6);
  return match ? match.label : value.toFixed(2);
}

type CueBlockStep =
  | 'prediction'
  | 'cue-selection'
  | 'attention-intent'
  | 'capture-post-cue'
  | 'attention-actual'
  | 'review';

interface PredictionState {
  direction: BallDirection;
  contact: BallContact;
  confidence: number;
}

interface DraftLogState {
  ballContact: BallContact;
  ballDirection: BallDirection;
  setupOk: boolean | null;
  effortLevel: EffortLevel | null;
}

export default function CueBlockScreen(): React.ReactElement | null {
  const navRouter = useRouter();

  // Reactive read of clinic session — subscribe to store changes.
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    refresh();
    return subscribe(refresh);
  }, [refresh]);

  const session = getCurrentClinicSession();
  const kid = session ? getKidProfile(session.kidId) : null;

  // Guard: no active session → bounce to preflight.
  const guardedRef = useRef(false);
  useEffect(() => {
    if (!session && !guardedRef.current) {
      guardedRef.current = true;
      navRouter.replace('/clinic/preflight');
    }
  }, [session, navRouter]);

  const [blockId, setBlockId] = useState<string>(() => generateId());
  const [step, setStep] = useState<CueBlockStep>('prediction');
  const [prediction, setPrediction] = useState<PredictionState>({
    direction: 'unknown',
    contact: 'unknown',
    confidence: 0.66,
  });
  const [cueFamily, setCueFamily] = useState<CueFamily>('other');
  const [cueText, setCueText] = useState<string>('');
  const [attentionIntent, setAttentionIntent] = useState<string>('');
  const [attentionActual, setAttentionActual] = useState<string>('');
  const [postCueSwingIds, setPostCueSwingIds] = useState<string[]>([]);
  const [currentSwingId, setCurrentSwingId] = useState<string | null>(null);
  const [draftLog, setDraftLog] = useState<DraftLogState>({
    ballContact: 'unknown',
    ballDirection: 'unknown',
    setupOk: null,
    effortLevel: null,
  });
  const [swingPhase, setSwingPhase] = useState<'capturing' | 'logging'>('capturing');
  const [attentionActualPending, setAttentionActualPending] = useState<boolean>(false);
  const [confirmed, setConfirmed] = useState<boolean>(false);

  if (!session) {
    return null;
  }

  const buildRecord = (ids: string[]): CueBlockRecord => ({
    id: blockId,
    kidId: session.kidId,
    sessionId: session.id,
    clinicNumber: session.clinicNumber,
    recordedAt: Date.now(),
    cueText,
    cueFamily,
    prediction: {
      direction: prediction.direction,
      contact: prediction.contact,
      confidence: prediction.confidence,
    },
    attentionIntent,
    attentionActual,
    postCueSwingIds: ids,
    retentionProbeSwingIds: [],
  });

  const resetForAnotherBlock = () => {
    setBlockId(generateId());
    setStep('prediction');
    setPrediction({ direction: 'unknown', contact: 'unknown', confidence: 0.66 });
    setCueFamily('other');
    setCueText('');
    setAttentionIntent('');
    setAttentionActual('');
    setPostCueSwingIds([]);
    setCurrentSwingId(null);
    setDraftLog({
      ballContact: 'unknown',
      ballDirection: 'unknown',
      setupOk: null,
      effortLevel: null,
    });
    setSwingPhase('capturing');
    setAttentionActualPending(false);
    setConfirmed(false);
  };

  // ── Step: prediction ───────────────────────────────────────────────────────
  if (step === 'prediction') {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 48 }}>
        <Text style={styles.header}>KID PREDICTION</Text>
        <View style={{ paddingHorizontal: 20, paddingTop: 8, gap: 16 }}>
          <View style={styles.formRow}>
            <Text style={styles.label}>Ball Direction</Text>
            <SegmentedRow
              options={BALL_DIRECTION_OPTIONS}
              value={prediction.direction}
              onChange={(v) => setPrediction((s) => ({ ...s, direction: v }))}
            />
          </View>
          <View style={styles.formRow}>
            <Text style={styles.label}>Ball Contact</Text>
            <SegmentedRow
              options={BALL_CONTACT_OPTIONS}
              value={prediction.contact}
              onChange={(v) => setPrediction((s) => ({ ...s, contact: v }))}
            />
          </View>
          <View style={styles.formRow}>
            <Text style={styles.label}>Confidence</Text>
            <View style={[styles.segmentedControl, { flexWrap: 'wrap' }]}>
              {CONFIDENCE_OPTIONS.map((opt) => {
                const active = Math.abs(opt.value - prediction.confidence) < 1e-6;
                return (
                  <Pressable
                    key={opt.label}
                    onPress={() => setPrediction((s) => ({ ...s, confidence: opt.value }))}
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
          <Pressable style={styles.primaryButton} onPress={() => setStep('cue-selection')}>
            <Text style={styles.primaryButtonText}>Next</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  // ── Step: cue-selection ────────────────────────────────────────────────────
  if (step === 'cue-selection') {
    const canAdvance = cueText.trim() !== '';
    return (
      <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 48 }}>
        <Text style={styles.header}>SELECT CUE</Text>
        <View style={{ paddingHorizontal: 20, paddingTop: 8, gap: 16 }}>
          <View style={styles.formRow}>
            <Text style={styles.label}>Cue Text</Text>
            <TextInput
              value={cueText}
              onChangeText={setCueText}
              placeholder="Cue text…"
              placeholderTextColor="rgba(255,255,255,0.4)"
              style={{
                backgroundColor: '#1A1A1C',
                color: '#FFFFFF',
                paddingHorizontal: 12,
                paddingVertical: 12,
                borderRadius: 10,
                fontSize: 15,
              }}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <View style={styles.formRow}>
            <Text style={styles.label}>Cue Family</Text>
            <SegmentedRow
              options={CUE_FAMILY_OPTIONS}
              value={cueFamily}
              onChange={setCueFamily}
            />
          </View>
          <Pressable
            style={[styles.primaryButton, !canAdvance && { opacity: 0.5 }]}
            disabled={!canAdvance}
            onPress={() => setStep('attention-intent')}
          >
            <Text style={styles.primaryButtonText}>Next</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={() => setStep('prediction')}>
            <Text style={styles.secondaryButtonText}>Back</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  // ── Step: attention-intent ─────────────────────────────────────────────────
  if (step === 'attention-intent') {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 48 }}>
        <Text style={styles.header}>ATTENTION INTENT</Text>
        <View style={{ paddingHorizontal: 20, paddingTop: 8, gap: 16 }}>
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>
            What is the kid going to focus on?
          </Text>
          <View style={styles.formRow}>
            <TextInput
              value={attentionIntent}
              onChangeText={(v) => setAttentionIntent(clampWords(v, 5))}
              placeholder="e.g. 'low and slow'"
              placeholderTextColor="rgba(255,255,255,0.4)"
              style={{
                backgroundColor: '#1A1A1C',
                color: '#FFFFFF',
                paddingHorizontal: 12,
                paddingVertical: 12,
                borderRadius: 10,
                fontSize: 15,
              }}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, marginTop: 4 }}>
              ≤ 5 words
            </Text>
          </View>
          <Pressable style={styles.primaryButton} onPress={() => setStep('capture-post-cue')}>
            <Text style={styles.primaryButtonText}>Start Swings</Text>
          </Pressable>
          <Pressable
            style={styles.secondaryButton}
            onPress={() => {
              setAttentionIntent('');
              setStep('capture-post-cue');
            }}
          >
            <Text style={styles.secondaryButtonText}>Skip</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={() => setStep('cue-selection')}>
            <Text style={styles.secondaryButtonText}>Back</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  // ── Step: capture-post-cue ─────────────────────────────────────────────────
  if (step === 'capture-post-cue') {
    // Interrupt: after swing 1 is logged, prompt for attentionActual before swing 2 begins.
    if (swingPhase === 'capturing' && attentionActualPending) {
      return (
        <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 48 }}>
          <Text style={styles.header}>ATTENTION ACTUAL</Text>
          <View style={{ paddingHorizontal: 20, paddingTop: 8, gap: 16 }}>
            <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14 }}>
              What was the kid actually thinking?
            </Text>
            <View style={styles.formRow}>
              <TextInput
                value={attentionActual}
                onChangeText={(v) => setAttentionActual(clampWords(v, 5))}
                placeholder="e.g. 'the ball'"
                placeholderTextColor="rgba(255,255,255,0.4)"
                style={{
                  backgroundColor: '#1A1A1C',
                  color: '#FFFFFF',
                  paddingHorizontal: 12,
                  paddingVertical: 12,
                  borderRadius: 10,
                  fontSize: 15,
                }}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11, marginTop: 4 }}>
                ≤ 5 words
              </Text>
            </View>
            <Pressable
              style={styles.primaryButton}
              onPress={() => setAttentionActualPending(false)}
            >
              <Text style={styles.primaryButtonText}>Continue</Text>
            </Pressable>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => {
                setAttentionActual('');
                setAttentionActualPending(false);
              }}
            >
              <Text style={styles.secondaryButtonText}>Skip</Text>
            </Pressable>
          </View>
        </ScrollView>
      );
    }

    if (swingPhase === 'capturing') {
      return (
        <View style={styles.screen}>
          <CaptureSwingPanel
            swingLabel={`CUE SWING ${postCueSwingIds.length + 1} OF ${POST_CUE_SWING_TARGET}`}
            immediateStart={true}
            onSwingPersisted={(id) => {
              setCurrentSwingId(id);
              setDraftLog({
                ballContact: 'unknown',
                ballDirection: 'unknown',
                setupOk: null,
                effortLevel: null,
              });
              setSwingPhase('logging');
            }}
          />
        </View>
      );
    }

    // swingPhase === 'logging'
    const onSave = () => {
      if (!currentSwingId) {
        setSwingPhase('capturing');
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
      const newIds = [...postCueSwingIds, currentSwingId];
      setPostCueSwingIds(newIds);
      upsertCueBlock(buildRecord(newIds));
      setCurrentSwingId(null);
      if (newIds.length === 1) {
        setAttentionActualPending(true);
        setSwingPhase('capturing');
      } else if (newIds.length >= POST_CUE_SWING_TARGET) {
        setStep('review');
      } else {
        setSwingPhase('capturing');
      }
    };

    const onDiscard = () => {
      // orphan SwingRecord stays in store — parity with baseline
      setCurrentSwingId(null);
      setSwingPhase('capturing');
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
        <Text style={styles.swingCounter}>
          CUE SWING {postCueSwingIds.length + 1} OF {POST_CUE_SWING_TARGET}
        </Text>
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

  // ── Step: review ───────────────────────────────────────────────────────────
  if (step === 'review') {
    const onConfirm = () => {
      const baseRecord = buildRecord(postCueSwingIds);
      const efficacyScore = computeCueEfficacy(baseRecord, session.baselineSwingIds);
      upsertCueBlock(efficacyScore ? { ...baseRecord, efficacyScore } : baseRecord);
      appendCueBlock(blockId);
      setConfirmed(true);
    };

    return (
      <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 48 }}>
        <Text style={styles.header}>REVIEW</Text>
        <View style={{ paddingHorizontal: 20, paddingTop: 8, gap: 12 }}>
          <View style={styles.reviewBlock}>
            <Text style={{ color: '#FFFFFF', fontSize: 14, marginBottom: 6 }}>
              Kid: {kid?.name ?? session.kidId}
            </Text>
            <Text style={{ color: '#FFFFFF', fontSize: 14, marginBottom: 6 }}>
              Cue: {cueText} ({cueFamily})
            </Text>
            <Text style={{ color: '#FFFFFF', fontSize: 14, marginBottom: 6 }}>
              Prediction: {prediction.direction} / {prediction.contact} / {confidenceLabel(prediction.confidence)}
            </Text>
            <Text style={{ color: '#FFFFFF', fontSize: 14, marginBottom: 6 }}>
              Attention intent: {attentionIntent}
            </Text>
            <Text style={{ color: '#FFFFFF', fontSize: 14, marginBottom: 6 }}>
              Attention actual: {attentionActual}
            </Text>
            <Text style={{ color: '#FFFFFF', fontSize: 14 }}>
              Swings saved: {postCueSwingIds.length}
            </Text>
          </View>

          {!confirmed ? (
            <Pressable style={styles.primaryButton} onPress={onConfirm}>
              <Text style={styles.primaryButtonText}>Confirm & Save</Text>
            </Pressable>
          ) : (
            <>
              <Pressable style={styles.primaryButton} onPress={resetForAnotherBlock}>
                <Text style={styles.primaryButtonText}>Start Another Cue Block</Text>
              </Pressable>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => router.replace('/clinic/dave-dashboard')}
              >
                <Text style={styles.secondaryButtonText}>Done — Back to Dashboard</Text>
              </Pressable>
            </>
          )}
        </View>
      </ScrollView>
    );
  }

  return null;
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
