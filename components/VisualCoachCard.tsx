import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import type { Landmark } from './SkeletonOverlay';
import type { GolfAngles } from '../packages/domain/swing/angles';
import { scoreAngle } from '../packages/domain/swing/scoring';
import { getCachedAgeTier } from '../lib/ageTier';

/** Same skeleton connections as SkeletonOverlay. */
const SKELETON_CONNECTIONS: [string, string][] = [
  // face
  ['leftEyeInner', 'leftEye'],
  ['leftEye', 'leftEyeOuter'],
  ['rightEyeInner', 'rightEye'],
  ['rightEye', 'rightEyeOuter'],
  ['mouthLeft', 'mouthRight'],
  // head → shoulders
  ['nose', 'leftShoulder'],
  ['nose', 'rightShoulder'],
  // torso
  ['leftShoulder', 'rightShoulder'],
  ['leftShoulder', 'leftHip'],
  ['rightShoulder', 'rightHip'],
  ['leftHip', 'rightHip'],
  // left arm + hand
  ['leftShoulder', 'leftElbow'],
  ['leftElbow', 'leftWrist'],
  ['leftWrist', 'leftThumb'],
  ['leftWrist', 'leftIndex'],
  ['leftWrist', 'leftPinky'],
  // right arm + hand
  ['rightShoulder', 'rightElbow'],
  ['rightElbow', 'rightWrist'],
  ['rightWrist', 'rightThumb'],
  ['rightWrist', 'rightIndex'],
  ['rightWrist', 'rightPinky'],
  // left leg + foot
  ['leftHip', 'leftKnee'],
  ['leftKnee', 'leftAnkle'],
  ['leftAnkle', 'leftHeel'],
  ['leftAnkle', 'leftFootIndex'],
  ['leftHeel', 'leftFootIndex'],
  // right leg + foot
  ['rightHip', 'rightKnee'],
  ['rightKnee', 'rightAnkle'],
  ['rightAnkle', 'rightHeel'],
  ['rightAnkle', 'rightFootIndex'],
  ['rightHeel', 'rightFootIndex'],
];

const MIN_CONFIDENCE = 0.3;

function scoreColor(score: number): string {
  if (score >= 80) return '#00FF66';
  if (score >= 50) return '#FFB020';
  return '#FF4444';
}

/** Each scoreable metric mapped to the skeleton segments it corresponds to. */
type MetricKey = 'spineAngle' | 'leftElbowAngle' | 'rightElbowAngle' | 'leftKneeAngle' | 'rightKneeAngle' | 'shoulderTilt';

interface MetricDef {
  segments: [string, string][];
  ideal: number;
  tolerance: number;
  label: string;
  cue: (value: number, ideal: number) => string;
}

const METRICS: Record<MetricKey, MetricDef> = {
  spineAngle: {
    segments: [['leftShoulder', 'leftHip'], ['rightShoulder', 'rightHip']],
    ideal: 35, tolerance: 20,
    label: 'Spine tilt',
    cue: (v, i) => {
      const junior = getCachedAgeTier() === 'junior';
      if (v > i) return junior ? 'Try standing a bit taller' : 'You\'re leaning too far forward at address — stand a bit taller';
      return junior ? 'Bend forward just a little' : 'A bit more forward tilt at setup — you\'re standing too upright';
    },
  },
  leftElbowAngle: {
    segments: [['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist']],
    ideal: 165, tolerance: 40,
    label: 'Lead arm',
    cue: (v, i) => {
      const junior = getCachedAgeTier() === 'junior';
      if (v < i) return junior ? 'Keep your front arm straighter' : 'Your lead arm is too bent through the swing — try to keep it straighter';
      return junior ? 'Bend your front arm a tiny bit' : 'Your lead arm is locking out — keep a slight bend through impact';
    },
  },
  rightElbowAngle: {
    segments: [['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist']],
    ideal: 165, tolerance: 40,
    label: 'Trail arm',
    cue: (v, i) => {
      const junior = getCachedAgeTier() === 'junior';
      if (v < i) return junior ? 'Stretch your back arm out more' : 'Your trail elbow is too bent at the top — extend it more';
      return junior ? 'Let your back arm bend a little' : 'Your trail arm is too straight — let it fold naturally at the top';
    },
  },
  leftKneeAngle: {
    segments: [['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle']],
    ideal: 155, tolerance: 35,
    label: 'Lead knee',
    cue: (v, i) => {
      const junior = getCachedAgeTier() === 'junior';
      if (v < i) return junior ? 'Stand a little taller in your legs' : 'Too much knee bend at setup — stay athletic, not crouched';
      return junior ? 'Bend your front knee a tiny bit' : 'Soften your lead knee at address — a little flex helps your turn';
    },
  },
  rightKneeAngle: {
    segments: [['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle']],
    ideal: 155, tolerance: 35,
    label: 'Trail knee',
    cue: (v, i) => {
      const junior = getCachedAgeTier() === 'junior';
      if (v < i) return junior ? 'Stand a little taller in your legs' : 'Your trail knee is too bent at setup — straighten up a little';
      return junior ? 'Bend your back knee a tiny bit' : 'Soften your trail knee at address — stay ready to rotate';
    },
  },
  shoulderTilt: {
    segments: [['leftShoulder', 'rightShoulder']],
    ideal: 0, tolerance: 25,
    label: 'Shoulders',
    cue: (v) => {
      const junior = getCachedAgeTier() === 'junior';
      if (v > 0) return junior ? 'Try to keep your shoulders even' : 'Your lead shoulder is too high at address — try to level them';
      return junior ? 'Try to keep your shoulders even' : 'Your trail shoulder is too high at address — try to level them';
    },
  },
};

/**
 * Remap segment joint names for lefty skeleton highlight.
 * The skeleton shows REAL pose (not canonical). For a lefty, the canonical
 * "leftElbow" (lead arm) is their anatomical RIGHT elbow. Swap left↔right
 * so the highlight lands on the correct physical joint.
 */
function remapSegmentJoint(name: string, isLeftHanded: boolean): string {
  if (!isLeftHanded) return name;
  if (name.startsWith('left')) return 'right' + name.slice(4);
  if (name.startsWith('right')) return 'left' + name.slice(5);
  return name;
}

interface Props {
  landmarks: Landmark[];
  angles: GolfAngles | undefined;
  width: number;
  height: number;
  isLowConfidence: boolean;
  isLeftHanded?: boolean;
  /** Metric keys suppressed by angle gating (unreliable at this camera angle). */
  suppressedMetrics?: readonly string[];
}

export default function VisualCoachCard({ landmarks, angles, width, height, isLowConfidence, isLeftHanded = false, suppressedMetrics = [] }: Props) {
  if (landmarks.length === 0 || width === 0 || height === 0) return null;

  // Build joint lookup
  const byName = new Map<string, Landmark>();
  for (const lm of landmarks) {
    if (lm.inFrameLikelihood >= MIN_CONFIDENCE) {
      byName.set(lm.name, lm);
    }
  }

  // If too few joints passed confidence filter, don't render a big empty black box
  if (byName.size < 4) return null;

  const px = (lm: Landmark) => lm.x * width;
  const py = (lm: Landmark) => lm.y * height;

  // Score each metric — skip those suppressed by angle gating
  const suppressedSet = new Set(suppressedMetrics);
  const scored: { key: MetricKey; score: number; value: number | null }[] = [];
  if (angles) {
    for (const labelKey of Object.keys(METRICS) as MetricKey[]) {
      if (suppressedSet.has(labelKey)) continue;
      const def = METRICS[labelKey];
      const value = angles[labelKey];
      scored.push({ key: labelKey, score: scoreAngle(value, def.ideal, def.tolerance), value });
    }
  }

  // Find the single worst metric (lowest score, but only if it has a real value)
  const withValues = scored.filter((s) => s.value != null);
  const worst = withValues.length > 0
    ? withValues.reduce((min, s) => (s.score < min.score ? s : min), withValues[0])
    : null;

  // Build set of highlighted segments — remap joint names for lefty display
  const highlightedSegments = new Set<string>();
  if (worst) {
    for (const [a, b] of METRICS[worst.key].segments) {
      const ra = remapSegmentJoint(a, isLeftHanded);
      const rb = remapSegmentJoint(b, isLeftHanded);
      highlightedSegments.add(`${ra}-${rb}`);
    }
  }

  const dimColor = '#335544';
  const highlightColor = worst ? scoreColor(worst.score) : '#00FF66';

  const worstDef = worst ? METRICS[worst.key] : null;
  const coachCue = worst && worstDef && worst.value != null
    ? worstDef.cue(worst.value, worstDef.ideal)
    : null;

  return (
    <View style={[styles.card, isLowConfidence && styles.lowConf]}>
      <Text style={styles.cardTitle}>Here&apos;s what to work on</Text>

      <View style={[styles.skeletonContainer, { width, height }]}>
        <Svg width={width} height={height}>
          {SKELETON_CONNECTIONS.map(([a, b]) => {
            const ja = byName.get(a);
            const jb = byName.get(b);
            if (!ja || !jb) return null;
            const segKey = `${a}-${b}`;
            const isHighlighted = highlightedSegments.has(segKey);
            return (
              <Line
                key={segKey}
                x1={px(ja)} y1={py(ja)}
                x2={px(jb)} y2={py(jb)}
                stroke={isHighlighted ? highlightColor : dimColor}
                strokeWidth={isHighlighted ? 5 : 3}
                strokeLinecap="round"
              />
            );
          })}
          {Array.from(byName.values()).map((lm) => (
            <Circle
              key={lm.name}
              cx={px(lm)} cy={py(lm)}
              r={5}
              fill={dimColor}
            />
          ))}
        </Svg>
      </View>

      {worst && worstDef && (
        <View style={styles.issueRow}>
          <View style={[styles.issueDot, { backgroundColor: highlightColor }]} />
          <View style={styles.issueText}>
            <Text style={[styles.issueLabel, { color: highlightColor }]}>
              {worstDef.label}
            </Text>
            {coachCue && <Text style={styles.issueCue}>{coachCue}</Text>}
          </View>
        </View>
      )}

      {isLowConfidence && (
        <Text style={styles.lowConfText}>Short capture — results may vary</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1A1A1C',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
  },
  lowConf: {
    opacity: 0.6,
  },
  cardTitle: {
    color: '#F5A623',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  skeletonContainer: {
    backgroundColor: '#000',
    borderRadius: 10,
    overflow: 'hidden',
    alignSelf: 'center',
  },
  issueRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 12,
  },
  issueDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 4,
    marginRight: 10,
  },
  issueText: {
    flex: 1,
  },
  issueLabel: {
    fontSize: 15,
    fontWeight: '700',
  },
  issueCue: {
    color: '#ccc',
    fontSize: 14,
    marginTop: 2,
    lineHeight: 20,
  },
  lowConfText: {
    color: '#999',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
    fontStyle: 'italic',
  },
});
