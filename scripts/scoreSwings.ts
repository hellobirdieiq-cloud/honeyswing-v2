/**
 * Run with: npx tsx scripts/scoreSwings.ts
 *
 * Scores 23 hardcoded swings from today's session through the production
 * scoreSwing() implementation and prints a per-metric table + averages.
 *
 * Notes:
 * - hipSpreadDelta is NOT in METRIC_DEFINITIONS / ANGLE_METRIC_KEYS
 *   (scoring.ts:6-9), so scoreSwing produces no entry for it. Column shows
 *   'n/a'.
 * - AgeTier (9-12 per request) does not enter the scoring path; it only
 *   affects cue strings in metricDefinitions.ts.
 */

import { scoreSwing, isMeasured } from '../packages/domain/swing/scoring';
import type { GolfAngles } from '../packages/domain/swing/angles';

type SwingRow = { id: number } & GolfAngles;

const SWINGS: SwingRow[] = [
  { id: 1,  spineAngle: 10.6,  shoulderTilt: -0.4,   leftKneeAngle: 178,  rightKneeAngle: 174,  hipSpreadDelta: 0,  leftElbowAngle: 170, rightElbowAngle: 169, spineDrift: null },
  { id: 2,  spineAngle: 10.08, shoulderTilt: -26.92, leftKneeAngle: 136,  rightKneeAngle: 158,  hipSpreadDelta: 2,  leftElbowAngle: 118, rightElbowAngle: null, spineDrift: null },
  { id: 3,  spineAngle: 14.04, shoulderTilt: 0.04,   leftKneeAngle: 172,  rightKneeAngle: 162,  hipSpreadDelta: 0,  leftElbowAngle: 143, rightElbowAngle: 169, spineDrift: null },
  { id: 4,  spineAngle: 20.44, shoulderTilt: -4.56,  leftKneeAngle: 176,  rightKneeAngle: 178,  hipSpreadDelta: 0,  leftElbowAngle: 174, rightElbowAngle: 166, spineDrift: null },
  { id: 5,  spineAngle: 17.71, shoulderTilt: 19.71,  leftKneeAngle: 154,  rightKneeAngle: 155,  hipSpreadDelta: 4,  leftElbowAngle: 161, rightElbowAngle: 165, spineDrift: null },
  { id: 6,  spineAngle: 9.04,  shoulderTilt: -2.96,  leftKneeAngle: 173,  rightKneeAngle: 175,  hipSpreadDelta: 0,  leftElbowAngle: 167, rightElbowAngle: 172, spineDrift: null },
  { id: 7,  spineAngle: 13.73, shoulderTilt: -2.27,  leftKneeAngle: 179,  rightKneeAngle: 178,  hipSpreadDelta: -1, leftElbowAngle: 170, rightElbowAngle: 171, spineDrift: null },
  { id: 8,  spineAngle: 10.53, shoulderTilt: -0.47,  leftKneeAngle: 175,  rightKneeAngle: 161,  hipSpreadDelta: -1, leftElbowAngle: 179, rightElbowAngle: 168, spineDrift: null },
  { id: 9,  spineAngle: 7.65,  shoulderTilt: -2.35,  leftKneeAngle: 172,  rightKneeAngle: 175,  hipSpreadDelta: -1, leftElbowAngle: 168, rightElbowAngle: 162, spineDrift: null },
  { id: 10, spineAngle: 9.71,  shoulderTilt: -10.29, leftKneeAngle: 172,  rightKneeAngle: 168,  hipSpreadDelta: 0,  leftElbowAngle: 168, rightElbowAngle: 165, spineDrift: null },
  { id: 11, spineAngle: 7.2,   shoulderTilt: -4.8,   leftKneeAngle: 163,  rightKneeAngle: 174,  hipSpreadDelta: -1, leftElbowAngle: 166, rightElbowAngle: null, spineDrift: null },
  { id: 12, spineAngle: 7.78,  shoulderTilt: 4.78,   leftKneeAngle: 175,  rightKneeAngle: 178,  hipSpreadDelta: -1, leftElbowAngle: 165, rightElbowAngle: 165, spineDrift: null },
  { id: 13, spineAngle: 11.22, shoulderTilt: -18.78, leftKneeAngle: 177,  rightKneeAngle: 173,  hipSpreadDelta: 0,  leftElbowAngle: 167, rightElbowAngle: 170, spineDrift: null },
  { id: 14, spineAngle: 9.79,  shoulderTilt: 5.79,   leftKneeAngle: 174,  rightKneeAngle: 178,  hipSpreadDelta: -1, leftElbowAngle: 164, rightElbowAngle: 171, spineDrift: null },
  { id: 15, spineAngle: 4.22,  shoulderTilt: 3.22,   leftKneeAngle: 144,  rightKneeAngle: 167,  hipSpreadDelta: 3,  leftElbowAngle: 163, rightElbowAngle: 128, spineDrift: null },
  { id: 16, spineAngle: 12.68, shoulderTilt: 4.68,   leftKneeAngle: 176,  rightKneeAngle: 176,  hipSpreadDelta: -1, leftElbowAngle: 171, rightElbowAngle: 161, spineDrift: null },
  { id: 17, spineAngle: 17.98, shoulderTilt: 11.98,  leftKneeAngle: 174,  rightKneeAngle: 174,  hipSpreadDelta: 5,  leftElbowAngle: 177, rightElbowAngle: 173, spineDrift: null },
  { id: 18, spineAngle: 7.36,  shoulderTilt: 1.36,   leftKneeAngle: 177,  rightKneeAngle: 174,  hipSpreadDelta: -1, leftElbowAngle: 173, rightElbowAngle: 174, spineDrift: null },
  { id: 19, spineAngle: 14.37, shoulderTilt: -0.63,  leftKneeAngle: null, rightKneeAngle: null, hipSpreadDelta: 0,  leftElbowAngle: 162, rightElbowAngle: 166, spineDrift: null },
  { id: 20, spineAngle: 51.91, shoulderTilt: -24.09, leftKneeAngle: 160,  rightKneeAngle: 175,  hipSpreadDelta: 0,  leftElbowAngle: 157, rightElbowAngle: 158, spineDrift: null },
  { id: 21, spineAngle: 10.92, shoulderTilt: -2.08,  leftKneeAngle: 176,  rightKneeAngle: 169,  hipSpreadDelta: 0,  leftElbowAngle: 162, rightElbowAngle: 165, spineDrift: null },
  { id: 22, spineAngle: 11.53, shoulderTilt: 10.53,  leftKneeAngle: 135,  rightKneeAngle: 176,  hipSpreadDelta: 1,  leftElbowAngle: 165, rightElbowAngle: 16, spineDrift: null },
  { id: 23, spineAngle: 0,     shoulderTilt: -11.81, leftKneeAngle: 178,  rightKneeAngle: 179,  hipSpreadDelta: 3,  leftElbowAngle: 177, rightElbowAngle: 129, spineDrift: null },
];

const METRIC_COLS = [
  'spineAngle',
  'shoulderTilt',
  'leftKneeAngle',
  'rightKneeAngle',
  'hipSpreadDelta',
  'leftElbowAngle',
  'rightElbowAngle',
] as const;

const SHORT: Record<(typeof METRIC_COLS)[number], string> = {
  spineAngle: 'spine',
  shoulderTilt: 'shldTilt',
  leftKneeAngle: 'lKnee',
  rightKneeAngle: 'rKnee',
  hipSpreadDelta: 'hipSpr',
  leftElbowAngle: 'lElbow',
  rightElbowAngle: 'rElbow',
};

const COL_W = 9;
const ID_W = 4;

function pad(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function fmtCell(v: number | '—' | 'n/a'): string {
  return pad(typeof v === 'number' ? String(v) : v, COL_W);
}

const header = pad('id', ID_W) + METRIC_COLS.map((m) => pad(SHORT[m], COL_W)).join('') + pad('OVERALL', COL_W);
const rule = '─'.repeat(header.length);

console.log('\nHoneySwing — 23 swings, scored via scoreSwing()');
console.log(rule);
console.log(header);
console.log(rule);

const sums: Record<string, { total: number; n: number }> = {};
for (const m of METRIC_COLS) sums[m] = { total: 0, n: 0 };
const overallSum = { total: 0, n: 0 };

for (const swing of SWINGS) {
  const { id, ...angles } = swing;
  const result = scoreSwing({ angles, tempo: null });

  const cells: string[] = [];
  for (const metric of METRIC_COLS) {
    if (metric === 'hipSpreadDelta') {
      cells.push(fmtCell('n/a'));
      continue;
    }
    const entry = result.breakdown.find((e) => e.metric === metric);
    if (!entry || !isMeasured(entry)) {
      cells.push(fmtCell('—'));
    } else {
      cells.push(fmtCell(entry.score));
      sums[metric].total += entry.score;
      sums[metric].n += 1;
    }
  }

  const overall = result.score;
  if (overall != null) {
    overallSum.total += overall;
    overallSum.n += 1;
  }
  const overallCell = fmtCell(overall ?? '—');

  console.log(pad(`#${id}`, ID_W) + cells.join('') + overallCell);
}

console.log(rule);

const avgCells = METRIC_COLS.map((m) => {
  if (m === 'hipSpreadDelta') return pad('n/a', COL_W);
  const { total, n } = sums[m];
  if (n === 0) return pad('—', COL_W);
  return pad((total / n).toFixed(1), COL_W);
});
console.log(pad('AVG', ID_W) + avgCells.join('') + pad((overallSum.total / overallSum.n).toFixed(1), COL_W));

const nCells = METRIC_COLS.map((m) => {
  if (m === 'hipSpreadDelta') return pad('—', COL_W);
  return pad(`n=${sums[m].n}`, COL_W);
});
console.log(pad('', ID_W) + nCells.join('') + pad(`n=${overallSum.n}`, COL_W));
console.log(rule);
console.log('\nNotes:');
console.log("  • '—'  = angle was null → dataQuality=missing → excluded from AVG");
console.log("  • 'n/a'= hipSpreadDelta is not scored (absent from ANGLE_METRIC_KEYS, scoring.ts:6-9)");
console.log("  • OVERALL is scoreSwing's weighted avg over measured metrics (scoring.ts:90-92)");
console.log('  • Age tier 9-12 does not affect scoring (cue strings only).\n');
