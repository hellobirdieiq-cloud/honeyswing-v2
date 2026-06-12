import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Svg, { Line, Circle, Polygon, Path, G } from 'react-native-svg';
import type { PoseFrame, JointName, NormalizedJoint } from '../packages/pose/PoseTypes';
import type { DetectedPhase, SwingPhase } from '../packages/domain/swing/phaseDetection';
import { GOLD } from '../lib/colors';

const MIN_CONF = 0.2;

const COLOR_TORSO_LINE = 'rgba(240,240,240,0.9)';
const COLOR_TORSO_FILL = 'rgba(200,200,200,0.7)';
const COLOR_ARM = 'rgba(59,130,246,1.0)';
const COLOR_LEG = 'rgba(234,88,12,1.0)';
const COLOR_FOOT_FILL = 'rgba(251,146,60,0.75)';

// Visual presets selected by the `overlay` prop. `default` is the exact
// skeleton-only look (unchanged). `overlay` thins bones to ~60% and joint dots
// to ~70%, and drops the torso/foot fills so the video reads through; the club
// (hand) trail widths are intentionally identical across presets.
type SkeletonPreset = {
  showTorsoFill: boolean;
  showFootFill: boolean;
  stroke: { torso: number; thigh: number; calf: number; foot: number; arm: number; hand: number };
  dot: { key: number; ringOuter: number; ringInner: number };
};

const PRESET_DEFAULT: SkeletonPreset = {
  showTorsoFill: true,
  showFootFill: true,
  stroke: { torso: 3.5, thigh: 10, calf: 7, foot: 7, arm: 7, hand: 7 },
  dot: { key: 5, ringOuter: 8, ringInner: 5 },
};

const PRESET_OVERLAY: SkeletonPreset = {
  showTorsoFill: false,
  showFootFill: false,
  // ~60% of default bone widths.
  stroke: { torso: 2.1, thigh: 6, calf: 4.2, foot: 4.2, arm: 4.2, hand: 4.2 },
  // ~70% of default dot radii.
  dot: { key: 3.5, ringOuter: 5.6, ringInner: 3.5 },
};

const TORSO_LINES: [JointName, JointName][] = [
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
];
const ARM_LINES: [JointName, JointName][] = [
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
];
const HAND_LINES: [JointName, JointName][] = [
  ['leftWrist', 'leftPinky'],
  ['leftWrist', 'leftIndex'],
  ['leftPinky', 'leftIndex'],
  ['leftWrist', 'leftThumb'],
  ['rightWrist', 'rightPinky'],
  ['rightWrist', 'rightIndex'],
  ['rightPinky', 'rightIndex'],
  ['rightWrist', 'rightThumb'],
];
const THIGH_LINES: [JointName, JointName][] = [
  ['leftHip', 'leftKnee'],
  ['rightHip', 'rightKnee'],
];
const CALF_LINES: [JointName, JointName][] = [
  ['leftKnee', 'leftAnkle'],
  ['rightKnee', 'rightAnkle'],
];
const FOOT_LINES: [JointName, JointName][] = [
  ['leftAnkle', 'leftHeel'],
  ['leftAnkle', 'leftFootIndex'],
  ['leftHeel', 'leftFootIndex'],
  ['rightAnkle', 'rightHeel'],
  ['rightAnkle', 'rightFootIndex'],
  ['rightHeel', 'rightFootIndex'],
];

const KEY_DOTS: JointName[] = [
  'leftShoulder', 'rightShoulder',
  'leftHip', 'rightHip',
  'leftKnee', 'rightKnee',
  'leftAnkle', 'rightAnkle',
];
const RING_DOTS: JointName[] = ['leftElbow', 'rightElbow', 'leftWrist', 'rightWrist'];
const LEFT_HAND_JOINTS: JointName[] = ['leftWrist', 'leftPinky', 'leftIndex', 'leftThumb'];
const RIGHT_HAND_JOINTS: JointName[] = ['rightWrist', 'rightPinky', 'rightIndex', 'rightThumb'];

function getJoint(frame: PoseFrame, name: JointName): NormalizedJoint | null {
  const j = frame.joints[name];
  return j && (j.confidence ?? 0) >= MIN_CONF ? j : null;
}

function spatialMedian(frame: PoseFrame, names: JointName[]): { x: number; y: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of names) {
    const j = getJoint(frame, n);
    if (j) { xs.push(j.x); ys.push(j.y); }
  }
  if (xs.length === 0) return null;
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return { x: xs[mid], y: ys[mid] };
}

function temporalMedianSmooth(
  pts: ({ x: number; y: number } | null)[],
  windowSize = 5,
): ({ x: number; y: number } | null)[] {
  const half = Math.floor(windowSize / 2);
  return pts.map((_, i) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(pts.length - 1, i + half); j++) {
      const p = pts[j];
      if (p) { xs.push(p.x); ys.push(p.y); }
    }
    if (xs.length === 0) return null;
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    const m = Math.floor(xs.length / 2);
    return { x: xs[m], y: ys[m] };
  });
}

function buildPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
  }
  return d;
}

type PhaseChipKey = SwingPhase | 'full_swing';
const PHASE_CHIPS: { phase: PhaseChipKey; label: string }[] = [
  { phase: 'full_swing',     label: 'Full Swing' },
  { phase: 'takeaway',       label: 'Takeaway' },
  { phase: 'top',            label: 'Top' },
  { phase: 'impact',         label: 'Impact' },
  { phase: 'follow_through', label: 'Finish' },
];

interface Props {
  frames: PoseFrame[];
  phases: DetectedPhase[] | null;
  width: number;
  height: number;
  /**
   * Drive the displayed frame from an external playhead (the video player).
   * null/absent → uncontrolled: self-clocked rAF loop, autoplay, endIdx
   * cutoff, internal controls (existing behavior — video-less swings).
   * number → driven: render frames[clamp(playheadIdx)], skip the self-clock,
   * hide the speed/play row (the video owns transport).
   */
  playheadIdx?: number | null;
  /**
   * Driven mode only: phase-chip taps are routed here (seek the video, the
   * single clock) instead of the internal self-clock handler. When absent in
   * driven mode the chip row is hidden rather than rendering dead chips.
   */
  onPhaseSeek?: (phase: string, index: number) => void;
  /**
   * Overlay mode: render the bare SVG with a transparent background and no
   * margins/radius/controls, so the caller can stack it pixel-flush on top of
   * the video frame. The caller owns all transport (segmented control + video
   * speed/play row). Driven (playheadIdx) is expected alongside this.
   */
  overlay?: boolean;
}

export default function SwingSkeletonCanvas({
  frames,
  phases,
  width,
  height,
  playheadIdx = null,
  onPhaseSeek,
  overlay = false,
}: Props) {
  const driven = playheadIdx != null;
  const preset = overlay ? PRESET_OVERLAY : PRESET_DEFAULT;
  const transform = useMemo(() => {
    if (frames.length === 0) return null;
    if (driven) {
      // Driven mode: video & pose share the full 9:16 frame (no crop on either
      // side — pose extracted from the full frame, video contain-fit in a 9:16
      // box), so the identity mapping puts each joint on the golfer's pixel.
      // Keypoints are faithful-anatomical (decode conjugation fix) — no flip.
      const tx = (x: number) => x * width;
      const ty = (y: number) => y * height;
      return { tx, ty };
    }
    const f0 = frames[0];
    const top = getJoint(f0, 'leftShoulder') ?? getJoint(f0, 'rightShoulder') ?? getJoint(f0, 'nose');
    const bot =
      getJoint(f0, 'leftAnkle') ??
      getJoint(f0, 'rightAnkle') ??
      getJoint(f0, 'leftFootIndex') ??
      getJoint(f0, 'rightFootIndex');
    const lh = getJoint(f0, 'leftHip');
    const rh = getJoint(f0, 'rightHip');
    if (!top || !bot || !lh || !rh) return null;
    const vertical = Math.max(0.01, bot.y - top.y);
    const scale = (height * 0.75) / vertical;
    const H_PAD = 0.70;
    const hScale = scale * H_PAD;
    const hipX0 = (lh.x + rh.x) / 2;
    const hipY0 = (lh.y + rh.y) / 2;
    const anchorX = width / 2;
    const anchorY = height * 0.40;
    const tx = (x: number) => anchorX + (x - hipX0) * hScale;
    const ty = (y: number) => anchorY + (y - hipY0) * scale;
    return { tx, ty };
  }, [driven, frames, width, height]);

  const endIdx = useMemo(() => {
    if (frames.length < 4) return Math.max(0, frames.length - 1);
    const start = Math.floor(frames.length / 2);
    // Faithful-convention transport of the old mirrored heuristic: old
    // min(label-leftShoulder.x) ≡ new max(label-rightShoulder.x) under
    // x→1−x + label swap. Cosmetic end-trim for the self-clocked preview.
    let maxX = -Infinity;
    let maxIdx = frames.length - 1;
    for (let i = start; i < frames.length; i++) {
      const j = getJoint(frames[i], 'rightShoulder') ?? getJoint(frames[i], 'leftShoulder');
      if (!j) continue;
      if (j.x > maxX) { maxX = j.x; maxIdx = i; }
    }
    return maxIdx;
  }, [frames]);

  const [currentIdx, setCurrentIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(0.25);
  const rafRef = useRef<number | null>(null);
  const frameDebtRef = useRef(0);
  const lastWallRef = useRef<number>(0);

  useEffect(() => {
    if (driven) return; // driven mode: the video playhead owns the clock
    if (!isPlaying) return;
    let cancelled = false;
    frameDebtRef.current = 0;
    lastWallRef.current = Date.now();
    const tick = () => {
      if (cancelled) return;
      const now = Date.now();
      const dWall = now - lastWallRef.current;
      lastWallRef.current = now;
      setCurrentIdx((idx) => {
        if (idx >= endIdx) {
          setIsPlaying(false);
          return endIdx;
        }
        let next = idx;
        let debt = frameDebtRef.current + dWall * speed;
        while (next < endIdx) {
          const cur = frames[next].timestampMs;
          const nxt = frames[next + 1].timestampMs;
          const step = Math.max(1, nxt - cur);
          if (debt < step) break;
          debt -= step;
          next++;
        }
        frameDebtRef.current = debt;
        if (next >= endIdx) {
          setIsPlaying(false);
          return endIdx;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [driven, isPlaying, speed, frames, endIdx]);

  // Single resolved index for everything rendered below: external playhead
  // when driven, the self-clocked index otherwise.
  const displayIdx = driven
    ? Math.min(Math.max(0, playheadIdx), Math.max(0, frames.length - 1))
    : currentIdx;

  const handlePlayPause = useCallback(() => {
    if (currentIdx >= endIdx) {
      setCurrentIdx(0);
      setIsPlaying(true);
    } else {
      setIsPlaying((p) => !p);
    }
  }, [currentIdx, endIdx]);

  const handlePhaseChip = useCallback((phase: PhaseChipKey) => {
    if (phase === 'full_swing') {
      setCurrentIdx(0);
      setIsPlaying(true);
      return;
    }
    const p = phases?.find((x) => x.phase === phase);
    if (p && typeof p.index === 'number') {
      setCurrentIdx(Math.min(Math.max(0, p.index), endIdx));
      setIsPlaying(false);
    }
  }, [phases, endIdx]);

  // Driven mode: route chip taps to the video (the single clock — it drives
  // this canvas back via playheadIdx). Uncontrolled: internal self-clock.
  const handleChipTap = useCallback((phase: PhaseChipKey) => {
    if (driven) {
      if (!onPhaseSeek) return;
      if (phase === 'full_swing') {
        onPhaseSeek('full_swing', 0);
        return;
      }
      const p = phases?.find((x) => x.phase === phase);
      if (p && typeof p.index === 'number') onPhaseSeek(phase, p.index);
      return;
    }
    handlePhaseChip(phase);
  }, [driven, onPhaseSeek, phases, handlePhaseChip]);

  const trails = useMemo(() => {
    if (!transform || frames.length === 0) return null;
    const safeIdx = Math.min(displayIdx, frames.length - 1);
    const tNow = frames[safeIdx].timestampMs;
    const window: number[] = [];
    for (let i = safeIdx; i >= 0; i--) {
      if (tNow - frames[i].timestampMs > 250) break;
      window.unshift(i);
    }
    if (window.length < 2) return { leftFull: '', leftTail: '', rightFull: '', rightTail: '' };

    const buildHand = (joints: JointName[]) => {
      const raw: ({ x: number; y: number } | null)[] = window.map((i) => spatialMedian(frames[i], joints));
      const smoothed = temporalMedianSmooth(raw, 5);
      const screenPts: { x: number; y: number }[] = [];
      for (const p of smoothed) {
        if (p) screenPts.push({ x: transform.tx(p.x), y: transform.ty(p.y) });
      }
      const full = buildPath(screenPts);
      const tailStart = Math.max(0, Math.floor(screenPts.length * 0.7));
      const tail = buildPath(screenPts.slice(tailStart));
      return { full, tail };
    };

    const L = buildHand(LEFT_HAND_JOINTS);
    const R = buildHand(RIGHT_HAND_JOINTS);
    return { leftFull: L.full, leftTail: L.tail, rightFull: R.full, rightTail: R.tail };
  }, [frames, displayIdx, transform]);

  if (!transform || frames.length === 0) return null;

  const frame = frames[Math.min(displayIdx, frames.length - 1)];

  const sp = (name: JointName) => {
    const j = getJoint(frame, name);
    return j ? { x: transform.tx(j.x), y: transform.ty(j.y) } : null;
  };

  const renderLines = (
    pairs: [JointName, JointName][],
    stroke: string,
    strokeW: number,
    keyPrefix: string,
  ) =>
    pairs.map(([a, b]) => {
      const pa = sp(a);
      const pb = sp(b);
      if (!pa || !pb) return null;
      return (
        <Line
          key={`${keyPrefix}-${a}-${b}`}
          x1={pa.x} y1={pa.y}
          x2={pb.x} y2={pb.y}
          stroke={stroke}
          strokeWidth={strokeW}
          strokeLinecap="round"
        />
      );
    });

  const lsP = sp('leftShoulder');
  const rsP = sp('rightShoulder');
  const lhP = sp('leftHip');
  const rhP = sp('rightHip');
  const torsoPolyPts = (lsP && rsP && rhP && lhP)
    ? `${lsP.x},${lsP.y} ${rsP.x},${rsP.y} ${rhP.x},${rhP.y} ${lhP.x},${lhP.y}`
    : null;

  const footPoly = (ankle: JointName, heel: JointName, idx: JointName) => {
    const a = sp(ankle); const h = sp(heel); const f = sp(idx);
    if (!a || !h || !f) return null;
    return `${a.x},${a.y} ${h.x},${h.y} ${f.x},${f.y}`;
  };
  const leftFootPoly = footPoly('leftAnkle', 'leftHeel', 'leftFootIndex');
  const rightFootPoly = footPoly('rightAnkle', 'rightHeel', 'rightFootIndex');

  return (
    <View style={overlay ? styles.containerOverlay : styles.container}>
      <View
        style={[
          styles.canvasWrap,
          { width, height },
          overlay && styles.canvasWrapOverlay,
        ]}
      >
        <Svg width={width} height={height}>
          {preset.showTorsoFill && torsoPolyPts && <Polygon points={torsoPolyPts} fill={COLOR_TORSO_FILL} />}
          {preset.showFootFill && leftFootPoly && <Polygon points={leftFootPoly} fill={COLOR_FOOT_FILL} />}
          {preset.showFootFill && rightFootPoly && <Polygon points={rightFootPoly} fill={COLOR_FOOT_FILL} />}

          {trails && trails.leftFull !== '' && (
            <G>
              <Path d={trails.leftFull} stroke="rgba(60,150,255,0.06)" strokeWidth={14} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <Path d={trails.leftFull} stroke="rgba(100,200,255,0.25)" strokeWidth={7} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <Path d={trails.leftFull} stroke="rgba(220,240,255,0.95)" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              {trails.leftTail !== '' && (
                <G>
                  <Path d={trails.leftTail} stroke="rgba(60,150,255,0.06)" strokeWidth={21} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  <Path d={trails.leftTail} stroke="rgba(100,200,255,0.25)" strokeWidth={10.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  <Path d={trails.leftTail} stroke="rgba(220,240,255,0.95)" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </G>
              )}
            </G>
          )}
          {trails && trails.rightFull !== '' && (
            <G>
              <Path d={trails.rightFull} stroke="rgba(60,150,255,0.06)" strokeWidth={14} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <Path d={trails.rightFull} stroke="rgba(100,200,255,0.25)" strokeWidth={7} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <Path d={trails.rightFull} stroke="rgba(220,240,255,0.95)" strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              {trails.rightTail !== '' && (
                <G>
                  <Path d={trails.rightTail} stroke="rgba(60,150,255,0.06)" strokeWidth={21} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  <Path d={trails.rightTail} stroke="rgba(100,200,255,0.25)" strokeWidth={10.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  <Path d={trails.rightTail} stroke="rgba(220,240,255,0.95)" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </G>
              )}
            </G>
          )}

          {renderLines(TORSO_LINES, COLOR_TORSO_LINE, preset.stroke.torso, 'torso')}
          {renderLines(THIGH_LINES, COLOR_LEG, preset.stroke.thigh, 'thigh')}
          {renderLines(CALF_LINES, COLOR_LEG, preset.stroke.calf, 'calf')}
          {renderLines(FOOT_LINES, COLOR_LEG, preset.stroke.foot, 'foot')}
          {renderLines(ARM_LINES, COLOR_ARM, preset.stroke.arm, 'arm')}
          {renderLines(HAND_LINES, COLOR_ARM, preset.stroke.hand, 'hand')}

          {KEY_DOTS.map((n) => {
            const p = sp(n);
            if (!p) return null;
            return <Circle key={`dot-${n}`} cx={p.x} cy={p.y} r={preset.dot.key} fill="#FFFFFF" />;
          })}

          {RING_DOTS.map((n) => {
            const p = sp(n);
            if (!p) return null;
            return (
              <G key={`ring-${n}`}>
                <Circle cx={p.x} cy={p.y} r={preset.dot.ringOuter} fill="#FFFFFF" />
                <Circle cx={p.x} cy={p.y} r={preset.dot.ringInner} fill={COLOR_ARM} />
              </G>
            );
          })}
        </Svg>
      </View>

      {/* Driven mode: the video owns transport (play/pause/speed) — hide this
          row. The phase-chip row below stays visible and seeks the video via
          onPhaseSeek, so chips remain reachable right under the skeleton. */}
      {!driven && !overlay && (
        <View style={styles.controlsRow}>
          {([0.25, 0.5, 1] as const).map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.speedButton, speed === s && styles.speedButtonActive]}
              onPress={() => setSpeed(s)}
              activeOpacity={0.7}
            >
              <Text style={[styles.speedText, speed === s && styles.speedTextActive]}>{s}x</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.playButton} onPress={handlePlayPause} activeOpacity={0.7}>
            <Text style={styles.playText}>{isPlaying ? '⏸' : '▶'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {!overlay && (!driven || !!onPhaseSeek) && (
        <View style={styles.phaseRow}>
          {PHASE_CHIPS.map((entry) => {
            const enabled =
              entry.phase === 'full_swing' ||
              !!phases?.find((p) => p.phase === entry.phase);
            return (
              <TouchableOpacity
                key={entry.phase}
                style={[styles.chip, !enabled && styles.chipDisabled]}
                onPress={enabled ? () => handleChipTap(entry.phase) : undefined}
                disabled={!enabled}
                activeOpacity={0.7}
              >
                <Text style={[styles.chipText, !enabled && styles.chipTextDisabled]}>
                  {entry.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 12,
    marginBottom: 12,
    alignSelf: 'center',
  },
  // Overlay mode: no margins/radius so the SVG sits flush over the video box.
  containerOverlay: {
    alignSelf: 'center',
  },
  canvasWrap: {
    backgroundColor: '#08080A',
    borderRadius: 16,
    overflow: 'hidden',
    alignSelf: 'center',
  },
  canvasWrapOverlay: {
    backgroundColor: 'transparent',
    borderRadius: 0,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    justifyContent: 'center',
  },
  speedButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#1A1A1C',
    borderRadius: 8,
  },
  speedButtonActive: {
    backgroundColor: GOLD,
  },
  speedText: {
    color: '#999',
    fontSize: 14,
    fontWeight: '600',
  },
  speedTextActive: {
    color: '#1A0E00',
  },
  playButton: {
    marginLeft: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#1A1A1C',
    borderRadius: 8,
  },
  playText: {
    color: '#FFFFFF',
    fontSize: 14,
  },
  phaseRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginTop: 10,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#1A1A1C',
    borderRadius: 10,
    flexBasis: '31%',
    alignItems: 'center',
  },
  chipDisabled: {
    opacity: 0.4,
  },
  chipText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  chipTextDisabled: {
    color: '#666',
  },
});
