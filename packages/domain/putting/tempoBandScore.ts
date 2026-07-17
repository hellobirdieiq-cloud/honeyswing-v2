/**
 * tempoBandScore.ts — the Putting tempo band score (Phase C).
 *
 * score = TOP − 5 × ceil((|ratio − CENTER| − STEP) / STEP) when
 * |ratio − CENTER| > STEP, else TOP; clamped at FLOOR; null ratio → null
 * (withheld, never 0 — app-wide convention).
 *
 * Bands are computed in INTEGER centi-units (ratio is already 2dp from
 * computePuttingTempo) so float-ceil edges can't misband a boundary ratio.
 *
 * EXTERNAL ASSUMPTION — ADULT PUTTING ANCHOR: CENTER=2.0 / STEP=0.1 / TOP=95
 * are uncalibrated for kids. Recalibrate from the first n≥10 kid putts — the
 * operator's son measured 1.42 and 1.88 on validated strokes (→ 70 and 90
 * under this anchor); expect the anchor to move.
 */

export const TEMPO_BAND_CENTER = 2.0;
export const TEMPO_BAND_STEP = 0.1;
export const TEMPO_BAND_TOP = 95;
export const TEMPO_BAND_FLOOR = 40;

export function tempoBandScore(ratio: number | null): number | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  // Integer centi-units: d = |ratio − 2.0| × 100, step = 10.
  const d = Math.abs(Math.round(ratio * 100) - Math.round(TEMPO_BAND_CENTER * 100));
  const step = Math.round(TEMPO_BAND_STEP * 100);
  if (d <= step) return TEMPO_BAND_TOP;
  const bands = Math.ceil((d - step) / step);
  return Math.max(TEMPO_BAND_FLOOR, TEMPO_BAND_TOP - 5 * bands);
}
