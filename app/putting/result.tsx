import React, { useMemo, useState } from 'react';
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
import { getCurrentPuttResult } from '@/lib/puttResultStore';

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

export default function PuttingResultScreen(): React.ReactElement {
  const router = useRouter();
  // Per-render snapshot (swingMotionStore convention) — set before the push.
  const putt = useMemo(() => getCurrentPuttResult(), []);
  const [showShaft, setShowShaft] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(true);

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
  const tempo = detectors.tempo;
  const warnings = detectors.intermediates.warnings;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>Putt Tempo</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.close}>Close</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* TEMPO CARD */}
        <View style={styles.card}>
          <Text style={styles.scoreText}>{score != null ? score : '—'}</Text>
          <Text style={styles.scoreCaption}>tempo band</Text>
          <Text style={styles.ratioText}>
            {tempo ? `${tempo.ratio.toFixed(2)}:1` : '—'}
          </Text>
          <Text style={styles.timingRow}>
            {tempo
              ? `Back ${Math.round(tempo.backswingMs)}ms · Down ${Math.round(tempo.downswingMs)}ms`
              : 'Tempo withheld'}
          </Text>
          <Text style={styles.chipRow}>
            {chip('TA', detectors.takeawayFrame)} · {chip('TOP', detectors.topFrame)} ·{' '}
            {chip('IMP', detectors.impactFrame)}
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
            </View>
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
