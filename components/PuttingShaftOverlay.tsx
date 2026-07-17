import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { shaftDisplaySegment } from '@/packages/domain/putting/shaftDisplay';
import type { SmoothedShaftFrame } from '@/packages/domain/putting/types';

/**
 * PuttingShaftOverlay — Phase B: the smoothed club-shaft line, one frame at a
 * time, stacked pixel-flush over the putting video (playback-time render,
 * D5 Path 1; baked export deferred to roadmap #96).
 *
 * Input series is ANALYSIS px @480w (SmoothedShaftFrame from
 * smoothShaftSeries); mapping to display is a UNIFORM ×(width/analysisWidth)
 * scale — the analysis height is derived from the same video aspect ratio, so
 * a contain-fit stage sized to the video AR needs no letterbox math (same
 * identity-mapping assumption as skeletonProjection.ts driven mode).
 *
 * Display only — draws the §4.6 rule (pivot → tube end at SHAFT_LEN, no
 * headExt) via shaftDisplaySegment; gates nothing, detects nothing.
 */

const SHAFT_COLOR = '#26E0E0';
const SHAFT_WIDTH = 3;
/** Interpolated (non-anchor) frames render slightly dimmed — same line, honest opacity. */
const INTERP_OPACITY = 0.65;

interface Props {
  smoothed: SmoothedShaftFrame[];
  shaftLenPx: number;
  /** Analysis-space width the series was computed at (plugin analysisWidth; 480). */
  analysisWidth: number;
  /** Driven playhead — same index the video clock feeds the skeleton canvas. */
  playheadIdx: number;
  width: number;
  height: number;
}

export default function PuttingShaftOverlay({
  smoothed,
  shaftLenPx,
  analysisWidth,
  playheadIdx,
  width,
  height,
}: Props) {
  if (smoothed.length === 0 || analysisWidth <= 0) return null;
  const idx = Math.min(Math.max(0, playheadIdx), smoothed.length - 1);
  const frame = smoothed[idx];
  const seg = shaftDisplaySegment(frame, shaftLenPx);
  const s = width / analysisWidth;
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
      <Line
        x1={seg.x0 * s}
        y1={seg.y0 * s}
        x2={seg.x1 * s}
        y2={seg.y1 * s}
        stroke={SHAFT_COLOR}
        strokeWidth={SHAFT_WIDTH}
        strokeLinecap="round"
        opacity={frame.anchor ? 1 : INTERP_OPACITY}
      />
    </Svg>
  );
}
