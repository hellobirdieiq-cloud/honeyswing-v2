import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, Share, StyleSheet } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getSwingVideoSignedUrl } from '@/lib/getSwingVideoUrl';
import { CAPTURE_FPS, ANALYZER_DECIMATION } from '@/lib/cameraFormat';
import {
  trackPuttingObjects,
  type PuttingBallSeed,
  type PuttingPosePrior,
  type PuttingTrackResult,
  type PuttingObjectFrame,
} from '@/modules/vision-camera-pose/src';

/**
 * Putting CV go/no-go gate (Phase 1) — dev-only eyeball harness.
 *
 * Reachable ONLY by direct route (router.push('/dev/putting-tracker-test') or
 * uri-scheme). Deliberately NOT linked from any tab, button, or screen.
 *
 * Downloads a swing's clip from the swing-videos bucket, runs the native
 * putting tracker on the SAME 8.33ms timestamp grid as pose extraction, then
 * computes the gate metrics and exports <swingId>.json + <swingId>-overlay.mov
 * + <swingId>-raw.mov (untouched full-res source — the overlay is 480w with
 * markers burned in) via the share sheet (manually copied into
 * docs/putting-cv-test/).
 *
 * The rest/stroke windows below are METRIC REPORTING ONLY — this is not phase
 * detection, and putting must NEVER fall back to the wrist/pose phase detector.
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

// EXTERNAL ASSUMPTION — pose prior calibration: LeadWrist→TrailThumbTip runs
// +3.0° hot vs the human-measured shaft on fixture 1d8722b8 (+1.85°/+4.22°
// at f55/f114); subtract the bias before sending. Pair joints below
// POSE_PRIOR_MIN_CONF → null prior for that frame (pure-CV gates).
const POSE_SHAFT_CAL_OFFSET_DEG = 3.0;
const POSE_PRIOR_MIN_CONF = 0.3;

// The 10 hand/wrist joints that survive to motion_frames (adapter drops the
// other 34 COCO-WholeBody hand points before persist).
const POSE_HAND_JOINTS = [
  'leftWrist',
  'leftThumb',
  'leftThumbTip',
  'leftIndex',
  'leftPinky',
  'rightWrist',
  'rightThumb',
  'rightThumbTip',
  'rightIndex',
  'rightPinky',
] as const;

type MotionFrameLite = {
  timestampMs?: number;
  frameWidth?: number;
  frameHeight?: number;
  joints?: Record<string, { x: number; y: number; confidence: number } | undefined>;
};

function foldDeg(a: number): number {
  let v = a;
  while (v > 90) v -= 180;
  while (v <= -90) v += 180;
  return v;
}

/**
 * One prior per motion_frames entry — indices align 1:1 with the video grid
 * (verified in docs/putting-cv-test/poseAngleScan.ts). angleDeg = folded
 * leftWrist→rightThumbTip PIXEL-space angle minus the calibration bias;
 * anchor = mean of the confident hand joints, normalized 0-1 (mean in pixel
 * space ÷ frame dims — identical since dims are per-frame constant).
 */
function buildPosePriors(motionFrames: MotionFrameLite[]): (PuttingPosePrior | null)[] {
  return motionFrames.map((f) => {
    const lw = f.joints?.leftWrist;
    const rt = f.joints?.rightThumbTip;
    const w = f.frameWidth;
    const h = f.frameHeight;
    if (!lw || !rt || !w || !h) return null;
    if (!(lw.confidence > POSE_PRIOR_MIN_CONF) || !(rt.confidence > POSE_PRIOR_MIN_CONF)) {
      return null;
    }
    const rawAngle = (Math.atan2(rt.x * w - lw.x * w, rt.y * h - lw.y * h) * 180) / Math.PI;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const name of POSE_HAND_JOINTS) {
      const j = f.joints?.[name];
      if (j && j.confidence > POSE_PRIOR_MIN_CONF) {
        sx += j.x;
        sy += j.y;
        n += 1;
      }
    }
    if (n === 0) return null;
    return {
      angleDeg: foldDeg(foldDeg(rawAngle) - POSE_SHAFT_CAL_OFFSET_DEG),
      anchorX: sx / n,
      anchorY: sy / n,
      confidence: Math.min(lw.confidence, rt.confidence),
    };
  });
}

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
  const [headDetector, setHeadDetector] = useState<'shaft' | 'blob'>('shaft');
  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<GateMetrics | null>(null);
  const [roiAnchor, setRoiAnchor] = useState<string | null>(null);
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
    setRoiAnchor(null);
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

      // Same grid step as pose extraction (lib/extractPoseFromVideo.ts:75).
      const stepMs = ANALYZER_DECIMATION * (1000 / CAPTURE_FPS);
      log(`tracking (stepMs=${stepMs.toFixed(2)})…`);
      const t0 = Date.now();
      const result = await trackPuttingObjects(download.uri, stepMs, {
        writeOverlay: true,
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

      log('exporting artifacts…');
      const exportDir = `${FileSystem.documentDirectory}putting-cv-test/`;
      await FileSystem.makeDirectoryAsync(exportDir, { intermediates: true });

      const jsonUri = `${exportDir}${id}.json`;
      const payload = {
        schema_version: 1,
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
  }, [swingId, seedXText, seedYText, headDetector, log]);

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
        {(['shaft', 'blob'] as const).map((d) => (
          <Pressable
            key={d}
            onPress={() => setHeadDetector(d)}
            disabled={phase === 'running'}
            style={[styles.detectorButton, headDetector === d && styles.detectorButtonActive]}
          >
            <Text
              style={[styles.detectorText, headDetector === d && styles.detectorTextActive]}
            >
              {d === 'shaft' ? 'Head: SHAFT' : 'Head: BLOB'}
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
      </ScrollView>
    </View>
  );
}

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
});
