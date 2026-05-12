import type { PoseSequence } from '@/packages/pose/PoseTypes';
import type { DetectedPhase } from '@/packages/domain/swing/phaseDetection';
import type { PhaseTag } from './enums';
import type { PhaseTagRange } from './SwingRecord';

// Computes net spine-angle delta from address-phase median to impact-phase frame.
export function computeSpineDrift(
  _sequence: PoseSequence,
  _phases: PhaseTagRange[],
): number | null {
  return null; // TODO: requires convertPhasesToRanges — Pre-Clinic 1
}

// Computes the backswing-to-downswing duration ratio (takeaway→top vs top→impact).
export function computeTempoRatio(
  _sequence: PoseSequence,
  _phases: PhaseTagRange[],
): number | null {
  return null; // TODO: requires convertPhasesToRanges — Pre-Clinic 1
}

// Computes the change in horizontal hip-spread (left-hip↔right-hip distance) from address to impact.
export function computeHipSpreadDelta(
  _sequence: PoseSequence,
  _phases: PhaseTagRange[],
): number | null {
  return null; // TODO: requires convertPhasesToRanges — Pre-Clinic 1
}

function mapPhaseToClinicTag(p: DetectedPhase['phase']): PhaseTag {
  return p === 'follow_through' ? 'finish' : p;
}

// Converts pipeline DetectedPhase[] into clinic PhaseTagRange[] by pairing consecutive boundaries.
function convertPhasesToRanges(
  detected: DetectedPhase[],
  totalFrameCount: number,
): PhaseTagRange[] {
  if (detected.length === 0) return [];

  const sorted = [...detected].sort((a, b) => a.index - b.index);

  const seen = new Set<PhaseTag>();
  const deduped: DetectedPhase[] = [];
  for (const p of sorted) {
    const tag = mapPhaseToClinicTag(p.phase);
    if (seen.has(tag)) continue;
    seen.add(tag);
    deduped.push(p);
  }

  const ranges: PhaseTagRange[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const start = deduped[i].index;
    const end =
      i + 1 < deduped.length
        ? deduped[i + 1].index - 1
        : totalFrameCount - 1;
    ranges.push({
      phase: mapPhaseToClinicTag(deduped[i].phase),
      startFrameIndex: start,
      endFrameIndex: end,
    });
  }
  return ranges;
}
