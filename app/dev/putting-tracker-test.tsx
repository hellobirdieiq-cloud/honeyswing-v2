import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { VideoView } from 'expo-video';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter } from 'expo-router';
import { useSwingVideoClock } from '@/app/analysis/useSwingVideoClock';
import SwingSkeletonCanvas from '@/components/SwingSkeletonCanvas';
import PuttingShaftOverlay from '@/components/PuttingShaftOverlay';
import type { PoseFrame } from '@/packages/pose/PoseTypes';
import { supabase } from '@/lib/supabase';
import { getSwingVideoSignedUrl } from '@/lib/getSwingVideoUrl';
import { CAPTURE_FPS, ANALYZER_DECIMATION } from '@/lib/cameraFormat';
import {
  trackPuttingObjects,
  refinePutterHead,
  type PuttingBallSeed,
  type PuttingTrackResult,
  type PuttingObjectFrame,
  type PuttingRefinedPoint,
} from '@/modules/vision-camera-pose/src';
import { runPuttingDetectors } from '@/packages/domain/putting/runPuttingDetectors';
import {
  buildPosePriors,
  POSE_SHAFT_CAL_OFFSET_DEG,
  POSE_PRIOR_MIN_CONF,
  type MotionFrameLite,
} from '@/packages/domain/putting/buildPosePriors';
import { smoothShaftSeries } from '@/packages/domain/putting/smoothShaftSeries';
import { computeRefineWindow } from '@/packages/domain/putting/detectFineTakeaway';
import { applyFineTakeaway } from '@/packages/domain/putting/applyFineTakeaway';
import type {
  PuttingDetectorsResult,
  ShaftFitSample,
  SmoothedShaftFrame,
} from '@/packages/domain/putting/types';

/**
 * Putting CV go/no-go gate (Phase 1) — dev-only eyeball harness.
 *
 * Reachable ONLY by direct route (router.push('/dev/putting-tracker-test') or
 * uri-scheme). Deliberately NOT linked from any tab, button, or screen.
 *
 * Downloads a swing's clip from the swing-videos bucket, runs the native
 * putting tracker on the SAME 8.33ms timestamp grid as pose extraction, then
 * computes the gate metrics and exports <swingId>.json + <swingId>-overlay.mov
 * + <swingId>-raw.mov (untouched full-res source — the overlay is 480w;
 * CLEAN mode (default) writes raw decoded frames with nothing drawn,
 * ANNOTATED burns in the debug markers) via the share sheet (manually copied
 * into docs/putting-cv-test/).
 *
 * The rest/stroke windows below are METRIC REPORTING ONLY — this is not phase
 * detection, and putting must NEVER fall back to the wrist/pose phase detector.
 *
 * Phase A1: after tracking, the pure putting tempo detectors
 * (packages/domain/putting) run over the pose priors + ball series and their
 * result is shown as chips and embedded in the export JSON (schema_version 2,
 * additive `putting_detectors` field). Display + export only — nothing
 * persists to the DB.
 */

const DEFAULT_SWING_ID = '1d8722b8-618b-4668-baf8-2a90c5aab748';

// Pre-filled ball seed for the current multi-ball fixture clip ("middle
// ball"). Clearing both inputs runs the tracker unseeded.
const DEFAULT_SEED_X = '0.55';
const DEFAULT_SEED_Y = '0.80';

/**
 * Both fields empty → undefined (no seed sent, unseeded tracker). Both valid
 * numbers in 0-1 → seed. Anything else (one empty, NaN, out of range) throws
 * so a typo can't silently fall back to unseeded mode.
 */
function parseBallSeed(xText: string, yText: string): PuttingBallSeed | undefined {
  const xt = xText.trim();
  const yt = yText.trim();
  if (xt === '' && yt === '') return undefined;
  const x = Number(xt);
  const y = Number(yt);
  if (
    xt === '' ||
    yt === '' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1 ||
    y < 0 ||
    y > 1
  ) {
    throw new Error('seed x/y must both be numbers in 0–1 (or both empty for no seed)');
  }
  return { x, y };
}

// EXTERNAL ASSUMPTION — sustained ball movement threshold: a ball detection
// deviating more than this (full-res px) from the running rest centroid, for
// >= BALL_MOVE_SUSTAIN_FRAMES consecutive detected frames, ends the rest
// window. Bumped 4→8: fixture 1d8722b8's rest jitter band reaches ~7px
// full-res while the real launch moves ~43px/frame — 8 stays far below launch.
const BALL_MOVE_EPS_PX = 8;
const BALL_MOVE_SUSTAIN_FRAMES = 2;

// EXTERNAL ASSUMPTION — head motion threshold for the stroke window: the
// stroke spans first→last frame whose consecutive-frame head displacement
// exceeds this (full-res px per grid frame). Bumped 2→4 alongside the ball
// epsilon (same fixture 1d8722b8 observation: detection noise clears 2px).
const HEAD_MOTION_EPS_PX = 4;

// EXTERNAL ASSUMPTION — mirrors the plugin's BALL_REST_SAMPLE_FRAMES: movement
// starting inside this many grid frames means the ball was never at rest
// (pre-moving decoy) → rest_window "none", rest metrics skipped.
const REST_ANCHOR_SAMPLE_FRAMES = 24;

// Pose-prior building moved VERBATIM to packages/domain/putting/buildPosePriors.ts
// (Phase C dedupe — the live putt pipeline shares it). Constants
// POSE_SHAFT_CAL_OFFSET_DEG / POSE_PRIOR_MIN_CONF live there now.

type GateMetrics = {
  rest_window: { startIdx: number; endIdx: number } | 'none';
  stroke_window: { startIdx: number; endIdx: number } | 'none';
  ball_found_rate_rest: number | null;
  rest_ball_jitter_px: number | null;
  head_found_rate_stroke: number | null;
  ball_found_rate_overall: number;
  head_found_rate_overall: number;
  ball_null_gaps: number[];
  head_null_gaps: number[];
  ball_vision_frames: number;
  head_vision_frames: number;
  frame_count: number;
  track_wall_ms: number;
};

function nullGaps(frames: PuttingObjectFrame[], key: 'ball' | 'head'): number[] {
  const gaps: number[] = [];
  let run = 0;
  for (const f of frames) {
    if (f[key] === null) {
      run += 1;
    } else if (run > 0) {
      gaps.push(run);
      run = 0;
    }
  }
  if (run > 0) gaps.push(run);
  return gaps;
}

/**
 * Rest window = frames before the first sustained ball movement. The rest
 * centroid is the running mean of ball detections accepted as "at rest" so
 * far; movement = BALL_MOVE_SUSTAIN_FRAMES consecutive detections deviating
 * > BALL_MOVE_EPS_PX from it. Returns the frame index where movement starts,
 * or null if the ball never moves (no-stroke / waggle decoys).
 */
function findBallMovementStart(frames: PuttingObjectFrame[]): number | null {
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  let deviating: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const ball = frames[i].ball;
    if (!ball) continue;
    if (n === 0) {
      sumX = ball.x;
      sumY = ball.y;
      n = 1;
      continue;
    }
    const dx = ball.x - sumX / n;
    const dy = ball.y - sumY / n;
    if (Math.sqrt(dx * dx + dy * dy) > BALL_MOVE_EPS_PX) {
      deviating.push(i);
      if (deviating.length >= BALL_MOVE_SUSTAIN_FRAMES) {
        return deviating[0];
      }
    } else {
      deviating = [];
      sumX += ball.x;
      sumY += ball.y;
      n += 1;
    }
  }
  return null;
}

function findStrokeWindow(
  frames: PuttingObjectFrame[],
): { startIdx: number; endIdx: number } | 'none' {
  let start: number | null = null;
  let end: number | null = null;
  let prev: { x: number; y: number; idx: number } | null = null;
  for (let i = 0; i < frames.length; i++) {
    const head = frames[i].head;
    if (!head) continue;
    if (prev && i === prev.idx + 1) {
      const d = Math.hypot(head.x - prev.x, head.y - prev.y);
      if (d > HEAD_MOTION_EPS_PX) {
        if (start === null) start = prev.idx;
        end = i;
      }
    }
    prev = { x: head.x, y: head.y, idx: i };
  }
  return start !== null && end !== null ? { startIdx: start, endIdx: end } : 'none';
}

function computeMetrics(result: PuttingTrackResult, trackWallMs: number): GateMetrics {
  const frames = result.frames;
  const total = frames.length;
  const ballFound = frames.filter((f) => f.ball !== null).length;
  const headFound = frames.filter((f) => f.head !== null).length;

  const movementStart = findBallMovementStart(frames);
  // Pre-moving-ball decoy: movement inside the anchor window means the ball
  // was never at rest — report rest_window "none" and skip rest metrics.
  const restIsNone = movementStart !== null && movementStart < REST_ANCHOR_SAMPLE_FRAMES;
  const restEnd = movementStart === null ? total : movementStart;

  let restWindow: GateMetrics['rest_window'] = 'none';
  let ballFoundRateRest: number | null = null;
  let restJitter: number | null = null;
  if (!restIsNone && restEnd > 0) {
    restWindow = { startIdx: 0, endIdx: restEnd - 1 };
    const restFrames = frames.slice(0, restEnd);
    const restBalls = restFrames.filter((f) => f.ball !== null).map((f) => f.ball!);
    ballFoundRateRest = restBalls.length / restFrames.length;
    if (restBalls.length > 1) {
      const mx = restBalls.reduce((a, b) => a + b.x, 0) / restBalls.length;
      const my = restBalls.reduce((a, b) => a + b.y, 0) / restBalls.length;
      const meanSq =
        restBalls.reduce((a, b) => a + (b.x - mx) ** 2 + (b.y - my) ** 2, 0) / restBalls.length;
      restJitter = Math.sqrt(meanSq);
    }
  }

  const strokeWindow = findStrokeWindow(frames);
  let headFoundRateStroke: number | null = null;
  if (strokeWindow !== 'none') {
    const strokeFrames = frames.slice(strokeWindow.startIdx, strokeWindow.endIdx + 1);
    headFoundRateStroke =
      strokeFrames.filter((f) => f.head !== null).length / strokeFrames.length;
  }

  return {
    rest_window: restWindow,
    stroke_window: strokeWindow,
    ball_found_rate_rest: ballFoundRateRest,
    rest_ball_jitter_px: restJitter,
    head_found_rate_stroke: headFoundRateStroke,
    ball_found_rate_overall: total > 0 ? ballFound / total : 0,
    head_found_rate_overall: total > 0 ? headFound / total : 0,
    ball_null_gaps: nullGaps(frames, 'ball'),
    head_null_gaps: nullGaps(frames, 'head'),
    ball_vision_frames: frames.filter((f) => f.ball?.source === 'vision').length,
    head_vision_frames: frames.filter((f) => f.head?.source === 'vision').length,
    frame_count: total,
    track_wall_ms: trackWallMs,
  };
}

function pct(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

export default function PuttingTrackerTestScreen(): React.ReactElement {
  const router = useRouter();
  const [swingId, setSwingId] = useState(DEFAULT_SWING_ID);
  const [seedXText, setSeedXText] = useState(DEFAULT_SEED_X);
  const [seedYText, setSeedYText] = useState(DEFAULT_SEED_Y);
  const [headDetector, setHeadDetector] = useState<'shaft' | 'blob' | 'bar'>('bar');
  const [overlayMode, setOverlayMode] = useState<'clean' | 'annotated'>('clean');
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<GateMetrics | null>(null);
  const [detectors, setDetectors] = useState<PuttingDetectorsResult | null>(null);
  const [roiAnchor, setRoiAnchor] = useState<string | null>(null);
  // Phase B playback stage (D5 Path 1 — playback-time render; baked export
  // deferred to roadmap #96). Populated by a bar-mode run.
  const [localVideoUri, setLocalVideoUri] = useState<string | null>(null);
  const [playbackFrames, setPlaybackFrames] = useState<PoseFrame[] | null>(null);
  const [playbackSmoothed, setPlaybackSmoothed] = useState<SmoothedShaftFrame[] | null>(null);
  const [playbackShaftLen, setPlaybackShaftLen] = useState<number | null>(null);
  const [playbackAnalysisW, setPlaybackAnalysisW] = useState<number>(480);
  const [showShaft, setShowShaft] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(true);

  // Local-file branch of the clock, verified: videoUri non-null wins at
  // useSwingVideoClock.ts:50; the signed-URL resolve (:173) and remote retry
  // (:93) effects both early-return — no Supabase machinery on this path.
  const clock = useSwingVideoClock({
    frames: playbackFrames ?? undefined,
    videoUri: localVideoUri,
    videoStoragePath: null,
    isLiveSwing: true,
  });
  const [jsonPath, setJsonPath] = useState<string | null>(null);
  const [overlayPath, setOverlayPath] = useState<string | null>(null);
  const [rawPath, setRawPath] = useState<string | null>(null);

  const log = useCallback((line: string) => {
    setStatus((prev) => [...prev, line]);
  }, []);

  const onRun = useCallback(async () => {
    const id = swingId.trim();
    setPhase('running');
    setStatus([]);
    setError(null);
    setMetrics(null);
    setDetectors(null);
    setRoiAnchor(null);
    setLocalVideoUri(null);
    setPlaybackFrames(null);
    setPlaybackSmoothed(null);
    setPlaybackShaftLen(null);
    setJsonPath(null);
    setOverlayPath(null);
    setRawPath(null);
    try {
      const ballSeed = parseBallSeed(seedXText, seedYText);
      log(ballSeed ? `ball seed (${ballSeed.x}, ${ballSeed.y})` : 'no ball seed (unseeded)');

      log('fetching swings row…');
      const { data, error: rowErr } = await supabase
        .from('swings')
        .select('video_storage_path, motion_frames')
        .eq('id', id)
        .single();
      if (rowErr || !data?.video_storage_path) {
        throw new Error(`row fetch failed: ${rowErr?.message ?? 'no video_storage_path'}`);
      }

      // Pose priors from motion_frames (1:1 with the video grid). Missing
      // motion_frames → empty array → every frame falls back to pure CV.
      const motionFrames = (data.motion_frames ?? []) as unknown as MotionFrameLite[];
      const posePriors = buildPosePriors(motionFrames);
      const priorCount = posePriors.filter((p) => p !== null).length;
      log(`pose priors: ${priorCount}/${posePriors.length} frames usable`);

      log('signing storage URL…');
      const signedUrl = await getSwingVideoSignedUrl(data.video_storage_path);
      if (!signedUrl) throw new Error('createSignedUrl failed (see console)');

      log('downloading clip…');
      const localUri = `${FileSystem.cacheDirectory}putting-cv-${id}.mov`;
      const download = await FileSystem.downloadAsync(signedUrl, localUri);
      if (download.status !== 200) throw new Error(`download HTTP ${download.status}`);
      // Playback stage inputs: local clip + skeleton frames (motion_frames
      // rows ARE PoseFrame[] shape — swingStore.ts read-path assumption).
      setLocalVideoUri(download.uri);
      setPlaybackFrames(motionFrames as unknown as PoseFrame[]);

      // Same grid step as pose extraction (lib/extractPoseFromVideo.ts:75).
      const stepMs = ANALYZER_DECIMATION * (1000 / CAPTURE_FPS);
      log(`tracking (stepMs=${stepMs.toFixed(2)})…`);
      const t0 = Date.now();
      const result = await trackPuttingObjects(download.uri, stepMs, {
        writeOverlay: true,
        overlayMode, // 'clean' = raw frames, nothing drawn; 'annotated' = debug markers
        debugCandidates: true, // dev harness: always dump per-frame diagnostics
        headDetector,
        posePriors,
        ...(ballSeed ? { ballSeed } : {}),
      });
      const wallMs = Date.now() - t0;
      log(
        `tracked ${result.frames.length} frames in ${(wallMs / 1000).toFixed(1)}s ` +
          `(roiAnchor=${result.roiAnchor}, head=${result.headDetector})`,
      );

      const m = computeMetrics(result, wallMs);
      setMetrics(m);
      setRoiAnchor(result.roiAnchor);

      // Phase A1 tempo detectors — pure series math over what was tracked.
      const coarseDet = runPuttingDetectors({
        posePriors,
        balls: result.frames.map((f) => (f.ball ? { x: f.ball.x, y: f.ball.y } : null)),
        stepMs,
      });

      // Phase A2 fine takeaway (bar mode only): smoothed series → windowed
      // native greenness refine → ramp-foot onset. Any failure leaves the
      // coarse result standing with a specific warning.
      let smoothed: SmoothedShaftFrame[] | null = null;
      let refinedPoints: PuttingRefinedPoint[] | null = null;
      let headExtPx: number | null = null;
      let det = coarseDet;
      if (headDetector === 'bar') {
        const shaftLenPx = result.barCalibration?.shaftLenPx ?? null;
        let skipReason = 'fine_skipped_not_bar_mode';
        if (shaftLenPx == null) {
          skipReason = 'no_shaft_len';
          log('bar calibration failed — fine takeaway skipped (coarse stands)');
        } else {
          headExtPx = Math.round(0.13 * shaftLenPx); // D3 ratio — 0.13×194 ≈ 25
          const shaftFits: ShaftFitSample[] = result.frames.map((f) => f.shaftFit ?? null);
          smoothed = smoothShaftSeries(shaftFits, shaftLenPx, headExtPx);
          if (smoothed == null) {
            skipReason = 'no_anchors';
            log('no anchor fits (lengthMatch ≥ 0.6) — fine takeaway skipped');
          } else if (coarseDet.takeawayFrame != null && coarseDet.topFrame != null) {
            const win = computeRefineWindow(coarseDet.takeawayFrame, coarseDet.topFrame);
            const specFrames = [];
            for (let f = Math.max(0, win.lo); f <= Math.min(win.hi, smoothed.length - 1); f++) {
              const sf = smoothed[f];
              specFrames.push({ gridIdx: f, gripX: sf.px, gripY: sf.py, angleDeg: sf.ang });
            }
            if (specFrames.length > 0) {
              log(`refining head over f${specFrames[0].gridIdx}–f${specFrames[specFrames.length - 1].gridIdx}…`);
              const refined = await refinePutterHead(download.uri, stepMs, {
                frames: specFrames,
                shaftLenPx,
                headExtPx,
              });
              refinedPoints = refined.points;
            }
          }
        }
        if (smoothed && shaftLenPx != null) {
          setPlaybackSmoothed(smoothed);
          setPlaybackShaftLen(shaftLenPx);
          setPlaybackAnalysisW(result.analysisWidth ?? 480);
        }
        const anchorCount = smoothed ? smoothed.filter((sf) => sf.anchor).length : null;
        det = applyFineTakeaway({
          base: coarseDet,
          refinedPoints,
          headExtPx,
          anchorCount,
          stepMs,
          skipReason,
        });
      }
      setDetectors(det);
      log(
        `detectors: TA ${det.takeawayFrame ?? '—'} · TOP ${det.topFrame ?? '—'} · ` +
          `IMP ${det.impactFrame ?? '—'} · tempo ${det.tempo?.ratio ?? '—'}`,
      );

      log('exporting artifacts…');
      const exportDir = `${FileSystem.documentDirectory}putting-cv-test/`;
      await FileSystem.makeDirectoryAsync(exportDir, { intermediates: true });

      const jsonUri = `${exportDir}${id}.json`;
      const payload = {
        // v2 = v1 + putting_detectors; v3 = v2 + bar_calibration /
        // smoothed_series / refined_points (null on non-bar runs). The v3
        // export IS the refined-disp fixture source for the post-batch
        // findOnset lock-in (plan Step 6).
        schema_version: 3,
        swing_id: id,
        exported_at_ms: Date.now(),
        step_ms: stepMs,
        video_duration_ms: result.videoDurationMs,
        frame_width: result.frameWidth,
        frame_height: result.frameHeight,
        roi_anchor: result.roiAnchor,
        head_detector: result.headDetector,
        ball_seed: ballSeed ?? null,
        metrics: m,
        putting_detectors: det,
        bar_calibration: result.barCalibration ?? null,
        smoothed_series: smoothed,
        refined_points: refinedPoints,
        // Harness-side EXTERNAL ASSUMPTION constants (plugin constants are
        // documented in HoneyPuttingTrackerPlugin.swift).
        external_assumptions_used: {
          BALL_MOVE_EPS_PX,
          BALL_MOVE_SUSTAIN_FRAMES,
          HEAD_MOTION_EPS_PX,
          REST_ANCHOR_SAMPLE_FRAMES,
          POSE_SHAFT_CAL_OFFSET_DEG,
          POSE_PRIOR_MIN_CONF,
        },
        pose_priors_usable: priorCount,
        pose_priors_total: posePriors.length,
        // Full prior series (anchor normalized 0-1, angle post-calibration —
        // exactly what was sent to the plugin), for offline smoothness plots.
        pose_priors: posePriors.map((p, idx) => (p ? { idx, ...p } : null)),
        frames: result.frames,
      };
      await FileSystem.writeAsStringAsync(jsonUri, JSON.stringify(payload, null, 2), {
        encoding: FileSystem.EncodingType.UTF8,
      });
      setJsonPath(jsonUri);

      // Raw source clip (untouched full-res) — copied BEFORE the overlay
      // branch so a failed overlay writer still exports the raw video.
      const rawUri = `${exportDir}${id}-raw.mov`;
      await FileSystem.copyAsync({ from: download.uri, to: rawUri });
      setRawPath(rawUri);

      if (result.overlayUri) {
        const overlayUri = `${exportDir}${id}-overlay.mov`;
        await FileSystem.copyAsync({ from: result.overlayUri, to: overlayUri });
        setOverlayPath(overlayUri);
      } else {
        log('overlay writer failed — JSON only (tracking result unaffected)');
      }

      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [swingId, seedXText, seedYText, headDetector, overlayMode, log]);

  const onShare = useCallback(async (uri: string) => {
    try {
      await Share.share({ url: uri });
    } catch {
      // user dismissed the sheet — not an error
    }
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.header}>Putting CV Tracker Test</Text>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.close}>Close</Text>
        </Pressable>
      </View>
      <Text style={styles.subheader}>
        Dev-only go/no-go harness. Targets: head-found &gt;95% (stroke), ball-found &gt;95%
        (rest), jitter &lt;2px.
      </Text>

      <TextInput
        style={styles.input}
        value={swingId}
        onChangeText={setSwingId}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="swing id"
        placeholderTextColor="#666"
        editable={phase !== 'running'}
      />

      <View style={styles.seedRow}>
        <View style={styles.seedField}>
          <Text style={styles.seedLabel}>Seed x (0-1)</Text>
          <TextInput
            style={[styles.input, styles.seedInput]}
            value={seedXText}
            onChangeText={setSeedXText}
            keyboardType="decimal-pad"
            autoCorrect={false}
            placeholder="Seed x (0-1)"
            placeholderTextColor="#666"
            editable={phase !== 'running'}
          />
        </View>
        <View style={styles.seedField}>
          <Text style={styles.seedLabel}>Seed y (0-1)</Text>
          <TextInput
            style={[styles.input, styles.seedInput]}
            value={seedYText}
            onChangeText={setSeedYText}
            keyboardType="decimal-pad"
            autoCorrect={false}
            placeholder="Seed y (0-1)"
            placeholderTextColor="#666"
            editable={phase !== 'running'}
          />
        </View>
      </View>
      <Text style={styles.seedHint}>middle ball, this clip · both empty = no seed</Text>

      <View style={styles.detectorRow}>
        {(['bar', 'shaft', 'blob'] as const).map((d) => (
          <Pressable
            key={d}
            onPress={() => setHeadDetector(d)}
            disabled={phase === 'running'}
            style={[styles.detectorButton, headDetector === d && styles.detectorButtonActive]}
          >
            <Text
              style={[styles.detectorText, headDetector === d && styles.detectorTextActive]}
            >
              {d === 'bar' ? 'Head: BAR' : d === 'shaft' ? 'Head: SHAFT' : 'Head: BLOB'}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.detectorRow}>
        {(['clean', 'annotated'] as const).map((m) => (
          <Pressable
            key={m}
            onPress={() => setOverlayMode(m)}
            disabled={phase === 'running'}
            style={[styles.detectorButton, overlayMode === m && styles.detectorButtonActive]}
          >
            <Text style={[styles.detectorText, overlayMode === m && styles.detectorTextActive]}>
              {m === 'clean' ? 'Overlay: CLEAN' : 'Overlay: ANNOTATED'}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        onPress={onRun}
        disabled={phase === 'running'}
        style={[styles.primaryButton, phase === 'running' && styles.disabledButton]}
      >
        <Text style={styles.primaryButtonText}>
          {phase === 'running' ? 'Running…' : 'Run tracker'}
        </Text>
      </Pressable>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
        {status.map((line, i) => (
          <Text key={i} style={styles.logLine}>
            {line}
          </Text>
        ))}

        {detectors && (
          <View style={styles.metricsBox}>
            <Text style={styles.chipLine}>
              TA {detectors.takeawayFrame != null ? `f${detectors.takeawayFrame}` : '—'} · TOP{' '}
              {detectors.topFrame != null ? `f${detectors.topFrame}` : '—'} · IMP{' '}
              {detectors.impactFrame != null ? `f${detectors.impactFrame}` : '—'} · tempo{' '}
              {detectors.tempo
                ? `${detectors.tempo.ratio} (${detectors.tempo.backswingMs}/${detectors.tempo.downswingMs}ms)`
                : '—'}
            </Text>
            <Text style={styles.metricLine}>
              sentinels dropped {detectors.intermediates.sentinel_filtered_count} · crossing{' '}
              {detectors.intermediates.crossing_frame != null
                ? `f${detectors.intermediates.crossing_frame}`
                : '—'}{' '}
              · plateau{' '}
              {detectors.intermediates.plateau
                ? `f${detectors.intermediates.plateau.start}–${detectors.intermediates.plateau.end}`
                : '—'}
            </Text>
            {detectors.intermediates.fine && (
              <Text style={styles.metricLine}>
                fine: coarse{' '}
                {detectors.intermediates.fine.coarse_takeaway != null
                  ? `f${detectors.intermediates.fine.coarse_takeaway}`
                  : '—'}{' '}
                · onset{' '}
                {detectors.intermediates.fine.onset != null
                  ? `f${detectors.intermediates.fine.onset}`
                  : '—'}{' '}
                · cross{' '}
                {detectors.intermediates.fine.hard_cross != null
                  ? `f${detectors.intermediates.fine.hard_cross}`
                  : '—'}{' '}
                · σ {detectors.intermediates.fine.sigma_px ?? '—'}px · L{' '}
                {detectors.intermediates.fine.head_ext_px != null
                  ? `${detectors.intermediates.fine.head_ext_px}ext`
                  : '—'}{' '}
                · anchors {detectors.intermediates.fine.anchor_count ?? '—'} · coast{' '}
                {detectors.intermediates.fine.coasted_count ?? '—'}
              </Text>
            )}
            {detectors.intermediates.warnings.length > 0 && (
              <Text style={styles.gateFail}>
                warnings: {detectors.intermediates.warnings.join(', ')}
              </Text>
            )}
          </View>
        )}

        {metrics && (
          <View style={styles.metricsBox}>
            <Text style={styles.metricLine}>roiAnchor: {roiAnchor}</Text>
            <Text style={styles.metricLine}>
              rest window:{' '}
              {metrics.rest_window === 'none'
                ? 'none (pre-moving ball — rest metrics skipped)'
                : `frames ${metrics.rest_window.startIdx}–${metrics.rest_window.endIdx}`}
            </Text>
            <Text style={styles.metricLine}>
              stroke window:{' '}
              {metrics.stroke_window === 'none'
                ? 'none (no head motion detected)'
                : `frames ${metrics.stroke_window.startIdx}–${metrics.stroke_window.endIdx}`}
            </Text>
            <Text style={gateStyle(metrics.ball_found_rate_rest, 0.95)}>
              ball found @ rest: {pct(metrics.ball_found_rate_rest)} (gate &gt;95%)
            </Text>
            <Text style={gateStyle(metrics.head_found_rate_stroke, 0.95)}>
              head found @ stroke: {pct(metrics.head_found_rate_stroke)} (gate &gt;95%)
            </Text>
            <Text
              style={
                metrics.rest_ball_jitter_px === null
                  ? styles.metricLine
                  : metrics.rest_ball_jitter_px < 2
                    ? styles.gatePass
                    : styles.gateFail
              }
            >
              rest jitter:{' '}
              {metrics.rest_ball_jitter_px === null
                ? 'n/a'
                : `${metrics.rest_ball_jitter_px.toFixed(2)}px`}{' '}
              (gate &lt;2px)
            </Text>
            <Text style={styles.metricLine}>
              overall: ball {pct(metrics.ball_found_rate_overall)} · head{' '}
              {pct(metrics.head_found_rate_overall)} · {metrics.frame_count} frames ·{' '}
              {(metrics.track_wall_ms / 1000).toFixed(1)}s
            </Text>
            <Text style={styles.metricLine}>
              vision-fallback frames: ball {metrics.ball_vision_frames} · head{' '}
              {metrics.head_vision_frames}
            </Text>
            <Text style={styles.metricLine}>
              null gaps — ball: [{metrics.ball_null_gaps.join(', ')}] · head: [
              {metrics.head_null_gaps.join(', ')}]
            </Text>
          </View>
        )}

        {jsonPath && (
          <Pressable onPress={() => onShare(jsonPath)} style={styles.shareButton}>
            <Text style={styles.shareButtonText}>Share JSON</Text>
          </Pressable>
        )}
        {overlayPath && (
          <Pressable onPress={() => onShare(overlayPath)} style={styles.shareButton}>
            <Text style={styles.shareButtonText}>Share overlay video</Text>
          </Pressable>
        )}
        {rawPath && (
          <Pressable onPress={() => onShare(rawPath)} style={styles.shareButton}>
            <Text style={styles.shareButtonText}>Share raw video</Text>
          </Pressable>
        )}

        {localVideoUri && playbackFrames && (
          <View style={styles.playbackSection}>
            <Text style={styles.playbackTitle}>Playback (Phase B overlay)</Text>
            <View style={styles.detectorRow}>
              <Pressable
                onPress={() => setShowShaft((v) => !v)}
                style={[styles.detectorButton, showShaft && styles.detectorButtonActive]}
              >
                <Text style={[styles.detectorText, showShaft && styles.detectorTextActive]}>
                  SHAFT {showShaft ? 'ON' : 'off'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setShowSkeleton((v) => !v)}
                style={[styles.detectorButton, showSkeleton && styles.detectorButtonActive]}
              >
                <Text style={[styles.detectorText, showSkeleton && styles.detectorTextActive]}>
                  SKELETON {showSkeleton ? 'ON' : 'off'}
                </Text>
              </Pressable>
            </View>
            <View style={{ width: PLAYBACK_W, height: PLAYBACK_H }}>
              <VideoView
                player={clock.player}
                style={{ width: PLAYBACK_W, height: PLAYBACK_H }}
                contentFit="contain"
                nativeControls={false}
              />
              {showSkeleton && (
                <View style={StyleSheet.absoluteFill} pointerEvents="none">
                  <SwingSkeletonCanvas
                    frames={playbackFrames}
                    phases={null}
                    width={PLAYBACK_W}
                    height={PLAYBACK_H}
                    playheadIdx={clock.videoIdx ?? 0}
                    overlay
                  />
                </View>
              )}
              {showShaft && playbackSmoothed && playbackShaftLen != null && (
                <PuttingShaftOverlay
                  smoothed={playbackSmoothed}
                  shaftLenPx={playbackShaftLen}
                  analysisWidth={playbackAnalysisW}
                  playheadIdx={clock.videoIdx ?? 0}
                  width={PLAYBACK_W}
                  height={PLAYBACK_H}
                />
              )}
            </View>
            <View style={styles.detectorRow}>
              <Pressable
                onPress={() => (clock.isPlaying ? clock.player?.pause() : clock.player?.play())}
                style={styles.detectorButton}
              >
                <Text style={styles.detectorText}>{clock.isPlaying ? 'Pause' : 'Play'}</Text>
              </Pressable>
              {([0.25, 1] as const).map((sp) => (
                <Pressable
                  key={sp}
                  onPress={() => clock.setSpeed(sp)}
                  style={[styles.detectorButton, clock.speed === sp && styles.detectorButtonActive]}
                >
                  <Text
                    style={[styles.detectorText, clock.speed === sp && styles.detectorTextActive]}
                  >
                    {sp}×
                  </Text>
                </Pressable>
              ))}
            </View>
            {!playbackSmoothed && (
              <Text style={styles.seedHint}>
                shaft line needs a bar-mode run with successful calibration
              </Text>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// Playback stage box: contain-fit portrait 9:16, same identity-mapping
// assumption as the result screen (skeletonProjection.ts driven mode).
const PLAYBACK_W = Dimensions.get('window').width - 32;
const PLAYBACK_H = Math.round(PLAYBACK_W * (16 / 9));

function gateStyle(v: number | null, target: number) {
  if (v === null) return styles.metricLine;
  return v > target ? styles.gatePass : styles.gateFail;
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
    marginBottom: 4,
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
  subheader: {
    color: '#AAA',
    fontSize: 13,
    marginBottom: 16,
  },
  input: {
    backgroundColor: '#1C1C1E',
    borderRadius: 8,
    color: '#FFF',
    fontFamily: 'Menlo',
    fontSize: 13,
    padding: 12,
    marginBottom: 12,
  },
  seedRow: {
    flexDirection: 'row',
    gap: 8,
  },
  seedField: {
    flex: 1,
  },
  seedLabel: {
    color: '#AAA',
    fontSize: 11,
    marginBottom: 4,
  },
  seedInput: {
    marginBottom: 0,
  },
  seedHint: {
    color: '#666',
    fontSize: 11,
    marginTop: 4,
    marginBottom: 12,
  },
  detectorRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  detectorButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  detectorButtonActive: {
    borderColor: '#0A84FF',
    backgroundColor: '#0A84FF22',
  },
  detectorText: {
    color: '#888',
    fontSize: 13,
    fontFamily: 'Menlo',
  },
  detectorTextActive: {
    color: '#0A84FF',
    fontWeight: '700',
  },
  primaryButton: {
    backgroundColor: '#0A84FF',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  disabledButton: {
    backgroundColor: '#333',
  },
  primaryButtonText: {
    color: '#FFF',
    fontSize: 17,
    fontWeight: '700',
  },
  errorBanner: {
    backgroundColor: '#3a1010',
    borderColor: '#FF453A',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  errorText: {
    color: '#FF6961',
    fontSize: 14,
    fontWeight: '600',
  },
  log: {
    flex: 1,
    backgroundColor: '#0E0E10',
    borderRadius: 8,
    padding: 10,
  },
  logContent: {
    paddingBottom: 24,
  },
  logLine: {
    color: '#9AE69A',
    fontSize: 13,
    fontFamily: 'Menlo',
    marginBottom: 4,
  },
  metricsBox: {
    backgroundColor: '#1C1C1E',
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
    marginBottom: 12,
  },
  metricLine: {
    color: '#FFF',
    fontSize: 13,
    fontFamily: 'Menlo',
    marginBottom: 4,
  },
  chipLine: {
    color: '#FFD60A',
    fontSize: 14,
    fontFamily: 'Menlo',
    fontWeight: '700',
    marginBottom: 6,
  },
  gatePass: {
    color: '#32D74B',
    fontSize: 13,
    fontFamily: 'Menlo',
    fontWeight: '700',
    marginBottom: 4,
  },
  gateFail: {
    color: '#FF453A',
    fontSize: 13,
    fontFamily: 'Menlo',
    fontWeight: '700',
    marginBottom: 4,
  },
  shareButton: {
    backgroundColor: '#30D158',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  shareButtonText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '700',
  },
  playbackSection: {
    marginTop: 16,
    marginBottom: 24,
  },
  playbackTitle: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 8,
  },
});
