/**
 * puttingPipeline.ts — the LIVE putt-mode post-capture pipeline (Phase C).
 *
 * Mirrors the dev harness bar-mode flow (app/dev/putting-tracker-test.tsx),
 * minus overlay/diagnostics: pose priors → native bar tracker → A1 detectors
 * → smoothed series → windowed head refine → fine takeaway → tempo band
 * score. Fail-soft at every stage — calibration failure leaves the coarse
 * takeaway standing with warnings; a null tempo yields a null score (never 0).
 *
 * Runs AFTER RTMW pose extraction (the caller supplies poseFrames); this is
 * the slowest path in the app (~11s RTMW + three bar decode passes + the
 * refine pass) — per-stage timings are returned for the pipeline_ms
 * convention. Measure before optimizing.
 */

import {
  trackPuttingObjects,
  refinePutterHead,
  type PuttingBarCalibration,
  type PuttingRefinedPoint,
} from '@/modules/vision-camera-pose/src';
import { buildPosePriors, type MotionFrameLite } from '@/packages/domain/putting/buildPosePriors';
import { runPuttingDetectors } from '@/packages/domain/putting/runPuttingDetectors';
import { smoothShaftSeries } from '@/packages/domain/putting/smoothShaftSeries';
import { computeRefineWindow } from '@/packages/domain/putting/detectFineTakeaway';
import { applyFineTakeaway } from '@/packages/domain/putting/applyFineTakeaway';
import { tempoBandScore } from '@/packages/domain/putting/tempoBandScore';
import type {
  PuttingDetectorsResult,
  ShaftFitSample,
  SmoothedShaftFrame,
} from '@/packages/domain/putting/types';

export type PuttingPipelineOutput = {
  /** Final detector result (fine takeaway applied when available). */
  detectors: PuttingDetectorsResult;
  /** Tempo band score — null when tempo withheld (never 0). */
  score: number | null;
  smoothed: SmoothedShaftFrame[] | null;
  shaftLenPx: number | null;
  analysisWidth: number;
  barCalibration: PuttingBarCalibration | null;
  timings: Record<string, number>;
};

export async function runPuttingPipeline(args: {
  videoUri: string;
  poseFrames: readonly MotionFrameLite[];
  stepMs: number;
}): Promise<PuttingPipelineOutput> {
  const { videoUri, poseFrames, stepMs } = args;
  const timings: Record<string, number> = {};
  const t0 = Date.now();

  const posePriors = buildPosePriors(poseFrames);

  const track = await trackPuttingObjects(videoUri, stepMs, {
    writeOverlay: false,
    headDetector: 'bar',
    posePriors,
  });
  timings.bar_track_ms = Date.now() - t0;

  const coarse = runPuttingDetectors({
    posePriors,
    balls: track.frames.map((f) => (f.ball ? { x: f.ball.x, y: f.ball.y } : null)),
    stepMs,
  });

  const barCalibration = track.barCalibration ?? null;
  const shaftLenPx = barCalibration?.shaftLenPx ?? null;
  const analysisWidth = track.analysisWidth ?? 480;

  let smoothed: SmoothedShaftFrame[] | null = null;
  let refinedPoints: PuttingRefinedPoint[] | null = null;
  let headExtPx: number | null = null;
  let skipReason = 'no_shaft_len';
  if (shaftLenPx != null) {
    headExtPx = Math.round(0.13 * shaftLenPx); // D3 ratio — 0.13×194 ≈ 25
    const shaftFits: ShaftFitSample[] = track.frames.map((f) => f.shaftFit ?? null);
    smoothed = smoothShaftSeries(shaftFits, shaftLenPx, headExtPx);
    if (smoothed == null) {
      skipReason = 'no_anchors';
    } else if (coarse.takeawayFrame != null && coarse.topFrame != null) {
      const tRefine = Date.now();
      const win = computeRefineWindow(coarse.takeawayFrame, coarse.topFrame);
      const specFrames = [];
      for (let f = Math.max(0, win.lo); f <= Math.min(win.hi, smoothed.length - 1); f++) {
        const sf = smoothed[f];
        specFrames.push({ gridIdx: f, gripX: sf.px, gripY: sf.py, angleDeg: sf.ang });
      }
      if (specFrames.length > 0) {
        const refined = await refinePutterHead(videoUri, stepMs, {
          frames: specFrames,
          shaftLenPx,
          headExtPx,
        });
        refinedPoints = refined.points;
      }
      timings.refine_ms = Date.now() - tRefine;
    }
  }

  const anchorCount = smoothed ? smoothed.filter((sf) => sf.anchor).length : null;
  const detectors = applyFineTakeaway({
    base: coarse,
    refinedPoints,
    headExtPx,
    anchorCount,
    stepMs,
    skipReason,
  });
  const score = tempoBandScore(detectors.tempo?.ratio ?? null);
  timings.total_ms = Date.now() - t0;

  return { detectors, score, smoothed, shaftLenPx, analysisWidth, barCalibration, timings };
}
