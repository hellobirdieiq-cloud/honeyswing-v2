/**
 * phaseDetection.ts — angle-aware phase detection dispatcher.
 *
 * Public surface is unchanged for back-compat: existing call sites that
 * pass only `trail` continue to work and route to the legacy detector.
 * The angle-aware path is opted into by passing `{ canonical, trail,
 * angle, msPerFrame }` to `detectSwingPhasesWithDebug` — the
 * `analysisPipeline.ts` call site does this after running the early-frame
 * camera angle pre-detector.
 *
 * Rules per camera angle: docs/HoneySwing_Phase_Detection_Rules.md.
 *   - "dtl"     → packages/domain/swing/phaseDetectionDTL.ts
 *   - "face_on" → packages/domain/swing/phaseDetectionFaceOn.ts
 *   - "unknown" → packages/domain/swing/phaseDetectionLegacy.ts
 */

import type { PoseSequence } from "../../pose/PoseTypes";
import type { CameraAngle } from "./cameraAngle";
import type { JsonValue } from "./jsonTypes";
import { detectDTLPhases } from "./phaseDetectionDTL";
import { detectFaceOnPhases } from "./phaseDetectionFaceOn";
import { detectLegacyPhases, detectImpactLegacy } from "./phaseDetectionLegacy";
import {
  emptyReliability,
  msPerFrameFromTrail,
  type PhaseRuleDebug,
} from "./phaseDetectionShared";

// ---------------------------------------------------------------------------
// Types — preserved verbatim so external importers don't break
// ---------------------------------------------------------------------------

export type SwingPhase =
  | "takeaway"
  | "top"
  | "downswing"
  | "impact"
  | "follow_through";

export type SwingTrailPoint = {
  x: number;
  y: number;
  timestamp: number;
  leadX: number;
  leadY: number;
  trailX: number;
  trailY: number;
};

export interface DetectedPhase {
  phase: SwingPhase;
  label: string;
  point: SwingTrailPoint;
  index: number;
  timestamp: number;
  source: "heuristic" | "fallback";
  [key: string]: JsonValue | undefined;
}

export interface ImpactData {
  frameIndex: number;
  timestamp: number;
  point: SwingTrailPoint;
  velocity: number;
  source: "heuristic" | "fallback";
}

export type FallbackGate =
  | "points_too_short"
  | "top_search_bounds"
  | "impact_search_bounds"
  | "impact_distance_out_of_range"
  | "temporal_inversion"
  | "phases_too_bunched"
  | "backswing_ratio_check_failed";

// Re-export shared helpers that tests and other modules still import.
export {
  findSetupEndIndex,
  findSetupEndIndexStillness,
} from "./phaseDetectionShared";

export type { PhaseRuleDebug } from "./phaseDetectionShared";

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export type DispatcherInput =
  | SwingTrailPoint[]
  | {
      canonical: PoseSequence;
      trail: SwingTrailPoint[];
      angle: CameraAngle;
      msPerFrame?: number;
    };

function isLegacyInput(input: DispatcherInput): input is SwingTrailPoint[] {
  return Array.isArray(input);
}

function legacyDebug(detector: "legacy"): PhaseRuleDebug {
  return {
    detector,
    swing_start_frame: null,
    true_address_frame: null,
    reliability: emptyReliability(),
    external_assumptions_used: [],
  };
}

/**
 * Back-compat entry. Returns phases only — for the rich debug payload,
 * use `detectSwingPhasesWithDebug`.
 */
export function detectSwingPhases(input: DispatcherInput): DetectedPhase[] {
  return detectSwingPhasesWithDebug(input).phases;
}

export function detectSwingPhasesWithDebug(
  input: DispatcherInput,
): {
  phases: DetectedPhase[];
  fallbackGate: FallbackGate | null;
  ruleDebug: PhaseRuleDebug;
} {
  if (isLegacyInput(input)) {
    const { phases, fallbackGate } = detectLegacyPhases(input);
    return { phases, fallbackGate, ruleDebug: legacyDebug("legacy") };
  }

  const { canonical, trail, angle } = input;
  const msPerFrame = input.msPerFrame ?? msPerFrameFromTrail(trail);

  if (angle === "dtl") {
    return detectDTLPhases({ canonical, trail, msPerFrame });
  }
  if (angle === "face_on") {
    return detectFaceOnPhases({ canonical, trail, msPerFrame });
  }
  const { phases, fallbackGate } = detectLegacyPhases(trail);
  return { phases, fallbackGate, ruleDebug: legacyDebug("legacy") };
}

/** Legacy entry used by older callers — preserved here for back-compat. */
export function detectImpact(points: SwingTrailPoint[]): ImpactData | null {
  return detectImpactLegacy(points);
}
