import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Line, G, Defs, LinearGradient, Stop } from 'react-native-svg';
import type { PoseFrame, JointName, NormalizedJoint } from '../packages/pose/PoseTypes';
import type { DetectedPhase } from '../packages/domain/swing/phaseDetection';

// ── Color palette ────────────────────────────────────────────────────
const HERO_GRADIENT = [
  { offset: '0%', color: '#4A7CF7' },   // cool blue — setup
  { offset: '20%', color: '#3BC4C4' },  // teal — takeaway
  { offset: '40%', color: '#44CC88' },  // green — top
  { offset: '60%', color: '#F5A623' },  // amber — transition
  { offset: '80%', color: '#FF6B35' },  // hot orange — impact
  { offset: '100%', color: '#C850C0' }, // violet — follow-through
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

// ── Temporal smoothing (moving average) ──────────────────────────────
function smoothTrail(
  pts: { x: number; y: number }[],
  window: number = 5,
): { x: number; y: number }[] {
  if (pts.length < 3) return pts;
  const half = Math.floor(window / 2);
  return pts.map((_, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(pts.length - 1, i + half);
    let sx = 0, sy = 0, count = 0;
    for (let j = start; j <= end; j++) {
      sx += pts[j].x;
      sy += pts[j].y;
      count++;
    }
    return { x: sx / count, y: sy / count };
  });
}

// ── ONE continuous smooth SVG path (quadratic Bezier) ────────────────
function buildSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  const f = (n: number) => n.toFixed(1);
  let d = `M ${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const mx = (prev.x + curr.x) / 2;
    const my = (prev.y + curr.y) / 2;
    d += ` Q ${f(prev.x)} ${f(prev.y)} ${f(mx)} ${f(my)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${f(last.x)} ${f(last.y)}`;
  return d;
}

// ── Ghost frame connections: torso silhouette only ───────────────────
const GHOST_CONNECTIONS: [JointName, JointName][] = [
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
];

// ── Props ────────────────────────────────────────────────────────────
interface Props {
  frames: PoseFrame[];
  phases: DetectedPhase[];
  width: number;
}

export default function SwingArtCard({ frames, phases, width }: Props) {
  const size = width;
  const pad = size * 0.05; // tight padding — fill the card

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
    const wristTrail = smoothTrail(rawWrist, 5);
    const shoulderTrail = smoothTrail(rawShoulder, 7);
    const hipTrail = smoothTrail(rawHip, 7);

    // ── Bounds from hero + structural trails ONLY (not ghosts) ───────
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

    // ── Ghost frames: ~16, torso only, single muted color ────────────
    const ghostElements: React.ReactElement[] = [];
    const ghostStep = Math.max(1, Math.ceil(frames.length / 16));
    for (let i = 0; i < frames.length; i += ghostStep) {
      const frame = frames[i];
      let opacity = 0.04;
      if (impactTs != null) {
        const dist = Math.abs(frame.timestampMs - impactTs) / duration;
        if (dist < 0.08) opacity = 0.07;
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
            strokeWidth={0.6}
            strokeLinecap="round"
            opacity={opacity}
          />,
        );
      }
    }

    // ── ONE continuous hero path ─────────────────────────────────────
    const heroMapped = mapPts(wristTrail);
    const heroD = buildSmoothPath(heroMapped);

    // Compute gradient direction from first to last point for natural flow
    const heroStart = heroMapped[0];
    const heroEnd = heroMapped[heroMapped.length - 1];

    // ── Structural trails: ONE continuous path each ──────────────────
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
          </Defs>

          {/* Layer 1: Ghost frame silhouettes */}
          <G>{art.ghostElements}</G>

          {/* Layer 2: Structural trails — solid, muted, continuous */}
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

          {/* Layer 3: Hero wrist trail — ONE continuous gradient arc */}
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
