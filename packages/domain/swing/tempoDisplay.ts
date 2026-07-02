/**
 * tempoDisplay.ts — pure result-screen tempo/partial derivations extracted
 * VERBATIM from app/analysis/result.tsx (Batch 5.2). The kid-facing copy lives
 * here and is byte-pinned by tempoDisplay.test.ts. Green band is inclusive on
 * both ends ([TEMPO_GREEN_LOWER, TEMPO_GREEN_UPPER], see scoring.ts) so exactly
 * 2.0 / 4.3 is green, not tooFast/tooSlow — no gap, no overlap.
 */
import { scoreTempoTrafficLight, TEMPO_GREEN_LOWER, TEMPO_GREEN_UPPER } from './scoring';

export interface TempoDisplay {
  isGreen: boolean;
  tooFast: boolean;
  tooSlow: boolean;
  scoreColor: string;
  tempoLabelText: string | null;
  coachingCueText: string | null;
}

export function deriveTempoDisplay(
  tempo: { tempoRatio: number } | null | undefined,
): TempoDisplay {
  const tempoResult = tempo ? scoreTempoTrafficLight(tempo.tempoRatio) : null;
  const isGreen = tempoResult?.isGreen ?? false;
  const tooFast = !!tempo && tempo.tempoRatio < TEMPO_GREEN_LOWER;
  const tooSlow = !!tempo && tempo.tempoRatio > TEMPO_GREEN_UPPER;
  const scoreColor = isGreen ? '#44CC44' : '#FFFFFF';
  const tempoLabelText = isGreen
    ? 'Perfect swing speed!'
    : tooFast
    ? 'Slow down your backswing'
    : tooSlow
    ? 'Speed up your backswing'
    : null;
  const coachingCueText = tooFast
    ? "Swing back slow like you're moving through honey"
    : tooSlow
    ? 'Whip the club head back fast'
    : null;
  return { isGreen, tooFast, tooSlow, scoreColor, tempoLabelText, coachingCueText };
}

/**
 * Partial-score banner reason: a non-null fallback_gate in swing_debug wins
 * (stringified); otherwise only the persisted 'no-swing' failure_reason
 * qualifies. Everything else → null (no banner).
 */
export function derivePartialReason(
  swingDebug: { fallback_gate?: unknown } | null | undefined,
  failureReason: string | null | undefined,
): string | null {
  return swingDebug?.fallback_gate != null
    ? String(swingDebug.fallback_gate)
    : failureReason === 'no-swing'
      ? failureReason
      : null;
}
