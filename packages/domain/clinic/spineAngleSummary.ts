import type { PhaseTagRange } from './SwingRecord';
import type { PhaseTag } from './enums';

export interface SpineAngleSummary {
  range: number | null;
  min: number | null;
  max: number | null;
  address: number | null;
  top: number | null;
  impact: number | null;
  deltaTopFromAddress: number | null;
  deltaImpactFromAddress: number | null;
}

const ROLLING_WINDOW = 3;

function rollingAverage(series: (number | null)[]): (number | null)[] {
  const half = Math.floor(ROLLING_WINDOW / 2);
  return series.map((_, i) => {
    let sum = 0;
    let count = 0;
    const start = Math.max(0, i - half);
    const end = Math.min(series.length - 1, i + half);
    for (let j = start; j <= end; j++) {
      const v = series[j];
      if (v !== null && Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  });
}

function startFrame(phaseTags: PhaseTagRange[], phase: PhaseTag): number | null {
  const t = phaseTags.find((x) => x.phase === phase);
  return t ? t.startFrameIndex : null;
}

function rawValueAt(series: (number | null)[], idx: number | null): number | null {
  if (idx === null || idx < 0 || idx >= series.length) return null;
  const v = series[idx];
  return v !== null && Number.isFinite(v) ? v : null;
}

export function computeSpineAngleSummary(
  series: (number | null)[] | null | undefined,
  phaseTags: PhaseTagRange[],
): SpineAngleSummary {
  if (!series || series.length === 0) {
    return {
      range: null,
      min: null,
      max: null,
      address: null,
      top: null,
      impact: null,
      deltaTopFromAddress: null,
      deltaImpactFromAddress: null,
    };
  }

  const smoothed = rollingAverage(series);
  const valid = smoothed.filter((v): v is number => v !== null && Number.isFinite(v));
  const min = valid.length > 0 ? Math.min(...valid) : null;
  const max = valid.length > 0 ? Math.max(...valid) : null;
  const range = min !== null && max !== null ? max - min : null;

  const address = rawValueAt(series, startFrame(phaseTags, 'address'));
  const top = rawValueAt(series, startFrame(phaseTags, 'top'));
  const impact = rawValueAt(series, startFrame(phaseTags, 'impact'));
  const deltaTopFromAddress = top !== null && address !== null ? top - address : null;
  const deltaImpactFromAddress = impact !== null && address !== null ? impact - address : null;

  return {
    range,
    min,
    max,
    address,
    top,
    impact,
    deltaTopFromAddress,
    deltaImpactFromAddress,
  };
}
