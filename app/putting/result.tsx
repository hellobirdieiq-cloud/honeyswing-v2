import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { VideoView } from 'expo-video';
import { useRouter } from 'expo-router';
import { useSwingVideoClock } from '@/app/analysis/useSwingVideoClock';
import SwingSkeletonCanvas from '@/components/SwingSkeletonCanvas';
import PuttingShaftOverlay from '@/components/PuttingShaftOverlay';
import PhaseLabelBar from '@/components/PhaseLabelBar';
import {
  getCurrentPuttResult,
  getCurrentPuttSwingId,
  subscribeCurrentPuttSwingId,
  getCurrentPuttCaptureToken,
  getCurrentPuttCorrections,
  setCurrentPuttCorrections,
  type PuttCorrections,
} from '@/lib/puttResultStore';
import { supabase } from '@/lib/supabase';
import { APP_VERSION } from '@/lib/appVersion';
import { CAPTURE_FPS, ANALYZER_DECIMATION } from '@/lib/cameraFormat';
import { computePuttingTempo } from '@/packages/domain/putting/computePuttingTempo';
import { tempoBandScore } from '@/packages/domain/putting/tempoBandScore';

/**
 * Putting result screen (Phase C) — TEMPO CARD + Phase B playback overlay.
 *
 * Param-less live-only: reads the just-captured putt from puttResultStore
 * (same push-after-store pattern as the full-swing flow; putt rows are
 * filtered from History in v1, so there is no history entry point yet).
 *
 * Deliberately fires NONE of the full-swing result side effects —
 * sessionAccumulator, session_insight merge, Today's Focus,
 * positiveReinforcement, checkSwingLimit — those are all full-swing metric
 * machinery (plan §result-screen investigation).
 *
 * Score is the TEMPO BAND score only (packages/domain/putting/tempoBandScore
 * — EXTERNAL ASSUMPTION adult anchor). Withheld = em-dash, never 0.
 */

const STAGE_W = Dimensions.get('window').width - 32;
const STAGE_H = Math.round(STAGE_W * (16 / 9));

function chip(label: string, frame: number | null | undefined): string {
  return `${label} ${frame != null ? `f${frame}` : '—'}`;
}

type LabelKey = 'takeaway' | 'top' | 'impact';

export default function PuttingResultScreen(): React.ReactElement {
  const router = useRouter();
  // Per-render snapshot (swingMotionStore convention) — set before the push.
  const putt = useMemo(() => getCurrentPuttResult(), []);
  const puttToken = useMemo(() => getCurrentPuttCaptureToken(), []);
  const [showShaft, setShowShaft] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(true);

  // ── Operator label mode (AUTHORITATIVE — corrections recompute + persist) ──
  const [labelMode, setLabelMode] = useState(false);
  const [labels, setLabels] = useState<Partial<Record<LabelKey, number>>>({});
  const [saveStatus, setSaveStatus] = useState<'ready' | 'saving' | 'saved'>('ready');
  const [saveError, setSaveError] = useState<string | null>(null);
  // Row id arrives after mount (persistPutt resolves async; token-guarded).
  const [swingId, setSwingId] = useState<string | null>(() => getCurrentPuttSwingId());
  useEffect(() => subscribeCurrentPuttSwingId(setSwingId), []);
  // Saved Manual view (survives remount via the store); Auto | Yours toggle.
  const [corrections, setCorrections] = useState<PuttCorrections | null>(() =>
    getCurrentPuttCorrections(),
  );
  const [cardView, setCardView] = useState<'auto' | 'yours'>(() =>
    getCurrentPuttCorrections() ? 'yours' : 'auto',
  );

  const clock = useSwingVideoClock({
    frames: putt?.poseFrames,
    videoUri: putt?.videoUri ?? null,
    videoStoragePath: null,
    isLiveSwing: true,
  });

  if (!putt) {
    return (
      <View style={styles.container}>
        <Text style={styles.header}>Putt</Text>
        <Text style={styles.emptyText}>No putt loaded — record one from the Record tab.</Text>
        <Pressable style={styles.cta} onPress={() => router.back()}>
          <Text style={styles.ctaText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  const { detectors, score, smoothed, shaftLenPx, analysisWidth } = putt.pipeline;
  const warnings = detectors.intermediates.warnings;

  // Auto = immutable detected pipeline; Yours = saved merged corrections.
  // Toggle is DISPLAY-ONLY — the row already holds the Manual values.
  const detected: Record<LabelKey, number | null> = {
    takeaway: detectors.takeawayFrame,
    top: detectors.topFrame,
    impact: detectors.impactFrame,
  };
  const showYours = cardView === 'yours' && corrections != null;
  const cardScore = showYours ? corrections!.score : score;
  const cardTempo = showYours ? corrections!.tempo : detectors.tempo;
  const cardFrames = showYours ? corrections!.effectiveFrames : detected;

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
    const effective: Record<LabelKey, number | null> = {
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
    setCurrentPuttCorrections(saved, puttToken);
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
        {/* TEMPO CARD (Auto = detected pipeline; Yours = saved corrections) */}
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

        {/* PLAYBACK (Phase B overlay) */}
        {putt.videoUri && (
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
                  frameCount={putt.poseFrames.length}
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
              {showSkeleton && putt.poseFrames.length > 0 && (
                <View style={StyleSheet.absoluteFill} pointerEvents="none">
                  <SwingSkeletonCanvas
                    frames={putt.poseFrames}
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
          <Text style={styles.ctaText}>Record Again</Text>
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
