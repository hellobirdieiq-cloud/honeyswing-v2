import { DetectedPhase } from "./phaseDetection";

export interface SwingTempo {
  backswingMs: number;
  downswingMs: number;
  tempoRatio: number;
  totalSwingMs: number;
  tempoRating: TempoRating;
  phaseTimestamps: PhaseTimestamps;
}

export type TempoRating = "rushed" | "fast" | "good" | "slow" | "very_slow";

export interface PhaseTimestamps {
  address: number;
  takeaway: number;
  top: number;
  downswing: number;
  impact: number;
  finish: number;
}

const TEMPO_THRESHOLDS: { max: number; rating: TempoRating }[] = [
  { max: 1.5, rating: "rushed" },
  { max: 2.5, rating: "fast" },
  { max: 3.5, rating: "good" },
  { max: 4.5, rating: "slow" },
  { max: Infinity, rating: "very_slow" },
];

export const TEMPO_LABELS: Record<TempoRating, string> = {
  rushed: "Rushed",
  fast: "Fast",
  good: "Good Tempo",
  slow: "Slow",
  very_slow: "Very Slow",
};

export const TEMPO_COLORS: Record<TempoRating, string> = {
  rushed: "#FF4444",
  fast: "#FFB020",
  good: "#44CC44",
  slow: "#FFB020",
  very_slow: "#FF4444",
};

function rateTempo(ratio: number): TempoRating {
  for (const threshold of TEMPO_THRESHOLDS) {
    if (ratio <= threshold.max) return threshold.rating;
  }
  return "very_slow";
}

export function calculateTempo(phases: DetectedPhase[]): SwingTempo | null {
  if (phases.length < 6) {
    return null;
  }

  const addressPhase = phases.find((p) => p.phase === "address");
  const takeawayPhase = phases.find((p) => p.phase === "takeaway");
  const topPhase = phases.find((p) => p.phase === "top");
  const downswingPhase = phases.find((p) => p.phase === "downswing");
  const impactPhase = phases.find((p) => p.phase === "impact");
  const finishPhase = phases.find((p) => p.phase === "follow_through");

  if (!addressPhase || !takeawayPhase || !topPhase || !downswingPhase || !impactPhase || !finishPhase) {
    return null;
  }

  const backswingMs = topPhase.timestamp - addressPhase.timestamp;
  const downswingMs = impactPhase.timestamp - topPhase.timestamp;
  const totalSwingMs = finishPhase.timestamp - addressPhase.timestamp;

  if (downswingMs <= 0 || backswingMs <= 0) {
    return null;
  }

  const tempoRatio = Math.round((backswingMs / downswingMs) * 100) / 100;
  const tempoRating = rateTempo(tempoRatio);

  const phaseTimestamps: PhaseTimestamps = {
    address: addressPhase.timestamp,
    takeaway: takeawayPhase.timestamp,
    top: topPhase.timestamp,
    downswing: downswingPhase.timestamp,
    impact: impactPhase.timestamp,
    finish: finishPhase.timestamp,
  };

  return {
    backswingMs,
    downswingMs,
    tempoRatio,
    totalSwingMs,
    tempoRating,
    phaseTimestamps,
  };
}

// ── Tempo sanity thresholds (single location, easy to tune) ──────────
// Minimum phase duration in ms — anything shorter is noise, not a real swing segment
export const TEMPO_MIN_PHASE_MS = 50;
// Plausible tempo ratio band — real swings are roughly 2:1 to 4:1 (backswing:downswing)
// Allow wider band for tolerance, but reject extreme/inverted values
export const TEMPO_MIN_RATIO = 0.5;
export const TEMPO_MAX_RATIO = 10;

/**
 * Sanity-check a computed tempo using EXISTING phase data.
 * Returns false if the tempo should NOT be shown confidently.
 */
export function isTempoTrustworthy(
  tempo: SwingTempo,
  phases: { source: "heuristic" | "fallback" }[],
): boolean {
  // Fallback phases are fixed-percentage splits with no real motion analysis
  const allFallback = phases.length > 0 && phases.every((p) => p.source === "fallback");
  if (allFallback) return false;

  // Phase durations too short to be a real swing segment
  if (tempo.backswingMs < TEMPO_MIN_PHASE_MS || tempo.downswingMs < TEMPO_MIN_PHASE_MS) return false;

  // Ratio outside plausible band (inverted, extreme, or broken)
  if (tempo.tempoRatio < TEMPO_MIN_RATIO || tempo.tempoRatio > TEMPO_MAX_RATIO) return false;

  // Non-finite values
  if (!Number.isFinite(tempo.tempoRatio)) return false;

  return true;
}

export function serializePhaseTimestamps(timestamps: PhaseTimestamps): Record<string, number> {
  return {
    address: Math.round(timestamps.address),
    takeaway: Math.round(timestamps.takeaway),
    top: Math.round(timestamps.top),
    downswing: Math.round(timestamps.downswing),
    impact: Math.round(timestamps.impact),
    finish: Math.round(timestamps.finish),
  };
}
