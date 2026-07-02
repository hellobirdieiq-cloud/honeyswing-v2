/**
 * faceOnImpactConsensus.ts — face-on impact via a geometric CONSENSUS anchor refined by a
 * sub-frame THUMB crossing. Ported from the validated viewer prototype
 * (honeyswing-swing-inspector/src/lib/impactRule.ts, computeImpactRuleTrace), which replaced the
 * arc-bottom impact and validated 6/6 on the verified RH swings (avg|Δ| 0.43, max 1.0).
 *
 * SPACE: the viewer ran on motion_frames / pose_full RAW (un-mirrored). In the app, RAW =
 * `preCanonical`. This module is SPACE-AGNOSTIC — it reads whatever PoseFrame[] it is handed —
 * so the validation harness can run it on BOTH preCanonical and canonical and on BOTH signFlips
 * to LOCK the sign empirically (the canonical mirror negates g). Production wires preCanonical.
 *
 * PIPELINE (acyclic, mirrors the viewer):
 *   footPick / S2 / S3  — anchor-free geometric signals over [lo,hi] (gated wrist-below-shoulder)
 *   provAnchor          = round(median(available{footPick,S2,S3}))
 *   S1 = xCross         = sustained neg→pos crossing of g = signFlip·(betterConfWristX − feetMidX)
 *                         at L, nearest provAnchor within ±radius
 *   consensus           = median/avg over available{S1,S2,S3}
 *   thumb refine        = sustained neg→pos crossing of dx = signFlip·(thumbTipX − thumbBaseX)
 *                         within ±refineRadius of round(consensus)
 *   FINAL               = thumb sub-frame if it qualifies, else consensus, else null
 *
 * SHADOW ONLY in this PR — nothing here feeds the live impactIdx yet.
 */

import type { JointName, PoseFrame } from "../../pose/PoseTypes";
import { EXTERNAL_ASSUMPTIONS, msToFrames } from "./phaseDetectionShared";

const C = EXTERNAL_ASSUMPTIONS.faceOn.impact.consensus;

// --- helpers (ported verbatim from impactRule.ts) -----------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Median of a numeric array (mean-of-two for even length). NaN for an empty array. */
export function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const a = [...nums].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Rolling median over a ±2 window (5 frames), skipping NaN. NaN only if the whole window is NaN. */
export function rollingMedian5(vals: number[]): number[] {
  const n = vals.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const win: number[] = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      if (Number.isFinite(vals[j])) win.push(vals[j]);
    }
    out[i] = win.length ? median(win) : NaN;
  }
  return out;
}

// Per-joint series sampled from PoseFrame[] (the app's analogue of the viewer's JointSeries).
// present = joint defined with finite x/y; conf = confidence ?? 0 (NaN when absent).
type Series = { x: number[]; y: number[]; conf: number[]; present: boolean[] };

function toSeries(frames: PoseFrame[], name: JointName): Series {
  const n = frames.length;
  const x = new Array<number>(n);
  const y = new Array<number>(n);
  const conf = new Array<number>(n);
  const present = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const j = frames[i]?.joints[name];
    if (j && Number.isFinite(j.x) && Number.isFinite(j.y)) {
      x[i] = j.x;
      y[i] = j.y;
      conf[i] = j.confidence ?? 0;
      present[i] = true;
    } else {
      x[i] = NaN;
      y[i] = NaN;
      conf[i] = NaN;
      present[i] = false;
    }
  }
  return { x, y, conf, present };
}

export interface ConsensusSignalPick {
  name: string;
  frame: number | null;
  available: boolean; // resolved a finite pick AND min joint conf ≥ availConfMin
  conf: number;
}

/** argmin/argmax of `metric` over [lo,hi] (NaN metric = skipped); availability via `confOf`. */
export function pickExtreme(
  name: string,
  lo: number,
  hi: number,
  metric: (f: number) => number,
  mode: "min" | "max",
  confOf: (f: number) => number,
): ConsensusSignalPick {
  let bestFrame: number | null = null;
  let bestVal = mode === "min" ? Infinity : -Infinity;
  for (let f = lo; f <= hi; f++) {
    const v = metric(f);
    if (!Number.isFinite(v)) continue;
    if (mode === "min" ? v < bestVal : v > bestVal) {
      bestVal = v;
      bestFrame = f;
    }
  }
  const conf = bestFrame === null ? NaN : confOf(bestFrame);
  const available = bestFrame !== null && Number.isFinite(conf) && conf >= C.availConfMin;
  return { name, frame: bestFrame, available, conf };
}

// One per-frame xCross row over [lo,hi].
export interface ImpactXRow {
  frame: number;
  g: number; // signFlip·(betterConfWristX − feetMidX); NaN where the wrist or an ankle is absent
  wristConf: number; // confidence of the selected (better-conf) wrist; NaN if neither present
  selWrist: "lead" | "trail" | "none";
}

// One qualifying sustained neg→pos crossing of g at a threshold.
export interface XCrossing {
  frame: number; // integer frame b
  sub: number; // sub-frame linear zero at g = L between a and b
  wrist: "lead" | "trail" | "none";
  conf: number;
}

/**
 * Detect SUSTAINED neg→pos crossing(s) of g at threshold L over a contiguous xRows window.
 * A crossing at adjacent rows a (j−1), b (j) qualifies iff: g[a] < L, g[b] ≥ L, SUSTAINED
 * (g[b] ≥ L AND the next row g ≥ L for xcrossSustainFrames total), and selected-wrist conf ≥
 * confMin at BOTH a and b. Sub-frame zero is the linear g = L crossing.
 */
export function detectXCross(
  rows: ImpactXRow[],
  L: number = C.xcrossLeadOffset,
  confMin: number = C.xcrossConfMin,
  // 1b: sustain rows, rate-derived by the caller; falls back to the 60fps literal.
  sustain: number = C.xcrossSustainFrames,
): { cross: number | null; crossFrame: number | null; crossings: XCrossing[] } {
  const crossings: XCrossing[] = [];
  for (let j = 1; j < rows.length; j++) {
    const a = rows[j - 1];
    const b = rows[j];
    const gA = a.g;
    const gB = b.g;
    // hold ≥ sustain consecutive rows at/above the line (b plus the following ones).
    let sustained = gB >= L;
    for (let h = 1; h < sustain && sustained; h++) {
      const nxt = rows[j + h];
      sustained = nxt !== undefined && nxt.g >= L;
    }
    const confOk = a.wristConf >= confMin && b.wristConf >= confMin;
    if (Number.isFinite(gA) && Number.isFinite(gB) && confOk && gA < L && gB >= L && sustained) {
      // linear zero-crossing at g = L between a and b; (gB − gA) > 0 since gA < L ≤ gB
      crossings.push({
        frame: b.frame,
        sub: a.frame + (L - gA) / (gB - gA),
        wrist: b.selWrist,
        conf: b.wristConf,
      });
    }
  }
  const first = crossings[0] ?? null;
  return {
    cross: first ? first.sub : null,
    crossFrame: first ? first.frame : null,
    crossings,
  };
}

/** Crossing nearest `anchor` within ±radius. Null if anchor is null or none in range. */
export function nearestAnchorCrossing(
  crossings: XCrossing[],
  anchor: number | null,
  radius: number = C.xcrossAnchorRadius,
): XCrossing | null {
  if (anchor === null) return null;
  let best: XCrossing | null = null;
  let bestDist = Infinity;
  for (const c of crossings) {
    const d = Math.abs(c.frame - anchor);
    if (d <= radius && d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

// --- public output ------------------------------------------------------------------------------

export interface FaceOnImpactConsensus {
  final: number | null; // sub-frame: thumb if qualifies, else consensus, else null
  source: "thumb" | "consensus" | "none";
  consensus: number | null;
  anchor: number | null; // round(consensus) — center of the ±refineRadius thumb search
  provAnchor: number | null; // round(median(available{footPick,S2,S3})) — selects the xCross s1
  s1: ConsensusSignalPick; // xCross (nearest-anchor)
  s2: ConsensusSignalPick; // arm-vertical
  s3: ConsensusSignalPick; // wrist-lowest
  footPick: ConsensusSignalPick; // wrist-over-foot — provisional-anchor seed only
  xCross: number | null; // first sustained crossing sub-frame (pre nearest-anchor; headline)
  xCrossings: XCrossing[]; // ALL qualifying crossings (so the harness can log both-sign decoys)
  thumb: { crossFrame: number | null; subFrame: number | null; conf: number; qualifies: boolean };
  signFlip: number; // the sign actually used (override or nominal)
  lowReliability: boolean; // 0 geometric signals available
  window: [number, number];
}

function emptyPick(name: string): ConsensusSignalPick {
  return { name, frame: null, available: false, conf: NaN };
}

function emptyResult(signFlip: number, window: [number, number]): FaceOnImpactConsensus {
  return {
    final: null,
    source: "none",
    consensus: null,
    anchor: null,
    provAnchor: null,
    s1: emptyPick("S1 xCross"),
    s2: emptyPick("S2 arm-vertical"),
    s3: emptyPick("S3 wrist-lowest"),
    footPick: emptyPick("foot (anchor seed)"),
    xCross: null,
    xCrossings: [],
    thumb: { crossFrame: null, subFrame: null, conf: NaN, qualifies: false },
    signFlip,
    lowReliability: true,
    window,
  };
}

/**
 * Compute the face-on impact consensus over [lo,hi] on the given frames.
 * `signFlipOverride` forces the g/dx sign (the harness sweeps +1/−1 to LOCK it on ground truth);
 * omit in production to use the nominal RH(+1)/LH(−1) sign.
 */
export function computeFaceOnImpactConsensus(args: {
  frames: PoseFrame[];
  lo: number;
  hi: number;
  isLeftHanded: boolean;
  signFlipOverride?: number;
  // Capture rate for xcrossSustain / xcrossAnchorRadius / refineRadius (60fps fallback when absent).
  // (rollingMedian5's fixed ±2 window is a deferred 1c item.)
  msPerFrame?: number;
}): FaceOnImpactConsensus {
  const { frames, isLeftHanded } = args;
  const leadSide = isLeftHanded ? "right" : "left";
  const trailSide = isLeftHanded ? "left" : "right";
  const signFlip = args.signFlipOverride ?? (isLeftHanded ? -1 : 1);
  const last = frames.length - 1;
  if (last < 1) return emptyResult(signFlip, [0, 0]);
  const lo = clamp(args.lo, 0, last);
  const hi = clamp(args.hi, 0, last);
  if (lo >= hi) return emptyResult(signFlip, [lo, hi]);

  // 1b: rate-derived frame counts (fall back to the 60fps literals when msPerFrame absent).
  const mpf = args.msPerFrame;
  const sustainN = mpf != null ? msToFrames(C.xcrossSustainMs, mpf) : C.xcrossSustainFrames;
  const anchorRadiusN = mpf != null ? msToFrames(C.xcrossAnchorRadiusMs, mpf) : C.xcrossAnchorRadius;
  const refineRadiusN = mpf != null ? msToFrames(C.refineRadiusMs, mpf) : C.refineRadius;

  const leadWrist = toSeries(frames, `${leadSide}Wrist` as JointName);
  const trailWrist = toSeries(frames, `${trailSide}Wrist` as JointName);
  const leadShoulder = toSeries(frames, `${leadSide}Shoulder` as JointName);
  const trailShoulder = toSeries(frames, `${trailSide}Shoulder` as JointName);
  const leadElbow = toSeries(frames, `${leadSide}Elbow` as JointName);
  const leadAnkle = toSeries(frames, `${leadSide}Ankle` as JointName);
  const trailAnkle = toSeries(frames, `${trailSide}Ankle` as JointName);
  const leftWrist = toSeries(frames, "leftWrist");
  const rightWrist = toSeries(frames, "rightWrist");
  const leadFootMedX = rollingMedian5(leadAnkle.x);

  // wrist-below-shoulder gate (y grows downward → wrist below shoulder ⇒ wrist.y > shoulder.y)
  const gated = (f: number): boolean =>
    leadWrist.present[f] &&
    leadShoulder.present[f] &&
    Number.isFinite(leadWrist.y[f]) &&
    Number.isFinite(leadShoulder.y[f]) &&
    leadWrist.y[f] > leadShoulder.y[f];

  // footPick — wrist-over-foot (argmin |leadWristX − leadFootMedX|). Provisional-anchor SEED only.
  const footPick = pickExtreme(
    "foot (anchor seed)",
    lo,
    hi,
    (f) =>
      gated(f) && Number.isFinite(leadWrist.x[f]) && Number.isFinite(leadFootMedX[f])
        ? Math.abs(leadWrist.x[f] - leadFootMedX[f])
        : NaN,
    "min",
    (f) => Math.min(leadWrist.conf[f], leadAnkle.conf[f]),
  );

  // S2 — argmin |shoulderX−elbowX| + |elbowX−wristX|
  const s2 = pickExtreme(
    "S2 arm-vertical",
    lo,
    hi,
    (f) =>
      gated(f) &&
      Number.isFinite(leadShoulder.x[f]) &&
      Number.isFinite(leadElbow.x[f]) &&
      Number.isFinite(leadWrist.x[f])
        ? Math.abs(leadShoulder.x[f] - leadElbow.x[f]) + Math.abs(leadElbow.x[f] - leadWrist.x[f])
        : NaN,
    "min",
    (f) => Math.min(leadShoulder.conf[f], leadElbow.conf[f], leadWrist.conf[f]),
  );

  // S3 — argmax min(leftWristY, rightWristY) (both wrists lowest on screen)
  const s3 = pickExtreme(
    "S3 wrist-lowest",
    lo,
    hi,
    (f) =>
      gated(f) && Number.isFinite(leftWrist.y[f]) && Number.isFinite(rightWrist.y[f])
        ? Math.min(leftWrist.y[f], rightWrist.y[f])
        : NaN,
    "max",
    (f) => Math.min(leftWrist.conf[f], rightWrist.conf[f]),
  );

  // S1 = xCross — both-ankle-midpoint crossing of the better-confidence wrist.
  const leadMedX = rollingMedian5(leadAnkle.x);
  const trailMedX = rollingMedian5(trailAnkle.x);
  const feetMidX = (f: number) => (leadMedX[f] + trailMedX[f]) / 2;
  const selAt = (f: number): { x: number; conf: number; which: "lead" | "trail" | "none" } => {
    const lP = leadWrist.present[f];
    const tP = trailWrist.present[f];
    if (lP && tP)
      return leadWrist.conf[f] >= trailWrist.conf[f]
        ? { x: leadWrist.x[f], conf: leadWrist.conf[f], which: "lead" }
        : { x: trailWrist.x[f], conf: trailWrist.conf[f], which: "trail" };
    if (lP) return { x: leadWrist.x[f], conf: leadWrist.conf[f], which: "lead" };
    if (tP) return { x: trailWrist.x[f], conf: trailWrist.conf[f], which: "trail" };
    return { x: NaN, conf: NaN, which: "none" };
  };
  const rows: ImpactXRow[] = [];
  for (let f = lo; f <= hi; f++) {
    const sel = selAt(f);
    const mid = feetMidX(f);
    const g = Number.isFinite(sel.x) && Number.isFinite(mid) ? signFlip * (sel.x - mid) : NaN;
    rows.push({ frame: f, g, wristConf: sel.conf, selWrist: sel.which });
  }
  const xc = detectXCross(rows, C.xcrossLeadOffset, C.xcrossConfMin, sustainN);

  // provisional anchor = geometric consensus of the anchor-free signals (footPick/S2/S3).
  const provPicks = [footPick, s2, s3]
    .filter((s) => s.available && s.frame !== null)
    .map((s) => s.frame as number);
  const provConsensus =
    provPicks.length === 3
      ? median(provPicks)
      : provPicks.length === 2
        ? (provPicks[0] + provPicks[1]) / 2
        : provPicks.length === 1
          ? provPicks[0]
          : null;
  const provAnchor = provConsensus === null ? null : Math.round(provConsensus);

  // S1 = the xCross crossing nearest the provisional anchor within ±radius.
  const s1Cross = nearestAnchorCrossing(xc.crossings, provAnchor, anchorRadiusN);
  const s1: ConsensusSignalPick = {
    name: "S1 xCross",
    frame: s1Cross ? Math.round(s1Cross.sub) : null,
    available: s1Cross !== null && Number.isFinite(s1Cross.conf) && s1Cross.conf >= C.availConfMin,
    conf: s1Cross ? s1Cross.conf : NaN,
  };

  // consensus (graceful degradation) over S1/S2/S3.
  const availablePicks = [s1, s2, s3]
    .filter((s) => s.available && s.frame !== null)
    .map((s) => s.frame as number);
  let consensus: number | null;
  if (availablePicks.length === 3) consensus = median(availablePicks);
  else if (availablePicks.length === 2) consensus = (availablePicks[0] + availablePicks[1]) / 2;
  else if (availablePicks.length === 1) consensus = availablePicks[0];
  else consensus = null;
  const lowReliability = availablePicks.length === 0;
  const anchor = consensus === null ? null : Math.round(consensus);

  // thumb refine (same RAW-x dx = signFlip·(tipX − baseX); lead hand).
  const base = toSeries(frames, `${leadSide}Thumb` as JointName);
  const tip = toSeries(frames, `${leadSide}ThumbTip` as JointName);
  const dxAt = (f: number) => signFlip * (tip.x[f] - base.x[f]);
  const thumbConfOk = (f: number) =>
    base.present[f] &&
    tip.present[f] &&
    base.conf[f] >= C.thumbRefineConfMin &&
    tip.conf[f] >= C.thumbRefineConfMin;

  let crossFrame: number | null = null;
  let subFrame: number | null = null;
  let crossConf = NaN;
  if (anchor !== null) {
    for (let b = lo + 1; b <= hi; b++) {
      if (b < anchor - refineRadiusN || b > anchor + refineRadiusN) continue;
      const a = b - 1;
      const dxA = dxAt(a);
      const dxB = dxAt(b);
      const sustained = dxB >= 0 && b + 1 <= hi && dxAt(b + 1) >= 0; // ≥2 frames non-negative
      if (thumbConfOk(a) && thumbConfOk(b) && dxA < 0 && dxB >= 0 && sustained) {
        crossFrame = b;
        subFrame = a + -dxA / (dxB - dxA);
        crossConf = Math.min(base.conf[b], tip.conf[b]);
        break;
      }
    }
  }
  const qualifies = crossFrame !== null;

  let final: number | null;
  let source: "thumb" | "consensus" | "none";
  if (qualifies) {
    final = subFrame;
    source = "thumb";
  } else if (consensus !== null) {
    final = consensus;
    source = "consensus";
  } else {
    final = null;
    source = "none";
  }

  return {
    final,
    source,
    consensus,
    anchor,
    provAnchor,
    s1,
    s2,
    s3,
    footPick,
    xCross: xc.cross,
    xCrossings: xc.crossings,
    thumb: { crossFrame, subFrame, conf: crossConf, qualifies },
    signFlip,
    lowReliability,
    window: [lo, hi],
  };
}
