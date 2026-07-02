/**
 * reconstructAnalysis.ts — rebuild an AnalysisResult from a persisted
 * SwingRecord, moved VERBATIM from app/analysis/result.tsx (Batch 5.2).
 * Type-only imports keep this module graph-free for the tsx test harness.
 */
import type { AnalysisResult } from '../packages/domain/swing/analysisPipeline';
import type { SwingRecord } from './swingStore';

// Reconstruct an AnalysisResult from a persisted SwingRecord — used by the
// history-tap path where the in-memory store doesn't hold the tapped swing.
// `swingConfidence` and `cameraAngleResult` are NOT persisted today; safe
// defaults (matching the empty-sequence shape at analysisPipeline.ts:515-527)
// gate coaching tips off via the confidence threshold in result.tsx's
// tips-memo (breakdown/confidence gate).
// Follow-up: persist swingConfidence + cameraAngleResult for full-fidelity
// tips on historical swings. Re-analyzing motion_frames is NOT a fix —
// persistSwing.ts:191-199 stores only the average gravity vector, so
// applyTiltCorrection rejects (insufficient_samples) on replay and the
// re-analyzed score diverges from the persisted one.
export function reconstructAnalysisFromRecord(record: SwingRecord): AnalysisResult {
  return {
    score: record.score,
    honeyBoom: record.honey_boom ?? false,
    cameraAngleValid: record.camera_angle_valid ?? false,
    swingConfidence: {
      overall: 0,
      tier: 'low',
      components: {
        jointVisibility: 0,
        cameraAngle: 0,
        phaseDetection: 0,
        frameCoverage: 0,
      },
    },
    cameraAngleResult: {
      angle: 'unknown',
      shoulderSpread: 0,
      hipSpread: 0,
      avgSpread: 0,
      footIndexNorm: null,
      weights: {
        spineAngle: 0,
        leftElbowAngle: 0,
        rightElbowAngle: 0,
        leftKneeAngle: 0,
        rightKneeAngle: 0,
        hipSpreadDelta: 0,
        shoulderTilt: 0,
        tempo: 0,
      },
    },
    angles: record.angles ?? undefined,
    tempo: record.tempo ?? null,
    phases: record.phases ?? undefined,
    trail: record.trail_points ?? undefined,
    metricConfidences: record.metric_confidences ?? undefined,
    // swing_debug omitted: DB column is a superset (persistSwing.ts:229-246
    // spreads extra debug keys), not a clean FrameSelectionDebug. Sole
    // consumer (scoring_breakdown tip build) is gated off by the
    // low-confidence default above.
    // aggregate omitted: explicitly NOT persisted per analysisPipeline.ts:104.
  };
}
