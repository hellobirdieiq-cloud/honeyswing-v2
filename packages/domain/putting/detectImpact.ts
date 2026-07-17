/**
 * detectImpact.ts — IMPACT via ball launch (Putting spec §4.2).
 *
 * Port of the playground `computeLaunch` (shaft-playground v7.6.5,
 * docs/putting-cv-test/playground/) — the single impact truth; there is no
 * native counterpart. Validated n=2: clip 51b07a6b f152 exact, clip a347efc8
 * f151 vs label 150 (ball-jump at 151 supports the detector).
 *
 * ONE deliberate deviation from the v7.6.5 source: a launch candidate must
 * fall AFTER the rest window that defines restPos. The unguarded rule
 * false-fires on real data — clip a347efc8's ball drifts ~9.5px while
 * settling in its first frames, which is > LAUNCH_DIST_PX from the eventual
 * rest median, so v765.js's literal loop returns f0. A "launch" inside the
 * window the algorithm itself treats as rest is contradictory; with the
 * guard, both clips reproduce the session-validated outputs (152 / 151).
 *
 * Ball positions are FULL-RES (1080-wide) pixels; LAUNCH_DIST_PX is a
 * full-res threshold used unscaled. All constants EXTERNAL ASSUMPTION at n=2.
 */

import type { BallPoint } from './types';

export const LAUNCH_DIST_PX = 8;
/** restPos = median ball (x,y) over the first 60% of ball-present frames. */
export const REST_FRACTION = 0.6;
export const MIN_BALL_FRAMES = 4;

function median(a: number[]): number {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Impact = first frame i with dist(i)>8 AND dist(i+1)>8 AND dist(i+1)>dist(i)
 * (over threshold on 2 CONSECUTIVE frames and moving farther — a real launch,
 * not detection jitter). Requires the ball detected on frame i+1 itself, same
 * as the playground.
 */
export function detectImpact(balls: readonly BallPoint[]): {
  impactFrame: number | null;
  restPos: { x: number; y: number } | null;
} {
  const presentIdx: number[] = [];
  for (let i = 0; i < balls.length; i++) if (balls[i]) presentIdx.push(i);
  if (presentIdx.length < MIN_BALL_FRAMES) return { impactFrame: null, restPos: null };

  const restIdx = presentIdx.slice(0, Math.max(1, Math.floor(presentIdx.length * REST_FRACTION)));
  const restPos = {
    x: median(restIdx.map((i) => (balls[i] as { x: number }).x)),
    y: median(restIdx.map((i) => (balls[i] as { y: number }).y)),
  };
  const dist = (i: number) => {
    const b = balls[i] as { x: number; y: number };
    return Math.hypot(b.x - restPos.x, b.y - restPos.y);
  };

  const lastRestIdx = restIdx[restIdx.length - 1];
  for (const i of presentIdx) {
    if (i <= lastRestIdx) continue;
    if (!balls[i + 1]) continue;
    const di = dist(i);
    const dn = dist(i + 1);
    if (di > LAUNCH_DIST_PX && dn > LAUNCH_DIST_PX && dn > di) {
      return { impactFrame: i, restPos };
    }
  }
  return { impactFrame: null, restPos };
}
