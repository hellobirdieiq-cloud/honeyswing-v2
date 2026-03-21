import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import type { Landmark } from './SkeletonOverlay';
import type { GolfAngles } from '../packages/domain/swing/angles';

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

/** Replicates scoreAngle from scoring.ts — no new logic. */
function scoreAngle(value: number | null, ideal: number, tolerance: number): number {
  if (value == null) return 50;
  const diff = Math.abs(value - ideal);
  const raw = 100 - (diff / tolerance) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

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
    cue: (v, i) => v > i ? 'Stand more upright — less forward lean.' : 'Add a bit more forward tilt.',
  },
  leftElbowAngle: {
    segments: [['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist']],
    ideal: 165, tolerance: 40,
    label: 'Lead elbow',
    cue: (v, i) => v < i ? 'Keep your lead arm straighter.' : 'Slight bend is fine — avoid locking out.',
  },
  rightElbowAngle: {
    segments: [['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist']],
    ideal: 165, tolerance: 40,
    label: 'Trail elbow',
    cue: (v, i) => v < i ? 'Extend your trail arm more.' : 'Slight bend is fine — avoid locking out.',
  },
  leftKneeAngle: {
    segments: [['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle']],
    ideal: 155, tolerance: 35,
    label: 'Lead knee',
    cue: (v, i) => v < i ? 'Less knee bend — stay athletic, not crouched.' : 'Soften your lead knee slightly.',
  },
  rightKneeAngle: {
    segments: [['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle']],
    ideal: 155, tolerance: 35,
    label: 'Trail knee',
    cue: (v, i) => v < i ? 'Less knee bend on the trail side.' : 'Soften your trail knee slightly.',
  },
  shoulderTilt: {
    segments: [['leftShoulder', 'rightShoulder']],
    ideal: 0, tolerance: 25,
    label: 'Shoulder tilt',
    cue: () => 'Level your shoulders more at address.',
  },
};

interface Props {
  landmarks: Landmark[];
  angles: GolfAngles | undefined;
  width: number;
  height: number;
  isLowConfidence: boolean;
}

export default function VisualCoachCard({ landmarks, angles, width, height, isLowConfidence }: Props) {
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

  // Score each metric using existing scoring logic
  const scored: { key: MetricKey; score: number; value: number | null }[] = [];
  if (angles) {
    for (const key of Object.keys(METRICS) as MetricKey[]) {
      const def = METRICS[key];
      const value = angles[key];
      scored.push({ key, score: scoreAngle(value, def.ideal, def.tolerance), value });
    }
  }

  // Find the single worst metric (lowest score, but only if it has a real value)
  const withValues = scored.filter((s) => s.value != null);
  const worst = withValues.length > 0
    ? withValues.reduce((min, s) => (s.score < min.score ? s : min), withValues[0])
    : null;

  // Build set of highlighted segments
  const highlightedSegments = new Set<string>();
  if (worst) {
    for (const seg of METRICS[worst.key].segments) {
      highlightedSegments.add(`${seg[0]}-${seg[1]}`);
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
      <Text style={styles.cardTitle}>Here's what to work on</Text>

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
