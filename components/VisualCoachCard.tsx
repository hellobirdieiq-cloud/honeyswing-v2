import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import type { Landmark } from './SkeletonOverlay';
import type { GolfAngles } from '../packages/domain/swing/angles';
import { JOINT_CONFIDENCE_THRESHOLD } from '@/packages/domain/swing/captureValidity';
import { scoreAngle } from '../packages/domain/swing/scoring';
import { getCachedAgeTier } from '../lib/ageTier';
import { isMetricEligible } from '@/packages/domain/swing/tipFrequency';
import { METRIC_DEFINITIONS, type MetricKey } from '../packages/domain/swing/metricDefinitions';
import { GOLD } from '../lib/colors';

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



function scoreColor(score: number): string {
  if (score >= 80) return '#00FF66';
  if (score >= 50) return '#FFB020';
  return '#FF4444';
}

/** Each scoreable metric mapped to the skeleton segments it corresponds to. */

/**
 * Remap segment joint names from canonical space to the displayed REAL pose
 * (faithful-anatomical labels). Canonical space mirrors RIGHT-handed swings
 * (analysisPipeline mirrorToCanonical = !isLeftHanded), so for a righty the
 * canonical "leftElbow" metric is their anatomical RIGHT elbow → swap
 * left↔right. Lefty canonical = identity → no remap.
 */
function remapSegmentJoint(name: string, isLeftHanded: boolean): string {
  if (isLeftHanded) return name;
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
    if (lm.inFrameLikelihood >= JOINT_CONFIDENCE_THRESHOLD) {
      byName.set(lm.name, lm);
    }
  }

  // If too few joints passed confidence filter, don't render a big empty black box
  if (byName.size < 4) return null;

  const px = (lm: Landmark) => lm.x * width;
  const py = (lm: Landmark) => lm.y * height;

  // Score each metric — skip those suppressed by angle gating or ineligible for age tier
  const suppressedSet = new Set(suppressedMetrics);
  const ageTier = getCachedAgeTier();
  const scored: { key: MetricKey; score: number | null; value: number | null }[] = [];
  if (angles) {
    for (const labelKey of Object.keys(METRIC_DEFINITIONS) as MetricKey[]) {
      if (suppressedSet.has(labelKey)) continue;
      if (!isMetricEligible(labelKey, ageTier)) continue;
      const def = METRIC_DEFINITIONS[labelKey];
      const value = angles[labelKey];
      scored.push({
        key: labelKey,
        score: scoreAngle(value, def.ideal, def.underTolerance, def.overTolerance),
        value,
      });
    }
  }

  // Find the single worst metric (lowest score, but only if it has a real value AND a non-null score)
  const measured = scored.flatMap((s) =>
    s.value != null && s.score != null
      ? [{ key: s.key, score: s.score, value: s.value }]
      : []
  );
  const worst = measured.length > 0
    ? measured.reduce((min, s) => (s.score < min.score ? s : min), measured[0])
    : null;

  // Build set of highlighted segments — remap joint names for lefty display
  const highlightedSegments = new Set<string>();
  if (worst) {
    for (const [a, b] of METRIC_DEFINITIONS[worst.key].segments) {
      const ra = remapSegmentJoint(a, isLeftHanded);
      const rb = remapSegmentJoint(b, isLeftHanded);
      // Insert both orderings: the LH remap of a bilateral-pair single segment
      // (e.g. shoulderTilt's [leftShoulder, rightShoulder]) reverses the tuple
      // order, but SKELETON_CONNECTIONS draws it in the original order. Both
      // orderings guarantees the highlight lookup matches either direction.
      highlightedSegments.add(`${ra}-${rb}`);
      highlightedSegments.add(`${rb}-${ra}`);
    }
  }

  const dimColor = '#335544';
  const highlightColor = worst ? scoreColor(worst.score) : '#00FF66';

  const worstDef = worst ? METRIC_DEFINITIONS[worst.key] : null;
  const coachCue = worst && worstDef && worst.value != null
    ? worstDef.cue(worst.value, worstDef.ideal, getCachedAgeTier())
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
    color: GOLD,
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
