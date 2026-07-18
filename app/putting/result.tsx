import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import { VideoView } from 'expo-video';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSwingVideoClock } from '@/app/analysis/useSwingVideoClock';
import SwingSkeletonCanvas from '@/components/SwingSkeletonCanvas';
import PuttingShaftOverlay from '@/components/PuttingShaftOverlay';
import PhaseLabelBar from '@/components/PhaseLabelBar';
import { usePuttSource, type PuttEventFrames } from './usePuttSource';
import { setCurrentPuttCorrections, type PuttCorrections } from '@/lib/puttResultStore';
import { supabase } from '@/lib/supabase';
import { APP_VERSION } from '@/lib/appVersion';
import { CAPTURE_FPS, ANALYZER_DECIMATION } from '@/lib/cameraFormat';
import { computePuttingTempo } from '@/packages/domain/putting/computePuttingTempo';
import { tempoBandScore } from '@/packages/domain/putting/tempoBandScore';

/**
 * Putting result screen — TEMPO CARD + playback overlay + operator label mode.
 *
 * TWO data paths via usePuttSource (History v2): LIVE (param-less, store
 * snapshot — the original flow) and HISTORY (swingId param from a History-list
 * putt row; card + overlay reconstructed from swing_debug.putting, video via
 * the clock's signed-URL branch). Label mode works in BOTH — saves update the
 * row identically; only the live path also mirrors corrections into the store
 * (token-guarded; the store belongs to the live capture).
 *
 * Fires NONE of the full-swing result side effects (sessionAccumulator,
 * session_insight merge, Today's Focus, positiveReinforcement, checkSwingLimit).
 * Score = tempo band only; withheld = em-dash, never 0.
 */

const STAGE_W = Dimensions.get('window').width - 32;
const STAGE_H = Math.round(STAGE_W * (16 / 9));

function chip(label: string, frame: number | null | undefined): string {
  return `${label} ${frame != null ? `f${frame}` : '—'}`;
}

type LabelKey = 'takeaway' | 'top' | 'impact';

export default function PuttingResultScreen(): React.ReactElement {
  const router = useRouter();
  const { swingId: swingIdParam } = useLocalSearchParams<{ swingId?: string }>();
  const source = usePuttSource(swingIdParam);

  const [showShaft, setShowShaft] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(true);

  // ── Operator label mode ──
  const [labelMode, setLabelMode] = useState(false);
  const [labels, setLabels] = useState<Partial<Record<LabelKey, number>>>({});
  const [saveStatus, setSaveStatus] = useState<'ready' | 'saving' | 'saved'>('ready');
  const [saveError, setSaveError] = useState<string | null>(null);
  // Saved Yours view — seeded from the source once it resolves (history loads
  // async; live is ready immediately), then owned locally after saves.
  const [corrections, setCorrections] = useState<PuttCorrections | null>(null);
  const [cardView, setCardView] = useState<'auto' | 'yours'>('auto');
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || source.status !== 'ready') return;
    setSeeded(true);
    setCorrections(source.corrections);
    if (source.corrections) setCardView('yours');
  }, [seeded, source]);

  const ready = source.status === 'ready' ? source : null;
  const clock = useSwingVideoClock({
    frames: ready?.poseFrames,
    videoUri: ready?.videoUri ?? null,
    videoStoragePath: ready?.videoStoragePath ?? null,
    isLiveSwing: ready?.isLive ?? true,
  });

  if (source.status === 'loading') {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color="#FFD60A" />
      </View>
    );
  }
  if (source.status === 'empty' || source.status === 'error') {
    return (
      <View style={styles.container}>
        <Text style={styles.header}>Putt</Text>
        <Text style={styles.emptyText}>
          {source.status === 'error'
            ? source.message
            : 'No putt loaded — record one from the Record tab.'}
        </Text>
        <Pressable style={styles.cta} onPress={() => router.back()}>
          <Text style={styles.ctaText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  const {
    isLive,
    swingId,
    poseFrames,
    detected,
    detectedTempo,
    detectedScore,
    warnings,
    smoothed,
    shaftLenPx,
    analysisWidth,
    captureToken,
  } = source;
  const hasPlayback = !!(ready?.videoUri || ready?.videoStoragePath);

  // Auto = detected (immutable); Yours = saved corrections. Display-only.
  const showYours = cardView === 'yours' && corrections != null;
  const cardScore = showYours ? corrections!.score : detectedScore;
  const cardTempo = showYours ? corrections!.tempo : detectedTempo;
  const cardFrames: PuttEventFrames = showYours ? corrections!.effectiveFrames : detected;

  const stampedCount = (Object.keys(labels) as LabelKey[]).filter(
    (k) => labels[k] != null,
  ).length;
  const saveState =
    stampedCount === 0 || swingId == null
      ? ('disabled' as const)
      : saveStatus === 'saving'
        ? ('saving' as const)
        : saveStatus === 'saved'
          ? ('saved' as const)
          : ('ready' as const);
  const saveDisabledReason =
    stampedCount === 0
      ? 'stamp at least one event to save'
      : swingId == null
        ? 'row not persisted (sign in and re-record to save corrections)'
        : undefined;

  const onSaveCorrections = async () => {
    if (swingId == null || stampedCount === 0) return;
    setSaveStatus('saving');
    setSaveError(null);
    // Merged (Manual) frames: operator where stamped, detected where not.
    const effective: PuttEventFrames = {
      takeaway: labels.takeaway ?? detected.takeaway,
      top: labels.top ?? detected.top,
      impact: labels.impact ?? detected.impact,
    };
    const stepMs = ANALYZER_DECIMATION * (1000 / CAPTURE_FPS);
    const tempo = computePuttingTempo(
      effective.takeaway,
      effective.top,
      effective.impact,
      stepMs,
    );
    const newScore = tempoBandScore(tempo?.ratio ?? null);

    // 1) Row columns get the MANUAL values (direct update — RLS user-scoped).
    //    NEVER touch swing_debug via .update() (wholesale overwrite).
    const { error: updateError } = await supabase
      .from('swings')
      .update({
        tempo_ratio: tempo?.ratio ?? null,
        backswing_ms: tempo != null ? Math.round(tempo.backswingMs) : null,
        downswing_ms: tempo != null ? Math.round(tempo.downswingMs) : null,
        score: newScore,
      })
      .eq('id', swingId);
    // 2) Label record under the SIBLING top-level key (merge_swing_debug is a
    //    top-level shallow merge — {putting: …} would clobber the detected
    //    payload). Stamped events only + FULL detected snapshot.
    const stampedLabels: Partial<Record<LabelKey, number>> = {};
    const deltas: Partial<Record<LabelKey, number | null>> = {};
    for (const k of Object.keys(labels) as LabelKey[]) {
      const v = labels[k];
      if (v == null) continue;
      stampedLabels[k] = v;
      deltas[k] = detected[k] != null ? v - (detected[k] as number) : null;
    }
    const { error: rpcError } = await supabase.rpc('merge_swing_debug', {
      swing_id: swingId,
      patch: {
        putting_operator_labels: {
          schema: 1,
          labels: stampedLabels,
          detected,
          deltas,
          step_ms: stepMs,
          app_version: APP_VERSION,
          labeled_at_ms: Date.now(),
        },
      },
    });

    // Partial-failure honesty: ✓ only when BOTH landed; else surface a retry.
    if (updateError || rpcError) {
      setSaveStatus('ready');
      setSaveError(
        `save incomplete — ${updateError ? 'row update' : 'label record'} failed; tap to retry`,
      );
      return;
    }
    const saved: PuttCorrections = { effectiveFrames: effective, tempo, score: newScore };
    // The store belongs to the LIVE capture — history saves stay local.
    if (isLive && captureToken != null) {
      setCurrentPuttCorrections(saved, captureToken);
    }
    setCorrections(saved);
    setCardView('yours');
    setSaveStatus('saved');
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>Putt Tempo</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.close}>Close</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* TEMPO CARD (Auto = detected; Yours = saved corrections) */}
        <View style={styles.card}>
          {corrections != null && (
            <View style={styles.viewToggleRow}>
              {(['auto', 'yours'] as const).map((v) => (
                <Pressable
                  key={v}
                  style={[styles.viewToggle, cardView === v && styles.viewToggleActive]}
                  onPress={() => setCardView(v)}
                >
                  <Text
                    style={[styles.viewToggleText, cardView === v && styles.viewToggleTextActive]}
                  >
                    {v === 'auto' ? 'Auto' : 'Yours'}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          <Text style={styles.scoreText}>{cardScore != null ? cardScore : '—'}</Text>
          <Text style={styles.scoreCaption}>tempo band</Text>
          <Text style={styles.ratioText}>
            {cardTempo ? `${cardTempo.ratio.toFixed(2)}:1` : '—'}
          </Text>
          <Text style={styles.timingRow}>
            {cardTempo
              ? `Back ${Math.round(cardTempo.backswingMs)}ms · Down ${Math.round(cardTempo.downswingMs)}ms`
              : 'Tempo withheld'}
          </Text>
          <Text style={styles.chipRow}>
            {chip('TA', cardFrames.takeaway)} · {chip('TOP', cardFrames.top)} ·{' '}
            {chip('IMP', cardFrames.impact)}
          </Text>
          {warnings.length > 0 && (
            <Text style={styles.warningsText}>{warnings.join(' · ')}</Text>
          )}
        </View>

        {/* PLAYBACK (Phase B overlay) — live local file or history signed URL */}
        {hasPlayback && (
          <>
            <View style={styles.toggleRow}>
              <Pressable
                onPress={() => setShowShaft((v) => !v)}
                style={[styles.toggle, showShaft && styles.toggleActive]}
              >
                <Text style={[styles.toggleText, showShaft && styles.toggleTextActive]}>
                  SHAFT {showShaft ? 'ON' : 'off'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setShowSkeleton((v) => !v)}
                style={[styles.toggle, showSkeleton && styles.toggleActive]}
              >
                <Text style={[styles.toggleText, showSkeleton && styles.toggleTextActive]}>
                  SKELETON {showSkeleton ? 'ON' : 'off'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setLabelMode((v) => !v)}
                style={[styles.toggle, labelMode && styles.toggleActive]}
              >
                <Text style={[styles.toggleText, labelMode && styles.toggleTextActive]}>
                  LABEL {labelMode ? 'ON' : 'off'}
                </Text>
              </Pressable>
            </View>
            {labelMode && (
              <>
                <PhaseLabelBar
                  events={[
                    { key: 'takeaway', label: 'TA', detectedFrame: detected.takeaway },
                    { key: 'top', label: 'TOP', detectedFrame: detected.top },
                    { key: 'impact', label: 'IMP', detectedFrame: detected.impact },
                  ]}
                  frameCount={poseFrames.length}
                  videoIdx={clock.videoIdx ?? 0}
                  seekToFrame={clock.seekToFrame}
                  labels={labels}
                  onStamp={(key, frame) => {
                    setLabels((prev) => ({ ...prev, [key]: frame }));
                    setSaveStatus('ready');
                    setSaveError(null);
                  }}
                  onResetLabels={() => {
                    setLabels({});
                    setSaveStatus('ready');
                    setSaveError(null);
                  }}
                  onSave={() => void onSaveCorrections()}
                  saveButtonLabel="Save Corrections"
                  saveState={saveState}
                  saveDisabledReason={saveDisabledReason}
                />
                {saveError != null && <Text style={styles.saveErrorText}>{saveError}</Text>}
              </>
            )}
            <View style={{ width: STAGE_W, height: STAGE_H }}>
              <VideoView
                player={clock.player}
                style={{ width: STAGE_W, height: STAGE_H }}
                contentFit="contain"
                nativeControls={false}
              />
              {showSkeleton && poseFrames.length > 0 && (
                <View style={StyleSheet.absoluteFill} pointerEvents="none">
                  <SwingSkeletonCanvas
                    frames={poseFrames}
                    phases={null}
                    width={STAGE_W}
                    height={STAGE_H}
                    playheadIdx={clock.videoIdx ?? 0}
                    overlay
                  />
                </View>
              )}
              {showShaft && smoothed && shaftLenPx != null && (
                <PuttingShaftOverlay
                  smoothed={smoothed}
                  shaftLenPx={shaftLenPx}
                  analysisWidth={analysisWidth}
                  playheadIdx={clock.videoIdx ?? 0}
                  width={STAGE_W}
                  height={STAGE_H}
                />
              )}
            </View>
            <View style={styles.toggleRow}>
              <Pressable
                onPress={() => (clock.isPlaying ? clock.player?.pause() : clock.player?.play())}
                style={styles.toggle}
              >
                <Text style={styles.toggleText}>{clock.isPlaying ? 'Pause' : 'Play'}</Text>
              </Pressable>
              {([0.25, 1] as const).map((sp) => (
                <Pressable
                  key={sp}
                  onPress={() => clock.setSpeed(sp)}
                  style={[styles.toggle, clock.speed === sp && styles.toggleActive]}
                >
                  <Text style={[styles.toggleText, clock.speed === sp && styles.toggleTextActive]}>
                    {sp}×
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        <Pressable style={styles.cta} onPress={() => router.back()}>
          <Text style={styles.ctaText}>{isLive ? 'Record Again' : 'Back'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    padding: 16,
    paddingTop: 60,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  header: {
    color: '#FFF',
    fontSize: 22,
    fontWeight: '700',
  },
  close: {
    color: '#0A84FF',
    fontSize: 16,
    fontWeight: '600',
  },
  scrollContent: {
    paddingBottom: 40,
  },
  emptyText: {
    color: '#AAA',
    fontSize: 15,
    marginBottom: 16,
  },
  card: {
    backgroundColor: '#1C1C1E',
    borderRadius: 12,
    padding: 20,
    alignItems: 'center',
    marginBottom: 16,
  },
  scoreText: {
    color: '#FFD60A',
    fontSize: 64,
    fontWeight: '800',
  },
  scoreCaption: {
    color: '#888',
    fontSize: 12,
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  ratioText: {
    color: '#FFF',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 4,
  },
  timingRow: {
    color: '#AAA',
    fontSize: 15,
    marginBottom: 10,
  },
  chipRow: {
    color: '#26E0E0',
    fontSize: 14,
    fontFamily: 'Menlo',
    fontWeight: '700',
  },
  warningsText: {
    color: '#FF9F0A',
    fontSize: 12,
    fontFamily: 'Menlo',
    marginTop: 10,
    textAlign: 'center',
  },
  viewToggleRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
    alignSelf: 'center',
  },
  viewToggle: {
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 18,
  },
  viewToggleActive: {
    borderColor: '#FFD60A',
    backgroundColor: '#FFD60A22',
  },
  viewToggleText: {
    color: '#888',
    fontSize: 13,
    fontWeight: '700',
  },
  viewToggleTextActive: {
    color: '#FFD60A',
  },
  saveErrorText: {
    color: '#FF6961',
    fontSize: 12,
    fontFamily: 'Menlo',
    marginBottom: 10,
    textAlign: 'center',
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
    marginTop: 2,
  },
  toggle: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  toggleActive: {
    borderColor: '#0A84FF',
    backgroundColor: '#0A84FF22',
  },
  toggleText: {
    color: '#888',
    fontSize: 13,
    fontFamily: 'Menlo',
  },
  toggleTextActive: {
    color: '#0A84FF',
    fontWeight: '700',
  },
  cta: {
    backgroundColor: '#30D158',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 16,
  },
  ctaText: {
    color: '#000',
    fontSize: 17,
    fontWeight: '700',
  },
});
