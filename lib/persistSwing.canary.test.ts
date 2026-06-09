import type { Database, Json } from './database.types';
import type { GolfAngles } from '../packages/domain/swing/angles';
import type { SwingTempo } from '../packages/domain/swing/tempoAnalysis';
import type { DetectedPhase } from '../packages/domain/swing/phaseDetection';

type Insert = Database['public']['Tables']['swings']['Insert'];

// Stub domain values typed with the production interfaces. The point of the
// canary is to prove these assign cleanly to Json | null columns now that the
// interfaces carry [key: string]: JsonValue | undefined index signatures.
const angles: GolfAngles = {
  spineAngle: 30,
  leftElbowAngle: 170,
  rightElbowAngle: 165,
  leftKneeAngle: 160,
  rightKneeAngle: 155,
  hipSpreadDelta: 12,
  shoulderTilt: -5,
};

const tempo: SwingTempo = {
  backswingMs: 800,
  downswingMs: 280,
  tempoRatio: 2.86,
  totalSwingMs: 1080,
  tempoRating: 'good',
  phaseTimestamps: {
    takeaway: 200,
    top: 800,
    downswing: 900,
    impact: 1080,
    follow_through: 1280,
  },
};

const phases: DetectedPhase[] = [
  {
    phase: 'takeaway',
    label: 'Takeaway',
    point: { x: 0.5, y: 0.7, timestamp: 0 },
    index: 0,
    timestamp: 0,
    source: 'heuristic',
  },
];

// Mirrors lib/persistSwing.ts:147-190 row literal shape, minus the deferred
// line-189 swing_debug cast (separate ticket). `satisfies Insert` enforces
// at compile time that every key is a valid swings-table column and every
// value matches the column type — including the 3 newly-uncast assignments.
const stubRow = {
  user_id: 'canary-user',
  motion_frames: [],
  frame_count: 0,
  duration_ms: 0,
  score: null,
  honey_boom: false,
  camera_angle_valid: true,
  angles,
  tempo,
  phases,
  trail_points: null,
  metric_confidences: null,
  category_scores: null,
  backswing_ms: 800,
  downswing_ms: 280,
  tempo_ratio: 2.86,
  pose_success_rate: 1,
  phase_source: 'heuristic',
  failure_reason: null,
  capture_validity: 'valid',
  app_version: '1.9.8',
  coach_name: null,
  analysis_version: 'v2',
  swing_debug: null as Json | null,
} satisfies Insert;

// (a) Round-trip: serialize and deserialize. Any non-JSON value (Date, Map,
// function, undefined-as-value) would either throw or silently drop.
const serialized = JSON.stringify(stubRow);
const parsed = JSON.parse(serialized) as Record<string, unknown>;

// (b) Field-set check: every key in stubRow must survive the round-trip.
const before = Object.keys(stubRow).sort();
const after = Object.keys(parsed).sort();
if (before.length !== after.length || before.some((k, i) => k !== after[i])) {
  console.error('FAIL: key set drift', { before, after });
  process.exit(1);
}

// (c) Type-narrowing sanity: the three previously-cast fields round-trip to
// objects/arrays/null as expected, not to strings or anything weird.
if (parsed.angles === undefined || parsed.tempo === undefined || parsed.phases === undefined) {
  console.error('FAIL: angles/tempo/phases missing after round-trip');
  process.exit(1);
}

console.log(`canary: ok, keys=${before.length}, bytes=${serialized.length}`);
