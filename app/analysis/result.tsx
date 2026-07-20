import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Pressable, useWindowDimensions, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, type Href } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { VideoView } from 'expo-video';
import { styles } from './resultStyles';
import {
  computeFocus,
  saveFocus,
  getCurrentSwingId,
  subscribeCurrentSwingId,
} from '../../lib/swingMotionStore';
import { checkSwingLimit } from '../../lib/swingLimit';
import { getCachedAgeTier } from '@/lib/ageTier';
import { getUser, supabase } from '../../lib/supabase';
import { VideoLabelOverlay, LabelControlsBelow } from '../../components/VideoLabelOverlay';
import { APP_VERSION } from '../../lib/appVersion';
import { GOLD } from '../../lib/colors';
import type { SwingPhase } from '../../packages/domain/swing/phaseDetection';
import { getActiveProfileHandedness } from '../../lib/handedness';
import { getPrimaryProfile, getProfiles, type PlayerProfile } from '../../lib/playerProfiles';
import { resolveHeaderProfile } from '../../lib/headerIdentity';
import { getCoachCode } from '../../lib/coachCode';
import { processSwingTips, type ProcessedCoachingTip } from '@/packages/domain/swing/tipFrequency';
import { shouldShowMetric } from '../../packages/domain/swing/confidenceScore';
import SwingArtCard from '../../components/SwingArtCard';
import SwingSkeletonCanvas from '../../components/SwingSkeletonCanvas';
import { positiveReinforcementEngine } from '@/packages/domain/swing/positiveReinforcement';
import type { ProcessSwingResult } from '@/packages/domain/swing/positiveReinforcement';
import { sessionAccumulator, type SessionInsight } from '../../lib/sessionAccumulator';
import { buildRawTips, dedupeWorstMetricScores } from '../../lib/coachingTips';
import { deriveTempoDisplay } from '../../packages/domain/swing/tempoDisplay';
import { useSwingSource } from './useSwingSource';
import { useSwingVideoClock } from './useSwingVideoClock';
import { useFullSwingRegrade } from './useFullSwingRegrade';
import { regradeFromOperatorPhases } from '../../packages/domain/swing/operatorRegrade';

type PhaseChipKey = SwingPhase | 'full_swing';
const PHASE_CHIPS: { phase: PhaseChipKey; label: string }[] = [
  { phase: 'full_swing',     label: 'Full Swing' },
  { phase: 'takeaway',       label: 'Takeaway' },
  { phase: 'top',            label: 'Top' },
  { phase: 'impact',         label: 'Impact' },
  { phase: 'follow_through', label: 'Finish' },
];

const NO_DATA_FAILURE_REASONS = new Set([
  'no-person',
  'zero-frames',
  'recording-stop-fallback',
  'recording-error',
  'extract-or-analyze-threw',
]);

export default function ResultScreen() {
  const router = useRouter();
  const { swingId } = useLocalSearchParams<{ swingId?: string }>();
  // Live captures navigate here WITHOUT a swingId param (navigation no longer
  // waits for the DB insert); the id arrives via the store subscription when
  // persistSwing resolves. The param always wins — history taps and coach
  // deep-links carry it, so a lingering live id can never leak into those.
  const [liveSwingId, setLiveSwingId] = useState<string | null>(getCurrentSwingId());
  useEffect(() => {
    // Re-read on attach: a store notify landing between the useState
    // initializer and this subscription (fast insert resolving during the
    // first render window) would otherwise be missed forever.
    setLiveSwingId(getCurrentSwingId());
    return subscribeCurrentSwingId(setLiveSwingId);
  }, []);
  const effectiveSwingId = swingId ?? liveSwingId ?? undefined;
  const { width: screenW } = useWindowDimensions();
  const [profiles, setProfiles] = useState<PlayerProfile[]>([]);
  const [isLeftHanded, setIsLeftHanded] = useState<boolean | null>(null);
  const [coachName, setCoachName] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  // Stage view mode. Default 'overlay' (skeleton on the video frame). Only
  // meaningful when a video exists; the no-video path renders skeleton-only and
  // never shows the segmented control.
  const [viewMode, setViewMode] = useState<'video' | 'overlay' | 'skeleton'>('overlay');
  // Operator label mode — AUTHORITATIVE (P-101): saves regrade tempo/score
  // from the merged phases through the real pipeline seam (operatorRegrade.ts)
  // and dual-write row columns + swing_debug.operator_labels (sibling
  // top-level key; the merge RPC is a top-level shallow merge). The card
  // gains an Auto | Yours toggle when ≥1 label is saved; with no labels every
  // displayed value is byte-identical to the pre-P-101 screen.
  const [labelMode, setLabelMode] = useState(false);
  const [phaseLabels, setPhaseLabels] = useState<Record<string, number | undefined>>({});
  const [labelSaveStatus, setLabelSaveStatus] = useState<'ready' | 'saving' | 'saved'>('ready');
  const [labelSaveError, setLabelSaveError] = useState<string | null>(null);
  // Auto | Yours card view — defaults Yours; inert until corrections exist.
  const [cardView, setCardView] = useState<'auto' | 'yours'>('yours');
  // Label overlay collapse (video stays fully visible when collapsed) + the
  // post-save regrade readout shown at the bar (operator sees the result
  // without scrolling up to the card).
  const [labelBarCollapsed, setLabelBarCollapsed] = useState(false);
  const [lastSaveSummary, setLastSaveSummary] = useState<string | null>(null);
  // FIX 4c: a video-surface tap collapses the expanded overlay — but never
  // mid two-tap: the overlay reports its armed state into this ref.
  const labelArmedRef = useRef(false);
  const onLabelArmedChange = useCallback((armed: boolean) => {
    labelArmedRef.current = armed;
  }, []);
  const swingAddedRef = useRef(false);
  const [activeProfile, setActiveProfile] = useState<PlayerProfile | null>(null);

  // Swing-data resolution (live store vs history fetch vs reconstruction) —
  // see useSwingSource.ts. gripCloud also lives there (vanished feature, kept).
  const {
    isLiveSwing,
    effectiveMotion,
    swingRecord,
    recordLoaded,
    framesLoading,
    classification,
    analysis,
    partialReason,
    videoUri,
  } = useSwingSource(effectiveSwingId, isLeftHanded);

  // P-101 regrade view-model: corrections = Yours (merged operator+detected
  // phases through the pipeline seam), autoView = the ORIGINAL values (under
  // row-rewrite persistence the row — and thus the reconstructed analysis —
  // holds Yours after a save, so Auto must come from here, never the row).
  const { corrections, autoView, effectivePhases, savedLabelFrames, registerSavedLabels } =
    useFullSwingRegrade({
      swingRecord,
      analysis,
      frames: effectiveMotion?.frames,
      isLiveSwing,
    });

  // Seed the label bar from previously saved stamps so a re-save EXTENDS the
  // saved set instead of clobbering it (the RPC replaces the key, and under
  // row-rewrite a partial re-save would regrade from a partial set). One-shot;
  // never over stamps the operator has already placed this session.
  const labelsSeededRef = useRef(false);
  useEffect(() => {
    if (labelsSeededRef.current || !savedLabelFrames) return;
    labelsSeededRef.current = true;
    setPhaseLabels((prev) =>
      Object.values(prev).some((v) => v != null) ? prev : { ...savedLabelFrames },
    );
  }, [savedLabelFrames]);

  // The viewer-side effects below (session accumulator, insight persistence,
  // Today's Focus) must run ONLY for a LIVE just-captured swing — never when
  // opening one from history. isLiveSwing is the correct gate: it also
  // subsumes the coach case (a coach opening another account's swing is never
  // live), so the previous isOwnSwing/viewerUserId ownership check is gone.
  // Gating on ownership alone let your OWN history re-pollute Today's Focus /
  // session stats and re-write session_insight onto the old row.

  // Video/skeleton clock subsystem (player, signed-URL + one-retry, speed,
  // playhead, single seek path) — see useSwingVideoClock.ts.
  const videoStoragePath = swingRecord?.video_storage_path ?? null;
  const {
    player,
    effectiveVideoUri,
    isPlaying,
    isPlayerReady,
    videoIdx,
    speed,
    setSpeed,
    seekToFrame,
    beginScrub,
    scrubToFrame,
    endScrub,
  } = useSwingVideoClock({
    frames: effectiveMotion?.frames,
    videoUri,
    videoStoragePath,
    isLiveSwing,
  });

  // FIX 6a: label mode = PAUSED. Expanding the overlay halts playback
  // immediately; while expanded the center play button is not rendered and
  // every label-mode seek is {autoPlay:false}, so nothing can resume play.
  // Collapsing restores the normal controls.
  const labelOverlayExpanded = labelMode && !labelBarCollapsed;
  useEffect(() => {
    if (labelOverlayExpanded) player?.pause();
  }, [labelOverlayExpanded, player]);

  // Re-read on focus (not just mount) so a profile switched while this screen was
  // backgrounded is reflected when the viewer regains focus.
  useFocusEffect(
    useCallback(() => {
      getPrimaryProfile().then(setActiveProfile).catch((err) => console.error('[HoneySwing]', err));
      getProfiles().then(setProfiles).catch((err) => console.error('[HoneySwing]', err));
    }, []),
  );

  // Driven mode (video present): the skeleton canvas matches the video panel
  // exactly — same width (content column, container padding 24/side) and the
  // video's 9:16 aspect — so the identity transform in SwingSkeletonCanvas
  // frames the figure pixel-identically to the golfer in the video.
  const hasVideo = !!(effectiveVideoUri && player);
  const skeletonCanvasW = hasVideo ? screenW - 48 : screenW - 32;
  const skeletonCanvasH = hasVideo ? Math.round(((screenW - 48) * 16) / 9) : 380;

  // ── Operator label bar inputs (see label-mode state block above) ──────────
  // ALL 5 phases — the persisted operator_labels.detected snapshot must stay
  // 5-key (it is the history Auto-fallback source in useFullSwingRegrade).
  const fsAllPhaseEvents = useMemo(() => {
    const defs = [
      { key: 'takeaway', label: 'TA' },
      { key: 'top', label: 'TOP' },
      { key: 'downswing', label: 'DSW' },
      { key: 'impact', label: 'IMP' },
      { key: 'follow_through', label: 'FIN' },
    ];
    return defs.map((d) => {
      const p = analysis?.phases?.find((ph) => ph.phase === d.key);
      return {
        ...d,
        detectedFrame: typeof p?.index === 'number' ? p.index : null,
      };
    });
  }, [analysis]);
  // UI list: DSW excluded (device feedback — operators don't stamp it; the
  // detected downswing still fills the effective 5-set in the regrade).
  const fsLabelEvents = useMemo(
    () => fsAllPhaseEvents.filter((ev) => ev.key !== 'downswing'),
    [fsAllPhaseEvents],
  );
  const fsStampedCount = Object.values(phaseLabels).filter((v) => v != null).length;
  const fsSaveState =
    fsStampedCount === 0 || !effectiveSwingId
      ? ('disabled' as const)
      : labelSaveStatus === 'saving'
        ? ('saving' as const)
        : labelSaveStatus === 'saved'
          ? ('saved' as const)
          : ('ready' as const);

  const onSaveLabels = async () => {
    if (!effectiveSwingId || fsStampedCount === 0) return;
    setLabelSaveStatus('saving');
    setLabelSaveError(null);
    // msPerFrame from the actual frame timestamps (fps varies across eras) —
    // same derivation as useSwingVideoClock.
    const frames = effectiveMotion?.frames;
    const stepMs =
      frames && frames.length > 1
        ? (frames[frames.length - 1].timestampMs - frames[0].timestampMs) / (frames.length - 1)
        : null;
    const stamped: Record<string, number> = {};
    for (const [k, v] of Object.entries(phaseLabels)) {
      if (v != null) stamped[k] = v;
    }
    // Snapshot from ALL 5 phases (incl. DSW, absent from the UI list) — the
    // history Auto-fallback depends on the 5-key detected map.
    const detected: Record<string, number | null> = {};
    for (const ev of fsAllPhaseEvents) detected[ev.key] = ev.detectedFrame;

    // P-101 regrade from the exact payload being persisted — merged phases
    // through the real pipeline seam (tempo trust gates included).
    const regrade = regradeFromOperatorPhases({
      detectedPhases: analysis?.phases,
      operatorFrames: stamped,
      frames,
      stepMs,
    });
    // Device diagnostic (FIX 5): confirms regrade inputs/outputs on-device.
    console.log('[P-101 regrade]', {
      stamped,
      stepMs,
      frameCount: frames?.length ?? 0,
      tempo: regrade.tempo,
      score: regrade.score,
      overridden: regrade.overriddenPhases,
    });

    // 1) Row columns get the regraded (Yours) values — putting precedent.
    //    honey_boom included: reconstructAnalysisFromRecord reads it back, so
    //    a stale flag would desync from the rewritten score. NEVER touch
    //    swing_debug via .update() (wholesale overwrite).
    const { error: updateError } = await supabase
      .from('swings')
      .update({
        score: regrade.score,
        tempo_ratio: regrade.tempo?.tempoRatio ?? null,
        backswing_ms: regrade.tempo != null ? Math.round(regrade.tempo.backswingMs) : null,
        downswing_ms: regrade.tempo != null ? Math.round(regrade.tempo.downswingMs) : null,
        honey_boom: regrade.honeyBoom,
      })
      .eq('id', effectiveSwingId);
    // 2) Label record under the SIBLING top-level key.
    const { error: rpcError } = await supabase.rpc('merge_swing_debug', {
      swing_id: effectiveSwingId,
      patch: {
        operator_labels: {
          schema: 1,
          phases: stamped,
          detected,
          step_ms: stepMs,
          app_version: APP_VERSION,
          labeled_at_ms: Date.now(),
        },
      },
    });
    // Partial-failure honesty: ✓ only when BOTH landed; else surface a retry.
    if (updateError || rpcError) {
      setLabelSaveStatus('ready');
      setLabelSaveError(
        `save incomplete — ${updateError ? 'row update' : 'label record'} failed; tap to retry`,
      );
      return;
    }
    registerSavedLabels(stamped, stepMs);
    setCardView('yours');
    setLastSaveSummary(
      regrade.tempo != null
        ? `Yours: ${regrade.tempo.tempoRatio.toFixed(2)}:1 · ${regrade.score}`
        : 'Yours: tempo unavailable',
    );
    setLabelSaveStatus('saved');
  };

  // Score count-up. Animates from the currently displayed value to the target
  // (not from 0) so a retarget doesn't visibly reset, holds the last value
  // while the swing is still resolving (analysis null), and carries a watchdog
  // that snaps to the final score even if the rAF chain dies — a lost frame
  // callback used to freeze the number mid-count forever.
  const finalScore = analysis?.score ?? 0;
  const hasAnalysis = analysis !== null;
  // Withheld score (analysis resolved but score is null — e.g. tempo missing,
  // scoring.ts returns score:null) must render as "—", never a literal 0 that
  // reads as a real failing grade.
  const scoreWithheld = hasAnalysis && analysis?.score == null;
  const [displayedScore, setDisplayedScore] = useState(0);
  const displayedScoreRef = useRef(0);
  const finalScoreRef = useRef(finalScore);
  finalScoreRef.current = finalScore;
  useEffect(() => {
    if (!hasAnalysis) return; // swing still resolving — hold the last value
    if (finalScore <= 0) {
      // Genuinely zero/failed score — must show 0, never a stale number.
      displayedScoreRef.current = 0;
      setDisplayedScore(0);
      return;
    }
    const from = displayedScoreRef.current;
    if (from === finalScore) return;
    let raf: number;
    const start = Date.now();
    const tick = () => {
      const p = Math.min(1, (Date.now() - start) / 800);
      const value = Math.round(from + (finalScore - from) * (1 - Math.pow(1 - p, 3)));
      displayedScoreRef.current = value;
      setDisplayedScore(value);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const watchdog = setTimeout(() => {
      displayedScoreRef.current = finalScore;
      setDisplayedScore(finalScore);
    }, 850);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(watchdog);
    };
  }, [finalScore, hasAnalysis]);

  const scrollRef = useRef<ScrollView>(null);
  const [videoSectionY, setVideoSectionY] = useState<number | null>(null);
  // Auto-scroll to the video (product behavior since the redesign), tamed:
  // one-shot (layout shifts don't re-arm a second scroll), never hijacks a
  // user who already scrolled, and skipped while the count-up hasn't settled
  // so it can't take a still-counting score off-screen.
  const autoScrolledRef = useRef(false);
  const userScrolledRef = useRef(false);
  useEffect(() => {
    if (videoSectionY == null || autoScrolledRef.current) return;
    const t = setTimeout(() => {
      if (autoScrolledRef.current || userScrolledRef.current) return;
      if (displayedScoreRef.current !== finalScoreRef.current) return;
      autoScrolledRef.current = true;
      scrollRef.current?.scrollTo({ y: videoSectionY, animated: true });
    }, 2000);
    return () => clearTimeout(t);
  }, [videoSectionY]);

  // Re-read on focus so the skeleton orientation reflects the ACTIVE profile's
  // handedness after a profile switch (was once-only on mount → stale skeleton).
  useFocusEffect(
    useCallback(() => {
      getActiveProfileHandedness().then(setIsLeftHanded).catch((err) => console.error('[HoneySwing]', err));
      getCoachCode().then(setCoachName).catch((err) => console.error('[HoneySwing]', err));

      // Check swing limit after this swing was persisted
      checkSwingLimit().then((status) => {
        if (!status.allowed) {
          getUser().then((user) => {
            if (!user) setLimitHit(true);
          }).catch((err) => console.error('[HoneySwing]', err));
        }
      }).catch((err) => console.error('[HoneySwing]', err));
    }, []),
  );

  useEffect(() => {
    const reason = swingRecord?.failure_reason;
    if (reason && NO_DATA_FAILURE_REASONS.has(reason)) {
      router.replace({
        pathname: '/analysis/no-swing',
        params: { reason, swingId: swingRecord.id },
      } as Href);
    }
  }, [swingRecord, router]);

  const angles = analysis?.angles;
  const tempo = analysis?.tempo;
  const firstFrameTimestamp = effectiveMotion?.frames?.[0]?.timestampMs;

  // P-101 card view selection: with saved corrections BOTH sides come from
  // the regrade hook — the row-reconstructed analysis may already hold the
  // Yours values (row-rewrite persistence), so it must never back the Auto
  // side. With no corrections the pre-P-101 expressions apply unchanged.
  // (autoView is non-null whenever corrections is; ?? corrections is a type
  // guard, not a reachable fallback.)
  const showYours = cardView === 'yours' && corrections != null;
  const selectedView =
    corrections == null ? null : showYours ? corrections : (autoView ?? corrections);
  const cardTempo = selectedView ? selectedView.tempo : tempo;
  // P-102: display surfaces (phase chips, skeleton chip row, Swing Art) follow
  // the card toggle — effective (operator-merged) phases under Yours, detected
  // otherwise; no labels ⇒ identical to analysis.phases. The label bar's Auto
  // references and the save-time regrade input deliberately KEEP reading
  // analysis.phases (they must show/consume app-detected frames).
  const displayPhases =
    showYours && effectivePhases ? effectivePhases : (analysis?.phases ?? null);

  const { scoreColor, tempoLabelText, coachingCueText } = deriveTempoDisplay(cardTempo);

  // Task 7: frequency-limited coaching tips + Task 8: positive reinforcement
  const { processedTips, positiveResult } = useMemo<{
    processedTips: ProcessedCoachingTip[];
    positiveResult: ProcessSwingResult;
  }>(() => {
    if (!analysis) return { processedTips: [], positiveResult: { card: null, improvements: [] } };
    const breakdown = analysis.swing_debug?.scoring_breakdown;
    if (!breakdown) return { processedTips: [], positiveResult: { card: null, improvements: [] } };
    const rawTips = buildRawTips(breakdown);
    const estimatedAngleDeg = analysis.swing_debug?.foreshortening?.estimatedAngleDegrees ?? null;
    const tips = processSwingTips(
      rawTips,
      shouldShowMetric,
      analysis.swingConfidence,
      analysis.cameraAngleResult,
      estimatedAngleDeg,
    );

    // Deduped metric scores (same metricKey mapping as buildRawTips, keep worst
    // score) — array order is load-bearing, see dedupeWorstMetricScores.
    const dedupedScores = dedupeWorstMetricScores(breakdown);

    const swingConfidence = analysis.swingConfidence ?? { tier: 'low' as const, overall: 0 };
    const posResult = positiveReinforcementEngine.processSwing(
      { tier: swingConfidence.tier, overall: swingConfidence.overall },
      dedupedScores,
      tips.length,
    );
    if (posResult.card) {
      console.log('[positiveReinforcement]', posResult.card);
    }

    return { processedTips: tips, positiveResult: posResult };
  }, [analysis]);

  // Task 14: Session accumulator — feed swing data once per swing.
  // isLiveSwing: only a live capture feeds session stats; a history view
  // (even your own) must not re-inflate the accumulator.
  useEffect(() => {
    if (!analysis || !isLiveSwing || swingAddedRef.current) return;
    swingAddedRef.current = true;
    const firedMetricKeys = processedTips.map(t => t.metricKey);
    sessionAccumulator.addSwing(analysis, firedMetricKeys);
  }, [analysis, processedTips, isLiveSwing]);

  const sessionInsight = useMemo<SessionInsight | null>(() => {
    if (!analysis) return null;

    // Only show session insight if no high-priority correction tip
    const hasHighPriorityTip = processedTips.length > 0 &&
      (analysis.swingConfidence?.overall ?? 0) >= 0.75;
    if (hasHighPriorityTip) return null;

    const insight = sessionAccumulator.getInsight();
    if (insight) {
      console.log('[sessionInsight]', insight.type, insight.metricKey, insight.message);
    }
    return insight;
  }, [analysis, processedTips]);

  // Persist session insight to the swing row (atomic JSONB merge — no read-modify-write race).
  // isLiveSwing: only write onto the row we just captured. Opening a history
  // swing must never re-stamp session_insight_shown onto an old row (the
  // insight derives from the current live session, not that swing).
  useEffect(() => {
    if (!effectiveSwingId || !sessionInsight || !isLiveSwing) return;
    supabase
      .rpc('merge_swing_debug', {
        swing_id: effectiveSwingId,
        patch: { session_insight_shown: sessionInsight.message },
      })
      .then(({ error }) => {
        if (error) {
          console.error('[HoneySwing] session_insight_shown update error:', error.message);
        }
      });
  }, [effectiveSwingId, sessionInsight, isLiveSwing]);

  // Metro log for verification before tip UI exists
  useEffect(() => {
    if (processedTips.length > 0) {
      console.log('[tipFrequency]', processedTips.map(t => `${t.metricKey}:${t.decision.tier}`));
    }
  }, [processedTips]);

  // Persist the weakest metric as "Today's Focus" for the home screen.
  // isLiveSwing: Today's Focus reflects the latest LIVE swing only — opening
  // history (yours or a kid's) must not overwrite it with a stale swing.
  useEffect(() => {
    if (!angles || !isLiveSwing) return;
    const focus = computeFocus(angles, getCachedAgeTier(), Date.now());
    if (focus) saveFocus(focus).catch((err) => console.error('[HoneySwing]', err));
  }, [angles, isLiveSwing]);

  // Header identity: the viewed swing's OWN attribution governs (not the current
  // primary). Live swing belongs to the current primary, so its pre-load fallback
  // is activeProfile; the history path must not flash another kid's name pre-load.
  const headerProfile = resolveHeaderProfile(
    swingRecord,
    profiles,
    isLiveSwing ? activeProfile : null,
    recordLoaded,
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* 1. Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          activeOpacity={0.7}
        >
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {headerProfile?.name ? `${headerProfile.name}'s Swing` : 'Your Swing'}
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.container}
        onScrollBeginDrag={() => { userScrolledRef.current = true; }}
      >
        {!effectiveMotion && !analysis ? (
          framesLoading ? (
            <ActivityIndicator color={GOLD} style={{ marginTop: 40 }} />
          ) : (
            <Text style={styles.emptyText}>No swing data available yet.</Text>
          )
        ) : classification?.validity === 'invalid' ? (
          <View style={styles.invalidContainer}>
            <Text style={styles.invalidTitle}>Couldn&apos;t clearly capture your swing</Text>
            <Text style={styles.invalidHint}>
              Make sure your full body is in frame and try again
            </Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => router.back()}
              activeOpacity={0.7}
            >
              <Text style={styles.primaryButtonText}>Record Again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {partialReason && (
              <View style={styles.partialBanner}>
                <Text style={styles.partialBannerTitle}>
                  We couldn&apos;t fully read this swing — score is approximate.
                </Text>
                <Text style={styles.partialBannerSub}>Reason: {partialReason}</Text>
              </View>
            )}
            {/* 1. Score (Auto = original; Yours = operator regrade) */}
            <View style={styles.scoreCard}>
              {corrections != null && (
                <View style={styles.viewToggleRow}>
                  {(['auto', 'yours'] as const).map((v) => (
                    <TouchableOpacity
                      key={v}
                      style={[styles.viewToggle, cardView === v && styles.viewToggleActive]}
                      onPress={() => setCardView(v)}
                      activeOpacity={0.7}
                    >
                      <Text
                        style={[
                          styles.viewToggleText,
                          cardView === v && styles.viewToggleTextActive,
                        ]}
                      >
                        {v === 'auto' ? 'Auto' : 'Yours'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              <Text style={[styles.score, { color: scoreColor }]}>
                {selectedView
                  ? (selectedView.score ?? '—')
                  : scoreWithheld
                    ? '—'
                    : displayedScore}
              </Text>
              {tempoLabelText && (
                <Text style={[styles.tempoVerdict, { color: scoreColor }]}>
                  {tempoLabelText}
                </Text>
              )}
              {coachingCueText && (
                <Text style={styles.coachingCue}>{coachingCueText}</Text>
              )}
              {cardTempo && (
                <Text style={styles.tempoRatio}>
                  {cardTempo.tempoRatio.toFixed(2)}:1
                </Text>
              )}
              {cardTempo && (
                <View style={styles.timingRow}>
                  <Text style={styles.timingItem}>Back {Math.round(cardTempo.backswingMs)}ms</Text>
                  <Text style={styles.timingItem}>Down {Math.round(cardTempo.downswingMs)}ms</Text>
                </View>
              )}
              {/* Corrections-gated only — the no-label withheld case keeps
                  today's bare em-dash (byte-identity). */}
              {selectedView && !cardTempo && (
                <Text style={styles.tempoUnavailableText}>Tempo unavailable</Text>
              )}
            </View>

            {/* 2. Stage: Video / Overlay / Skeleton */}
            {effectiveMotion?.frames?.length ? (
              hasVideo ? (
                <>
                  {/* Control bar — segmented control (left) + speed chips
                      (right). Video-backed swings only; the speed chips are the
                      transport for the shared video clock that also drives the
                      skeleton in Overlay/Skeleton modes. */}
                  <View style={styles.controlBar}>
                    <View style={styles.segmentedControl}>
                      {([
                        { mode: 'video', label: 'Video' },
                        { mode: 'overlay', label: 'Overlay' },
                        { mode: 'skeleton', label: 'Skeleton' },
                      ] as const).map(({ mode, label }) => (
                        <TouchableOpacity
                          key={mode}
                          style={[styles.segment, viewMode === mode && styles.segmentActive]}
                          onPress={() => setViewMode(mode)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.segmentText, viewMode === mode && styles.segmentTextActive]}>
                            {label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    <View style={[styles.segmentedControl, { alignSelf: 'stretch' }]}>
                      {([0.25, 0.5, 1] as const).map((s) => (
                        <TouchableOpacity
                          key={s}
                          style={[styles.segment, { flex: 1, alignItems: 'center' }, speed === s && styles.segmentActive]}
                          onPress={() => setSpeed(s)}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.segmentText, speed === s && styles.segmentTextActive]}>
                            {s}x
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>

                  <View
                    style={styles.videoSection}
                    onLayout={(e) => setVideoSectionY(e.nativeEvent.layout.y)}
                  >
                    {/* Video stays mounted in ALL modes — unmounting would
                        pause the player / stop timeUpdate and freeze the driven
                        skeleton. Skeleton mode just hides it behind a dark
                        backdrop (opacity 0 + opaque cover). */}
                    <View style={[styles.stage, { width: skeletonCanvasW, height: skeletonCanvasH }]}>
                      <VideoView
                        player={player}
                        style={[styles.videoPlayer, viewMode === 'skeleton' && { opacity: 0 }]}
                        nativeControls={false}
                      />
                      {viewMode === 'skeleton' && (
                        <View style={[StyleSheet.absoluteFill, styles.skeletonBackdrop]} />
                      )}
                      {viewMode !== 'video' && (
                        <View style={StyleSheet.absoluteFill} pointerEvents="none">
                          <SwingSkeletonCanvas
                            frames={effectiveMotion.frames}
                            phases={displayPhases}
                            width={skeletonCanvasW}
                            height={skeletonCanvasH}
                            // Driven by the video clock; videoIdx ?? 0 until the
                            // first timeUpdate. No onPhaseSeek → canvas hides its
                            // own chip row; the phase chips below are the single
                            // chip surface.
                            playheadIdx={videoIdx ?? 0}
                            overlay
                          />
                        </View>
                      )}
                      {/* FIX 4c: a video-surface tap collapses the expanded
                          overlay. Placed BEFORE the play button so play stays
                          tappable (later siblings win); an armed two-tap flow
                          is never interrupted (ref guard). */}
                      {labelOverlayExpanded && effectiveMotion && (
                        <Pressable
                          style={StyleSheet.absoluteFill}
                          onPress={() => {
                            if (!labelArmedRef.current) setLabelBarCollapsed(true);
                          }}
                        />
                      )}
                      {/* FIX 6a: no play control while the label overlay is
                          expanded — label mode is hard-paused. */}
                      {!isPlaying && !labelOverlayExpanded && (
                        <TouchableOpacity
                          style={styles.videoPlayButton}
                          onPress={() => player.play()}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.videoPlayButtonIcon}>▶</Text>
                        </TouchableOpacity>
                      )}
                      {/* Operator label overlay (FIX 4b/4c): edge layout — top
                          strip (frame counter + collapse), −5/−1 and +1/+5
                          rails on the side edges, phase chips in one line at
                          the bottom; the subject is center-frame and stays
                          visible. Delta/Reset/Save/readout render BELOW the
                          stage (LabelControlsBelow). The blue tab is the ONLY
                          label-mode control (replaces the old "Label frames"
                          button): tap → expand; Label ▾ / video tap →
                          collapse (labelMode stays armed). */}
                      {effectiveMotion &&
                        (labelOverlayExpanded ? (
                          <VideoLabelOverlay
                            events={fsLabelEvents}
                            frameCount={effectiveMotion.frames.length}
                            videoIdx={videoIdx ?? 0}
                            seekToFrame={seekToFrame}
                            // FIX 6c: scrubber segments follow Auto | Yours
                            // via the shared displayPhases selector (P-102).
                            phases={displayPhases}
                            scrubBegin={beginScrub}
                            scrubUpdate={scrubToFrame}
                            scrubEnd={endScrub}
                            labels={phaseLabels}
                            onStamp={(key, frame) => {
                              setPhaseLabels((prev) => ({ ...prev, [key]: frame }));
                              setLabelSaveStatus('ready');
                              setLabelSaveError(null);
                              setLastSaveSummary(null);
                            }}
                            onCollapse={() => setLabelBarCollapsed(true)}
                            onArmedChange={onLabelArmedChange}
                          />
                        ) : (
                          <TouchableOpacity
                            style={styles.labelOverlayTab}
                            onPress={() => {
                              setLabelMode(true);
                              setLabelBarCollapsed(false);
                            }}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.labelOverlayTabText}>Label ▴</Text>
                          </TouchableOpacity>
                        ))}
                    </View>
                  </View>
                  {/* FIX 4b: off-video label controls — delta summary, Reset,
                      Save, save-error and the post-save regrade readout.
                      Hidden while the overlay is collapsed (collapse hides
                      everything, matching v1 semantics). */}
                  {labelOverlayExpanded && effectiveMotion && (
                    <LabelControlsBelow
                      events={fsLabelEvents}
                      labels={phaseLabels}
                      seekToFrame={seekToFrame}
                      onResetLabels={() => {
                        setPhaseLabels({});
                        setLabelSaveStatus('ready');
                        setLabelSaveError(null);
                        setLastSaveSummary(null);
                      }}
                      onSave={() => void onSaveLabels()}
                      saveButtonLabel="Save Labels"
                      saveState={fsSaveState}
                      saveDisabledReason={
                        fsStampedCount === 0
                          ? 'stamp at least one phase to save'
                          : !effectiveSwingId
                            ? 'swing not persisted yet'
                            : undefined
                      }
                      saveSummary={lastSaveSummary}
                      saveError={labelSaveError}
                    />
                  )}
                </>
              ) : (
                // No video → skeleton-only, self-clocked replay (existing
                // behavior). No segmented control.
                <SwingSkeletonCanvas
                  frames={effectiveMotion.frames}
                  phases={displayPhases}
                  width={skeletonCanvasW}
                  height={skeletonCanvasH}
                  playheadIdx={null}
                  onPhaseSeek={(_phase, index) => seekToFrame(index, { autoPlay: false })}
                />
              )
            ) : null}

            {/* 3. Phase chips — video mode only. In no-video mode the
                self-clocked SwingSkeletonCanvas renders its OWN tappable chip
                row (onPhaseSeek), so this row would duplicate it, permanently
                disabled (every chip needs player+video to enable). */}
            {hasVideo && (
            <View style={styles.phaseChipsRow}>
              {PHASE_CHIPS.map((entry) => {
                if (entry.phase === 'full_swing') {
                  const enabled = !!player && !!effectiveVideoUri && isPlayerReady;
                  return (
                    <TouchableOpacity
                      key={entry.phase}
                      style={enabled ? styles.phaseChip : styles.phaseChipDisabled}
                      disabled={!enabled}
                      onPress={
                        enabled
                          ? () => seekToFrame(0, { autoPlay: false })
                          : undefined
                      }
                      activeOpacity={0.7}
                    >
                      <Text
                        style={enabled ? styles.phaseChipLabel : styles.phaseChipLabelDisabled}
                        numberOfLines={1}
                      >
                        {entry.label}
                      </Text>
                    </TouchableOpacity>
                  );
                }
                const phaseEntry = displayPhases?.find((p) => p.phase === entry.phase);
                const enabled =
                  !!phaseEntry && !!player && !!effectiveVideoUri && isPlayerReady && firstFrameTimestamp != null;
                return (
                  <TouchableOpacity
                    key={entry.phase}
                    style={enabled ? styles.phaseChip : styles.phaseChipDisabled}
                    disabled={!enabled}
                    onPress={
                      enabled
                        ? () => {
                            if (typeof phaseEntry.index !== 'number') return;
                            seekToFrame(phaseEntry.index, { autoPlay: false });
                          }
                        : undefined
                    }
                    activeOpacity={0.7}
                  >
                    <Text
                      style={enabled ? styles.phaseChipLabel : styles.phaseChipLabelDisabled}
                      numberOfLines={1}
                    >
                      {entry.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            )}

            {/* 3b. Operator label mode — AUTHORITATIVE (P-101): saves regrade
                tempo/score through operatorRegrade.ts and dual-write the row
                columns + swing_debug.operator_labels; the card gains the
                Auto | Yours toggle. Entry point is the on-video [Label ▴] tab
                (FIX 4c) — no below-chips button. Video mode only. */}

            {/* 4. Swing Art */}
            {classification?.validity === 'valid' && effectiveMotion && (
              <View style={{ marginTop: 8 }}>
                <SwingArtCard
                  frames={effectiveMotion.frames}
                  // FIX 3 + P-102: art shares the toggle-following selector
                  // with the phase chips / skeleton chip row.
                  phases={displayPhases ?? []}
                  width={screenW - 48}
                />
              </View>
            )}

            {/* 5. CTA */}
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => router.back()}
              activeOpacity={0.7}
            >
              <Text style={styles.primaryButtonText}>Record Again</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
