import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Line, G, Defs, LinearGradient, Stop } from 'react-native-svg';
import type { PoseFrame, JointName, NormalizedJoint } from '../packages/pose/PoseTypes';
import type { DetectedPhase } from '../packages/domain/swing/phaseDetection';

// ── Color palette ────────────────────────────────────────────────────
const HERO_GRADIENT = [
  { offset: '0%', color: '#4A7CF7' },
  { offset: '20%', color: '#3BC4C4' },
  { offset: '40%', color: '#44CC88' },
  { offset: '60%', color: '#F5A623' },
  { offset: '80%', color: '#FF6B35' },
  { offset: '100%', color: '#C850C0' },
];

const GHOST_TONE = '#1E2A38';
const SHOULDER_TONE = '#3A506B';
const HIP_TONE = '#2E3F55';

// ── Joint helpers ────────────────────────────────────────────────────
const MIN_CONF = 0.2;

function getJoint(frame: PoseFrame, name: JointName): NormalizedJoint | null {
  const j = frame.joints[name];
  return j && (j.confidence ?? 0) >= MIN_CONF ? j : null;
}

function midpointOf(
  frame: PoseFrame,
  a: JointName,
  b: JointName,
): { x: number; y: number } | null {
  const ja = getJoint(frame, a);
  const jb = getJoint(frame, b);
  if (!ja || !jb) return null;
  return { x: (ja.x + jb.x) / 2, y: (ja.y + jb.y) / 2 };
}

// ── Temporal smoothing (moving average, multi-pass) ──────────────────
function smoothTrail(
  pts: { x: number; y: number }[],
  window: number = 5,
  passes: number = 1,
): { x: number; y: number }[] {
  if (pts.length < 3) return pts;
  let result = pts;
  for (let p = 0; p < passes; p++) {
    const half = Math.floor(window / 2);
    result = result.map((_, i) => {
      const start = Math.max(0, i - half);
      const end = Math.min(result.length - 1, i + half);
      let sx = 0, sy = 0, count = 0;
      for (let j = start; j <= end; j++) {
        sx += result[j].x;
        sy += result[j].y;
        count++;
      }
      return { x: sx / count, y: sy / count };
    });
  }
  return result;
}

// ── Smooth SVG path (cubic Bezier with Catmull-Rom control points) ───
function buildSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  const f = (n: number) => n.toFixed(1);

  if (points.length === 2) {
    return `M ${f(points[0].x)} ${f(points[0].y)} L ${f(points[1].x)} ${f(points[1].y)}`;
  }

  // Catmull-Rom → cubic Bezier conversion for smooth curves
  let d = `M ${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];

    // Catmull-Rom tangents scaled by 1/6 for cubic Bezier control points
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${f(cp1x)} ${f(cp1y)} ${f(cp2x)} ${f(cp2y)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}

// ── Ghost frame connections: human silhouette (torso + upper limbs) ──
const GHOST_CONNECTIONS: [JointName, JointName][] = [
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
  ['leftShoulder', 'leftElbow'],
  ['rightShoulder', 'rightElbow'],
  ['leftHip', 'leftKnee'],
  ['rightHip', 'rightKnee'],
];

// ── Props ────────────────────────────────────────────────────────────
interface Props {
  frames: PoseFrame[];
  phases: DetectedPhase[];
  width: number;
}

export default function SwingArtCard({ frames, phases, width }: Props) {
  const size = width;
  const pad = size * 0.05;

  const art = useMemo(() => {
    if (frames.length < 6) return null;

    // ── Extract raw trails ───────────────────────────────────────────
    const rawWrist: { x: number; y: number }[] = [];
    const rawShoulder: { x: number; y: number }[] = [];
    const rawHip: { x: number; y: number }[] = [];

    for (const frame of frames) {
      const w = midpointOf(frame, 'leftWrist', 'rightWrist');
      if (w) rawWrist.push(w);
      const s = midpointOf(frame, 'leftShoulder', 'rightShoulder');
      if (s) rawShoulder.push(s);
      const h = midpointOf(frame, 'leftHip', 'rightHip');
      if (h) rawHip.push(h);
    }

    if (rawWrist.length < 4) return null;

    // ── Apply temporal smoothing ─────────────────────────────────────
    // Hero: double-pass to eliminate backswing kink without flattening
    const wristTrail = smoothTrail(rawWrist, 7, 2);
    const shoulderTrail = smoothTrail(rawShoulder, 7, 1);
    const hipTrail = smoothTrail(rawHip, 7, 1);

    // ── Bounds from hero + structural trails ONLY ────────────────────
    const boundsPts = [...wristTrail, ...shoulderTrail, ...hipTrail];

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of boundsPts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const rangeX = maxX - minX || 0.01;
    const rangeY = maxY - minY || 0.01;
    const scale = (size - pad * 2) / Math.max(rangeX, rangeY);
    const offX = pad + ((size - pad * 2) - rangeX * scale) / 2;
    const offY = pad + ((size - pad * 2) - rangeY * scale) / 2;

    const tx = (x: number) => offX + (x - minX) * scale;
    const ty = (y: number) => offY + (y - minY) * scale;

    const mapPts = (pts: { x: number; y: number }[]) =>
      pts.map((p) => ({ x: tx(p.x), y: ty(p.y) }));

    // ── Impact timestamp ─────────────────────────────────────────────
    const impactTs = phases.find((p) => p.phase === 'impact')?.timestamp ?? null;
    const firstTs = frames[0].timestampMs;
    const lastTs = frames[frames.length - 1].timestampMs;
    const duration = lastTs - firstTs || 1;

    // ── Ghost frames: ~18, human silhouette, slightly more visible ───
    const ghostElements: React.ReactElement[] = [];
    const ghostStep = Math.max(1, Math.ceil(frames.length / 18));
    for (let i = 0; i < frames.length; i += ghostStep) {
      const frame = frames[i];
      let opacity = 0.06;
      if (impactTs != null) {
        const dist = Math.abs(frame.timestampMs - impactTs) / duration;
        if (dist < 0.10) opacity = 0.10;
      }
      for (const [a, b] of GHOST_CONNECTIONS) {
        const ja = getJoint(frame, a);
        const jb = getJoint(frame, b);
        if (!ja || !jb) continue;
        ghostElements.push(
          <Line
            key={`g-${i}-${a}-${b}`}
            x1={tx(ja.x)} y1={ty(ja.y)}
            x2={tx(jb.x)} y2={ty(jb.y)}
            stroke={GHOST_TONE}
            strokeWidth={0.8}
            strokeLinecap="round"
            opacity={opacity}
          />,
        );
      }
    }

    // ── Continuous paths ─────────────────────────────────────────────
    const heroMapped = mapPts(wristTrail);
    const heroD = buildSmoothPath(heroMapped);
    const heroStart = heroMapped[0];
    const heroEnd = heroMapped[heroMapped.length - 1];

    const shoulderD = shoulderTrail.length >= 4
      ? buildSmoothPath(mapPts(shoulderTrail))
      : '';
    const hipD = hipTrail.length >= 4
      ? buildSmoothPath(mapPts(hipTrail))
      : '';

    return { ghostElements, heroD, heroStart, heroEnd, shoulderD, hipD };
  }, [frames, phases, size, pad]);

  if (!art) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Your Swing</Text>
      <View style={[styles.artContainer, { width: size, height: size }]}>
        <Svg width={size} height={size}>
          <Defs>
            <LinearGradient
              id="heroGrad"
              x1={art.heroStart.x.toString()}
              y1={art.heroStart.y.toString()}
              x2={art.heroEnd.x.toString()}
              y2={art.heroEnd.y.toString()}
              gradientUnits="userSpaceOnUse"
            >
              {HERO_GRADIENT.map((stop) => (
                <Stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
              ))}
            </LinearGradient>
            <LinearGradient
              id="heroGlow"
              x1={art.heroStart.x.toString()}
              y1={art.heroStart.y.toString()}
              x2={art.heroEnd.x.toString()}
              y2={art.heroEnd.y.toString()}
              gradientUnits="userSpaceOnUse"
            >
              {HERO_GRADIENT.map((stop) => (
                <Stop key={`glow-${stop.offset}`} offset={stop.offset} stopColor={stop.color} />
              ))}
            </LinearGradient>
          </Defs>

          {/* Layer 1: Ghost frame silhouettes */}
          <G>{art.ghostElements}</G>

          {/* Layer 2: Structural trails */}
          {art.shoulderD !== '' && (
            <Path
              d={art.shoulderD}
              stroke={SHOULDER_TONE}
              strokeWidth={1.0}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              opacity={0.25}
            />
          )}
          {art.hipD !== '' && (
            <Path
              d={art.hipD}
              stroke={HIP_TONE}
              strokeWidth={1.0}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              opacity={0.2}
            />
          )}

          {/* Layer 3: Hero underlay — soft halo */}
          <Path
            d={art.heroD}
            stroke="url(#heroGlow)"
            strokeWidth={10}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            opacity={0.10}
          />

          {/* Layer 4: Hero wrist trail — dominant continuous arc */}
          <Path
            d={art.heroD}
            stroke="url(#heroGrad)"
            strokeWidth={3.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 24,
    marginBottom: 12,
  },
  title: {
    color: '#666',
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginBottom: 12,
  },
  artContainer: {
    backgroundColor: '#08080A',
    borderRadius: 16,
    overflow: 'hidden',
    alignSelf: 'center',
  },
});
