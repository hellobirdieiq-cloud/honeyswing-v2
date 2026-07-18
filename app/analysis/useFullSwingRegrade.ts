/**
 * useFullSwingRegrade — P-101 view-model for the full-swing Auto | Yours card.
 *
 * Resolves swing_debug.operator_labels (fetched row for history AND live —
 * useSwingSource fetches the record in both paths; post-save the screen
 * mirrors the just-written payload via registerSavedLabels, no refetch) into:
 *   - corrections: the Yours regrade (merged operator + detected phases run
 *     through the real pipeline seam). null ⇔ zero saved labels ⇔ the screen
 *     renders exactly as before P-101.
 *   - autoView: the ORIGINAL (pre-label) values. Under row-rewrite
 *     persistence the row columns hold the Yours values after a save, and
 *     reconstructAnalysisFromRecord rebuilds analysis FROM the row — so on a
 *     history reopen analysis.score/tempo are ALREADY the corrected values
 *     and must never back the Auto side. Auto is therefore:
 *       live    → the in-memory analysis (it IS the original);
 *       history → zero-override recompute on analysis.phases (the row phases
 *                 column is written once at capture and never rewritten, so
 *                 it carries the original detected phases with real
 *                 timestamps + source flags — fallback-withheld stays
 *                 withheld); if row phases are missing, synthesized from the
 *                 operator_labels.detected snapshot (labels ignored).
 *     Known edge: an original tempo withheld ONLY by the pipeline's
 *     addressUnreliable guard is unreconstructable and may un-withhold in
 *     the history Auto recompute — rare, accepted (see operatorRegrade.ts).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SwingRecord } from '../../lib/swingStore';
import type { AnalysisResult } from '../../packages/domain/swing/analysisPipeline';
import type { DetectedPhase, SwingPhase } from '../../packages/domain/swing/phaseDetection';
import type { SwingTempo } from '../../packages/domain/swing/tempoAnalysis';
import { regradeFromOperatorPhases } from '../../packages/domain/swing/operatorRegrade';

const PHASE_KEYS: readonly SwingPhase[] = [
  'takeaway',
  'top',
  'downswing',
  'impact',
  'follow_through',
];

export interface FullSwingViewModel {
  score: number | null;
  tempo: SwingTempo | null;
  honeyBoom: boolean;
}

export interface FullSwingCorrections extends FullSwingViewModel {
  overriddenPhases: SwingPhase[];
}

interface SavedLabels {
  phases: Partial<Record<SwingPhase, number>>;
  /** Full detected snapshot from operator_labels (Auto fallback source). */
  detected: Partial<Record<SwingPhase, number>>;
  stepMs: number | null;
}

/** Schema-guarded parse of a frame map — finite numbers on known keys only. */
function parseFrameMap(raw: unknown): Partial<Record<SwingPhase, number>> {
  const out: Partial<Record<SwingPhase, number>> = {};
  if (raw == null || typeof raw !== 'object') return out;
  for (const key of PHASE_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

function parseOperatorLabels(swingDebug: Record<string, unknown> | null | undefined): SavedLabels | null {
  const raw = swingDebug?.operator_labels;
  if (raw == null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const phases = parseFrameMap(obj.phases);
  if (Object.keys(phases).length === 0) return null;
  return {
    phases,
    detected: parseFrameMap(obj.detected),
    stepMs:
      typeof obj.step_ms === 'number' && Number.isFinite(obj.step_ms) ? obj.step_ms : null,
  };
}

export function useFullSwingRegrade(params: {
  swingRecord: SwingRecord | null;
  analysis: AnalysisResult | null;
  frames: readonly { timestampMs: number }[] | undefined;
  isLiveSwing: boolean;
}): {
  corrections: FullSwingCorrections | null;
  /** Original values for the Auto side; non-null whenever corrections is. */
  autoView: FullSwingViewModel | null;
  /** Merged (operator + detected) phase set of the Yours regrade — feeds
   *  display surfaces that follow the toggle (Swing Art). Non-null whenever
   *  corrections is. */
  effectivePhases: DetectedPhase[] | null;
  /** Previously saved stamps — seeds the label bar so re-saves EXTEND. */
  savedLabelFrames: Partial<Record<SwingPhase, number>> | null;
  registerSavedLabels: (phases: Partial<Record<SwingPhase, number>>, stepMs: number | null) => void;
} {
  const { swingRecord, analysis, frames, isLiveSwing } = params;

  const [saved, setSaved] = useState<SavedLabels | null>(null);
  // One-shot seed from the fetched record, and NEVER over a fresher
  // registerSavedLabels mirror: a slow record fetch resolving after an
  // in-session save must not clobber the just-written payload.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !swingRecord) return;
    seededRef.current = true;
    setSaved((prev) => prev ?? parseOperatorLabels(swingRecord.swing_debug));
  }, [swingRecord]);

  const registerSavedLabels = (
    phases: Partial<Record<SwingPhase, number>>,
    stepMs: number | null,
  ) => {
    // Replace (not merge) — mirrors the RPC's replace-the-key semantics.
    setSaved((prev) => ({ phases, detected: prev?.detected ?? {}, stepMs }));
  };

  const regraded = useMemo(() => {
    if (!saved) return null;
    return regradeFromOperatorPhases({
      detectedPhases: analysis?.phases,
      operatorFrames: saved.phases,
      frames,
      stepMs: saved.stepMs,
    });
  }, [saved, analysis, frames]);

  const corrections = useMemo<FullSwingCorrections | null>(
    () =>
      regraded
        ? {
            score: regraded.score,
            tempo: regraded.tempo,
            honeyBoom: regraded.honeyBoom,
            overriddenPhases: regraded.overriddenPhases,
          }
        : null,
    [regraded],
  );

  const autoView = useMemo<FullSwingViewModel | null>(() => {
    if (!saved) return null;
    if (isLiveSwing && analysis) {
      // The in-memory analysis is the original pipeline output.
      return { score: analysis.score, tempo: analysis.tempo ?? null, honeyBoom: analysis.honeyBoom };
    }
    const hasRowPhases = (analysis?.phases?.length ?? 0) > 0;
    const r = regradeFromOperatorPhases(
      hasRowPhases
        ? { detectedPhases: analysis?.phases, operatorFrames: {}, frames, stepMs: saved.stepMs }
        : { detectedPhases: [], operatorFrames: saved.detected, frames, stepMs: saved.stepMs },
    );
    return { score: r.score, tempo: r.tempo, honeyBoom: r.honeyBoom };
  }, [saved, analysis, frames, isLiveSwing]);

  return {
    corrections,
    autoView,
    effectivePhases: regraded?.effectivePhases ?? null,
    savedLabelFrames: saved?.phases ?? null,
    registerSavedLabels,
  };
}
