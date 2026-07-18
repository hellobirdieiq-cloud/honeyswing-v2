/**
 * operatorRegrade.ts — P-101 phase-override injection point.
 *
 * Recomputes tempo + score from operator-corrected phase frames by composing
 * the REAL pipeline functions (calculateTempo → isTempoTrustworthy →
 * scoreSwing), never a side formula. This file is the only domain surface the
 * operator-label workstream touches: with no operator frames the caller never
 * reaches this module, so no-label behavior is structurally unchanged.
 *
 * NOT a whole-pipeline re-run: historical rows cannot replay
 * analyzePoseSequence faithfully (only the average gravity vector is
 * persisted — tilt correction rejects on replay, see reconstructAnalysis.ts),
 * and the headline score + coaching cue are tempo-only (scoring.ts,
 * tempoDisplay.ts). Phase-windowed angles are deliberately NOT recomputed.
 *
 * The addressUnreliable tempo guard (analysisPipeline.ts) is deliberately NOT
 * re-applied: it compensates for unconfident AUTOMATIC address detection,
 * while this path exists because a human verified the frames; it is also
 * unreconstructable for history rows (swingStart reliability isn't
 * persisted). The isTempoTrustworthy segment/ratio gates still run and catch
 * physically-broken stamps.
 */

import type { DetectedPhase, SwingPhase, SwingTrailPoint } from "./phaseDetection";
import type { GolfAngles } from "./angles";
import { calculateTempo, isTempoTrustworthy, type SwingTempo } from "./tempoAnalysis";
import { scoreSwing } from "./scoring";

export interface OperatorRegradeResult {
  /** Merged phase set actually fed to the pipeline functions. */
  effectivePhases: DetectedPhase[];
  /** Trust-gated, same gates as the live pipeline (minus addressUnreliable). */
  tempo: SwingTempo | null;
  score: number | null;
  honeyBoom: boolean;
  /** Provenance: which phases came from operator stamps. */
  overriddenPhases: SwingPhase[];
}

const PHASE_ORDER: readonly SwingPhase[] = [
  "takeaway",
  "top",
  "downswing",
  "impact",
  "follow_through",
];

const PHASE_LABELS: Record<SwingPhase, string> = {
  takeaway: "Takeaway",
  top: "Top",
  downswing: "Downswing",
  impact: "Impact",
  follow_through: "Follow Through",
};

// scoreSwing destructures only `tempo`; angles are required by signature but
// never read (scoring.ts). All-null keeps the call honest without inventing
// measurements.
const EMPTY_ANGLES: GolfAngles = {
  spineAngle: null,
  leftElbowAngle: null,
  rightElbowAngle: null,
  leftKneeAngle: null,
  rightKneeAngle: null,
  hipSpreadDelta: null,
  shoulderTilt: null,
  spineDrift: null,
};

// Only .phase/.timestamp/.source are read downstream (calculateTempo,
// isTempoTrustworthy); the point is a required-field placeholder.
const ZERO_POINT: SwingTrailPoint = {
  x: 0,
  y: 0,
  timestamp: 0,
  leadX: 0,
  leadY: 0,
  trailX: 0,
  trailY: 0,
};

/**
 * Derive a timestamp for an operator-stamped frame index. Preference order
 * keeps ONE timebase (never mixes absolute detected ms with bare stepMs*idx
 * while an absolute anchor exists):
 *   1. frames[idx].timestampMs (clamped) — same timebase as detected phases:
 *      DetectedPhase.index is canonical frame-space, 1:1 with raw frames
 *      (per-frame canonical transform; the label bar already equates them).
 *   2. own detected phase as anchor: detected.timestamp + stepMs·Δindex.
 *   3. any detected phase as anchor: same formula.
 *   4. no detected anchor at all: stepMs·idx (internally consistent — every
 *      phase in the set is then operator-derived the same way).
 *   5. underivable → null (caller drops the phase → <5-set → withheld).
 */
function timestampForFrame(
  idx: number,
  frames: readonly { timestampMs: number }[] | null | undefined,
  stepMs: number | null | undefined,
  ownDetected: DetectedPhase | undefined,
  anyDetected: DetectedPhase | undefined,
): number | null {
  if (frames && frames.length > 0) {
    const clamped = Math.min(Math.max(idx, 0), frames.length - 1);
    const ts = frames[clamped]?.timestampMs;
    if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  }
  if (typeof stepMs === "number" && Number.isFinite(stepMs)) {
    const anchor = ownDetected ?? anyDetected;
    if (anchor && Number.isFinite(anchor.timestamp) && Number.isFinite(anchor.index)) {
      return anchor.timestamp + stepMs * (idx - anchor.index);
    }
    return stepMs * idx;
  }
  return null;
}

export function regradeFromOperatorPhases(params: {
  detectedPhases: readonly DetectedPhase[] | null | undefined;
  /** operator_labels.phases — stamped frame indices, partial subsets allowed. */
  operatorFrames: Partial<Record<SwingPhase, number>>;
  /** Preferred timestamp source (pose frames, canonical index space). */
  frames?: readonly { timestampMs: number }[] | null;
  /** operator_labels.step_ms — fallback timestamp derivation. */
  stepMs?: number | null;
}): OperatorRegradeResult {
  const { detectedPhases, operatorFrames, frames, stepMs } = params;

  const detectedByPhase = new Map<SwingPhase, DetectedPhase>();
  for (const p of detectedPhases ?? []) {
    if (p && PHASE_ORDER.includes(p.phase) && !detectedByPhase.has(p.phase)) {
      detectedByPhase.set(p.phase, p);
    }
  }
  const anyDetected = PHASE_ORDER.map((k) => detectedByPhase.get(k)).find(
    (p) => p != null && Number.isFinite(p.timestamp) && Number.isFinite(p.index),
  );

  const effectivePhases: DetectedPhase[] = [];
  const overriddenPhases: SwingPhase[] = [];

  for (const phase of PHASE_ORDER) {
    const stampedIdx = operatorFrames[phase];
    const detected = detectedByPhase.get(phase);

    if (typeof stampedIdx === "number" && Number.isFinite(stampedIdx)) {
      const timestamp = timestampForFrame(stampedIdx, frames, stepMs, detected, anyDetected);
      if (timestamp == null) continue; // underivable → phase dropped
      overriddenPhases.push(phase);
      effectivePhases.push(
        detected
          ? { ...detected, index: stampedIdx, timestamp, source: "heuristic" }
          : {
              phase,
              label: PHASE_LABELS[phase],
              point: ZERO_POINT,
              index: stampedIdx,
              timestamp,
              // Operator stamps are human ground truth — they must not trip
              // the all-fallback kill switch in isTempoTrustworthy. The
              // source union is closed ("heuristic" | "fallback"), so
              // provenance lives in overriddenPhases instead.
              source: "heuristic",
            },
      );
    } else if (detected) {
      effectivePhases.push(detected);
    }
  }

  const raw = calculateTempo(effectivePhases);
  const tempo = raw != null && isTempoTrustworthy(raw, effectivePhases) ? raw : null;
  const { score, honeyBoom } = scoreSwing({ angles: EMPTY_ANGLES, tempo });

  return { effectivePhases, tempo, score, honeyBoom, overriddenPhases };
}
