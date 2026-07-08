import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Path, Line, G, Defs, LinearGradient, Stop } from 'react-native-svg';
import type { PoseFrame, JointName, NormalizedJoint } from '../packages/pose/PoseTypes';
import type { DetectedPhase } from '../packages/domain/swing/phaseDetection';
import { GOLD } from '../lib/colors';

// ═══════════════════════════════════════════════════════════════════════
// SWING ART V2 — validated visual recipe (speed→width, impact-proximity
// color, single soft glow). Flip SWING_ART_V2 to false for one-line rollback
// to the legacy renderer below (kept fully intact behind the flag).
// ═══════════════════════════════════════════════════════════════════════
// Annotated `: boolean` (not literal `true`) so the type checker keeps BOTH
// render paths live — flipping to false is a genuine one-line rollback and the
// legacy helpers below never read as dead/unused.
const SWING_ART_V2: boolean = true;

const V2 = {
  // speed → width (computed in normalized space on the smoothed trail)
  EMA_ALPHA: 0.85,        // ema = ALPHA*prev + (1-ALPHA)*cur (heavy smoothing)
  SPEED_POW: 0.3,
  WIDTH_MIN_FRAC: 5.5 / 900, // fractions of card size (900px reference canvas)
  WIDTH_MAX_FRAC: 33 / 900,
  // impact-proximity color: BASE everywhere, blending to IGNITE near impact
  BASE_COLOR: '#FF6B00',
  IGNITE_COLOR: '#FFF3D0',
  IGNITE_WINDOW_FRAC: 0.06,  // half-window = duration * this, in ms
  IGNITE_POW: 1.2,
  // glow (single pass under the opaque core)
  GLOW_WIDTH_MULT: 1.44,
  GLOW_OPACITY: 0.04,
  GLOW_ON_THUMB: false,      // drop glow on small gallery thumbnails (perf)
  // segmentation / downsampling caps
  SEG_CAP_THUMB: 90,
  SEG_CAP_FULL: 180,
  THUMB_SIZE_THRESHOLD: 260, // card width below this = thumbnail
} as const;

type RGB = { r: number; g: number; b: number };

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToCss(c: RGB): string {
  return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

/** One cubic-Bézier segment `M p1 C cp1 cp2 p2` using Catmull-Rom control
 *  points (±(neighbor delta)/6), matching buildSmoothPath's per-segment math.
 *  p0/p3 are the clamped neighbors of the p1→p2 segment. */
function catmullRomSegment(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): string {
  const f = (n: number) => n.toFixed(1);
  const cp1x = p1.x + (p2.x - p0.x) / 6;
  const cp1y = p1.y + (p2.y - p0.y) / 6;
  const cp2x = p2.x - (p3.x - p1.x) / 6;
  const cp2y = p2.y - (p3.y - p1.y) / 6;
  return `M ${f(p1.x)} ${f(p1.y)} C ${f(cp1x)} ${f(cp1y)} ${f(cp2x)} ${f(cp2y)} ${f(p2.x)} ${f(p2.y)}`;
}

// ── Color palette ────────────────────────────────────────────────────
const HERO_GRADIENT = [
  { offset: '0%', color: '#4A7CF7' },
  { offset: '25%', color: '#3BC4C4' },
  { offset: '45%', color: '#44CC88' },
  { offset: '65%', color: GOLD },
  { offset: '82%', color: '#FF6B35' },
  { offset: '100%', color: '#C850C0' },
];

const GHOST_TONE = '#1E2A38';
const IMPACT_COLOR = '#FFF0D0';

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

/** Trim the tail of a trail where velocity drops below threshold (deceleration). */
function trimDeceleration(
  pts: { x: number; y: number }[],
  tailFraction: number = 0.3,
): { x: number; y: number }[] {
  if (pts.length < 10) return pts;
  // Only consider the last tailFraction of points for trimming
  const searchStart = Math.floor(pts.length * (1 - tailFraction));
  // Find where velocity drops significantly
  let trimIdx = pts.length;
  for (let i = pts.length - 1; i > searchStart; i--) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const vel = Math.sqrt(dx * dx + dy * dy);
    if (vel > 0.002) { // still meaningful movement
      trimIdx = Math.min(pts.length, i + 2); // keep a tiny tail past last movement
      break;
    }
  }
  return pts.slice(0, trimIdx);
}

// ── Smooth SVG path (cubic Bezier with Catmull-Rom) ──────────────────
function buildSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  const f = (n: number) => n.toFixed(1);
  if (points.length === 2) {
    return `M ${f(points[0].x)} ${f(points[0].y)} L ${f(points[1].x)} ${f(points[1].y)}`;
  }
  let d = `M ${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${f(cp1x)} ${f(cp1y)} ${f(cp2x)} ${f(cp2y)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}

// ── Ghost frame connections ──────────────────────────────────────────
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

// ── Swing Art V2 compute ─────────────────────────────────────────────
type V2Segment = { d: string; w: number; color: string };
type V2Art = { mode: 'v2'; segments: V2Segment[]; drawGlow: boolean };

/** Build the V2 variable-width, impact-colored segment list from a swing's
 *  motion frames. Trail extraction/smoothing is identical to V1; V2 adds
 *  per-point speed→width and impact-proximity color, then downsamples to a
 *  per-card segment cap. Returns null for too-short / degenerate swings. */
function computeV2Art(
  frames: PoseFrame[],
  phases: DetectedPhase[],
  size: number,
  pad: number,
): V2Art | null {
  if (frames.length < 6) return null;

  // ── Raw wrist trail + per-point timestamps ──────────────────────────
  const rawXY: { x: number; y: number }[] = [];
  const rawTs: number[] = [];
  for (const frame of frames) {
    const w = midpointOf(frame, 'leftWrist', 'rightWrist');
    if (w) {
      rawXY.push(w);
      rawTs.push(frame.timestampMs);
    }
  }
  if (rawXY.length < 4) return null;

  // Smooth positions (count/order preserved → timestamps ride along by
  // index); trimDeceleration only trims the tail, so slice ts the same.
  const smoothed = smoothTrail(rawXY, 7, 2);
  const points = trimDeceleration(smoothed);
  const n = points.length;
  if (n < 2) return null;
  const pointTs = rawTs.slice(0, n);

  // ── Fit-to-square bounds (same transform as V1) ─────────────────────
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
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
  const mapped = points.map((p) => ({
    x: offX + (p.x - minX) * scale,
    y: offY + (p.y - minY) * scale,
  }));

  // ── Speed → width (normalized space, EMA, normalize by max, pow) ─────
  const speed = new Array<number>(n);
  speed[0] = 0;
  for (let i = 1; i < n; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    speed[i] = Math.sqrt(dx * dx + dy * dy);
  }
  const ema = new Array<number>(n);
  ema[0] = speed[0];
  for (let i = 1; i < n; i++) {
    ema[i] = V2.EMA_ALPHA * ema[i - 1] + (1 - V2.EMA_ALPHA) * speed[i];
  }
  let maxEma = 0;
  for (let i = 0; i < n; i++) if (ema[i] > maxEma) maxEma = ema[i];
  const widthPx = ema.map((e) => {
    const sN = maxEma > 0 ? e / maxEma : 0;
    const shaped = Math.pow(sN, V2.SPEED_POW);
    return lerp(V2.WIDTH_MIN_FRAC, V2.WIDTH_MAX_FRAC, shaped) * size;
  });

  // ── Impact-proximity color per point ────────────────────────────────
  const impactT = phases.find((p) => p.phase === 'impact')?.timestamp ?? null;
  // Full-swing duration (not just the trimmed trail span) — matches the
  // playground denominator and is stable when low-confidence lead/tail frames
  // are dropped from the trail.
  const duration =
    (frames[frames.length - 1].timestampMs - frames[0].timestampMs) || 1;
  const half = duration * V2.IGNITE_WINDOW_FRAC;
  const base = hexToRgb(V2.BASE_COLOR);
  const ignite = hexToRgb(V2.IGNITE_COLOR);
  const colorRgb: RGB[] = pointTs.map((t) => {
    if (impactT == null || half <= 0) return base;
    const f = Math.pow(Math.max(0, 1 - Math.abs(t - impactT) / half), V2.IGNITE_POW);
    return lerpRgb(base, ignite, f);
  });

  // ── Downsample to per-card knot cap (keep endpoints + impact peak) ──
  const cap = size < V2.THUMB_SIZE_THRESHOLD ? V2.SEG_CAP_THUMB : V2.SEG_CAP_FULL;
  const stride = Math.max(1, Math.ceil((n - 1) / cap));
  const idxSet = new Set<number>();
  for (let i = 0; i < n; i += stride) idxSet.add(i);
  idxSet.add(n - 1);
  if (impactT != null) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(pointTs[i] - impactT);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    idxSet.add(bestIdx);
  }
  const knotIdx = Array.from(idxSet).sort((a, b) => a - b);
  const K = knotIdx.length;
  if (K < 2) return null;

  const kPts = knotIdx.map((i) => mapped[i]);
  const kW = knotIdx.map((i) => widthPx[i]);
  const kColor = knotIdx.map((i) => colorRgb[i]);

  // ── Segments: one Catmull-Rom cubic per knot pair ───────────────────
  const segments: V2Segment[] = [];
  for (let j = 0; j < K - 1; j++) {
    const p0 = kPts[Math.max(j - 1, 0)];
    const p1 = kPts[j];
    const p2 = kPts[j + 1];
    const p3 = kPts[Math.min(j + 2, K - 1)];
    segments.push({
      d: catmullRomSegment(p0, p1, p2, p3),
      w: (kW[j] + kW[j + 1]) / 2,
      color: rgbToCss(lerpRgb(kColor[j], kColor[j + 1], 0.5)),
    });
  }

  const drawGlow = size >= V2.THUMB_SIZE_THRESHOLD || V2.GLOW_ON_THUMB;
  return { mode: 'v2', segments, drawGlow };
}

interface Props {
  frames: PoseFrame[];
  phases: DetectedPhase[];
  width: number;
  /** Show the "Your Swing" caption above the art. Default true. The gallery
   *  grid passes false so the label isn't repeated across every cell. */
  showLabel?: boolean;
}

export default function SwingArtCard({ frames, phases, width, showLabel = true }: Props) {
  const size = width;
  const pad = size * 0.03;

  const art = useMemo(() => {
    if (SWING_ART_V2) return computeV2Art(frames, phases, size, pad);
    if (frames.length < 6) return null;

    // ── Extract raw wrist trail ──────────────────────────────────────
    const rawWrist: { x: number; y: number }[] = [];
    for (const frame of frames) {
      const w = midpointOf(frame, 'leftWrist', 'rightWrist');
      if (w) rawWrist.push(w);
    }
    if (rawWrist.length < 4) return null;

    // ── Smooth, then trim deceleration tail ──────────────────────────
    const smoothed = smoothTrail(rawWrist, 7, 2);
    const wristTrail = trimDeceleration(smoothed);

    // ── Bounds from HERO trail only ──────────────────────────────────
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of wristTrail) {
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

    // ── Impact / timing ──────────────────────────────────────────────
    const impactPhase = phases.find((p) => p.phase === 'impact');
    const impactTs = impactPhase?.timestamp ?? null;
    const firstTs = frames[0].timestampMs;
    const lastTs = frames[frames.length - 1].timestampMs;
    const duration = lastTs - firstTs || 1;

    // ── Ghost frames ─────────────────────────────────────────────────
    const ghostElements: React.ReactElement[] = [];
    const ghostStep = Math.max(1, Math.ceil(frames.length / 18));
    for (let i = 0; i < frames.length; i += ghostStep) {
      const frame = frames[i];
      let opacity = 0.07;
      if (impactTs != null) {
        const dist = Math.abs(frame.timestampMs - impactTs) / duration;
        if (dist < 0.10) opacity = 0.13;
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

    // ── Hero path ────────────────────────────────────────────────────
    const heroMapped = mapPts(wristTrail);
    const heroD = buildSmoothPath(heroMapped);
    const heroStart = heroMapped[0];
    const heroEnd = heroMapped[heroMapped.length - 1];

    // ── Impact accent: tight bright segment at the climax ────────────
    let impactD = '';
    if (impactTs != null && wristTrail.length > 4) {
      const impactProgress = (impactTs - firstTs) / duration;
      const impactIdx = Math.round(impactProgress * (wristTrail.length - 1));
      const windowSize = Math.max(2, Math.round(wristTrail.length * 0.06));
      const startIdx = Math.max(0, impactIdx - windowSize);
      const endIdx = Math.min(wristTrail.length - 1, impactIdx + windowSize);
      if (endIdx - startIdx >= 2) {
        impactD = buildSmoothPath(heroMapped.slice(startIdx, endIdx + 1));
      }
    }

    return { mode: 'v1' as const, ghostElements, heroD, heroStart, heroEnd, impactD };
  }, [frames, phases, size, pad]);

  if (!art) return null;

  // ── Swing Art V2 render ────────────────────────────────────────────
  if (art.mode === 'v2') {
    return (
      <View style={styles.card}>
        {showLabel && <Text style={styles.title}>Your Swing</Text>}
        <View style={[styles.artContainer, { width: size, height: size }]}>
          <Svg width={size} height={size}>
            {/* Glow: single soft pass under the core (dropped on thumbnails) */}
            {art.drawGlow && (
              <G>
                {art.segments.map((s, i) => (
                  <Path
                    key={`glow-${i}`}
                    d={s.d}
                    stroke={s.color}
                    strokeWidth={s.w * V2.GLOW_WIDTH_MULT}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                    opacity={V2.GLOW_OPACITY}
                  />
                ))}
              </G>
            )}
            {/* Core: opaque variable-width, impact-colored ribbon */}
            <G>
              {art.segments.map((s, i) => (
                <Path
                  key={`core-${i}`}
                  d={s.d}
                  stroke={s.color}
                  strokeWidth={s.w}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              ))}
            </G>
          </Svg>
        </View>
      </View>
    );
  }

  // ── Legacy render (SWING_ART_V2 = false) ───────────────────────────
  return (
    <View style={styles.card}>
      {showLabel && <Text style={styles.title}>Your Swing</Text>}
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

          {/* Layer 1: Ghost silhouettes */}
          <G>{art.ghostElements}</G>

          {/* Layer 2: Hero ultra-soft outer glow */}
          <Path
            d={art.heroD}
            stroke="url(#heroGrad)"
            strokeWidth={22}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            opacity={0.04}
          />

          {/* Layer 3: Hero soft inner glow */}
          <Path
            d={art.heroD}
            stroke="url(#heroGrad)"
            strokeWidth={10}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            opacity={0.12}
          />

          {/* Layer 4: Hero arc — dominant */}
          <Path
            d={art.heroD}
            stroke="url(#heroGrad)"
            strokeWidth={4.0}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />

          {/* Layer 5: Impact accent — the moment */}
          {art.impactD !== '' && (
            <>
              <Path
                d={art.impactD}
                stroke={IMPACT_COLOR}
                strokeWidth={7}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                opacity={0.10}
              />
              <Path
                d={art.impactD}
                stroke={IMPACT_COLOR}
                strokeWidth={5.0}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                opacity={0.45}
              />
            </>
          )}
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
