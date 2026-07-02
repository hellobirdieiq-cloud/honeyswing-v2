/**
 * swingStartDetection.ts — Slot B refinement of phase-detected address index.
 *
 * Given canonical (handedness-normalized) frames and the heuristic phases.address /
 * phases.top from phaseDetection.ts, this module deterministically finds:
 *   - trueAddressFrame: the latest 8-frame stillness window before takeaway
 *   - trueSwingStartFrame: the first frame after address with consistent motion
 *
 * It refines on top of phase detection — it does not re-detect phases.
 * cameraAngle is passed in (not computed here) so this stays a pure rule.
 *
 * Reliability is HIGH only when both windows are detected cleanly; otherwise LOW.
 * The pipeline only overrides addressFrameIdx on HIGH (MED treated as LOW).
 */

import type { PoseFrame } from "../../pose/PoseTypes";
import { calculateGolfAngles } from "./angles";
import { msToFrames, scalePerFrameFloor } from "./phaseDetectionShared";

export type SwingStartResult = {
  trueAddressFrame: number;
  trueSwingStartFrame: number;
  reliability: "HIGH" | "MED" | "LOW";
};

// DTL V3 thresholds (frame literals kept as 60fps fallbacks; *_MS are the rate-independent forms)
const ADDRESS_WINDOW = 8;             // frames in the stillness window
const ADDRESS_WINDOW_MS = 133;        // 1b: ms sibling of ADDRESS_WINDOW (8 @ 60fps)
const ADDRESS_TOP_BUFFER = 20;         // earliest E starts at phases.top - 20
const ADDRESS_TOP_BUFFER_MS = 333;    // 1b: ms sibling of ADDRESS_TOP_BUFFER (20 @ 60fps)
const ADDRESS_MIN_E = 7;               // smallest E allowed (window [0..7])
const ADDRESS_MIN_E_MS = 117;         // 1b: ms sibling of ADDRESS_MIN_E (7 @ 60fps)
const SPINE_RANGE_MAX_DEG = 1.5;
const KNEE_RANGE_MAX_DEG = 2.0;
const HEAD_DELTA_MAX = 0.006;          // per-frame |Δ noseX|

const SPINE_DELTA_MIN_DEG = 1.0;       // motion threshold from address
const KNEE_DELTA_MIN_DEG = 1.5;        // motion threshold from address
const START_WINDOW = 3;                // frames evaluated per F (60fps fallback)
const START_WINDOW_MS = 50;            // 1b: ms sibling of START_WINDOW (3 @ 60fps)

function spineOf(frame: PoseFrame | undefined): number | null {
  if (!frame) return null;
  return calculateGolfAngles(frame).spineAngle;
}

function kneeOf(frame: PoseFrame | undefined): number | null {
  if (!frame) return null;
  return calculateGolfAngles(frame).leftKneeAngle;
}

function noseXOf(frame: PoseFrame | undefined): number | null {
  if (!frame) return null;
  const x = frame.joints.nose?.x;
  return x == null ? null : x;
}

function sign(v: number): -1 | 0 | 1 {
  if (v > 0) return 1;
  if (v < 0) return -1;
  return 0;
}

function detectAddressDTL(
  frames: PoseFrame[],
  topIdx: number,
  // Rate for the stillness window / top-buffer / min-E (falls back to 60fps literals).
  msPerFrame?: number,
): { idx: number; detected: boolean } {
  const addrWindow = msPerFrame != null ? msToFrames(ADDRESS_WINDOW_MS, msPerFrame) : ADDRESS_WINDOW;
  const addrTopBuffer = msPerFrame != null ? msToFrames(ADDRESS_TOP_BUFFER_MS, msPerFrame) : ADDRESS_TOP_BUFFER;
  const addrMinE = msPerFrame != null ? msToFrames(ADDRESS_MIN_E_MS, msPerFrame) : ADDRESS_MIN_E;
  const headMax = scalePerFrameFloor(HEAD_DELTA_MAX, msPerFrame); // 1b-2: per-ms head-still floor
  const eStartRaw = topIdx - addrTopBuffer;
  const eStart = Math.min(eStartRaw, frames.length - 1);
  const eEnd = addrMinE;
  if (eStart < eEnd) return { idx: -1, detected: false };

  for (let E = eStart; E >= eEnd; E--) {
    const start = Math.max(0, E - (addrWindow - 1));
    const end = Math.min(frames.length - 1, E);
    if (end - start + 1 < addrWindow) continue;

    const spines: number[] = [];
    const knees: number[] = [];
    const noses: number[] = [];
    let invalid = false;
    for (let i = start; i <= end; i++) {
      const s = spineOf(frames[i]);
      const k = kneeOf(frames[i]);
      const n = noseXOf(frames[i]);
      if (s == null || k == null || n == null) {
        invalid = true;
        break;
      }
      spines.push(s);
      knees.push(k);
      noses.push(n);
    }
    if (invalid) continue;

    const spineRange = Math.max(...spines) - Math.min(...spines);
    const kneeRange = Math.max(...knees) - Math.min(...knees);
    if (spineRange >= SPINE_RANGE_MAX_DEG) continue;
    if (kneeRange >= KNEE_RANGE_MAX_DEG) continue;

    let headOk = true;
    for (let k = 0; k < noses.length - 1; k++) {
      if (Math.abs(noses[k + 1] - noses[k]) >= headMax) {
        headOk = false;
        break;
      }
    }
    if (!headOk) continue;

    return { idx: E, detected: true };
  }
  return { idx: -1, detected: false };
}

function detectStartDTL(
  frames: PoseFrame[],
  addressIdx: number,
  topIdx: number,
  // Rate for the per-F evaluation window (falls back to the 60fps literal).
  msPerFrame?: number,
): { idx: number; detected: boolean } {
  const startWin = msPerFrame != null ? Math.max(1, msToFrames(START_WINDOW_MS, msPerFrame)) : START_WINDOW;
  const addrSpine = spineOf(frames[addressIdx]);
  const addrKnee = kneeOf(frames[addressIdx]);
  const addrNose = noseXOf(frames[addressIdx]);
  if (addrSpine == null || addrKnee == null || addrNose == null) {
    return { idx: -1, detected: false };
  }

  const fStart = Math.max(0, addressIdx + 1);
  const fEnd = Math.min(frames.length - 1 - (startWin - 1), topIdx - 2);
  if (fStart > fEnd) return { idx: -1, detected: false };

  for (let F = fStart; F <= fEnd; F++) {
    const spines: (number | null)[] = [];
    const knees: (number | null)[] = [];
    const noses: (number | null)[] = [];
    for (let i = 0; i < startWin; i++) {
      spines.push(spineOf(frames[F + i]));
      knees.push(kneeOf(frames[F + i]));
      noses.push(noseXOf(frames[F + i]));
    }

    let spinePass = false;
    if (spines.every((v): v is number => v != null)) {
      const deltas = spines.map(v => v - addrSpine);
      const head = deltas[0];
      const consistent =
        sign(deltas[0]) !== 0 &&
        sign(deltas[0]) === sign(deltas[1]) &&
        sign(deltas[1]) === sign(deltas[2]);
      spinePass = Math.abs(head) > SPINE_DELTA_MIN_DEG && consistent;
    }

    let kneePass = false;
    if (knees.every((v): v is number => v != null)) {
      const deltas = knees.map(v => v - addrKnee);
      const head = deltas[0];
      const consistent =
        sign(deltas[0]) !== 0 &&
        sign(deltas[0]) === sign(deltas[1]) &&
        sign(deltas[1]) === sign(deltas[2]);
      kneePass = Math.abs(head) > KNEE_DELTA_MIN_DEG && consistent;
    }

    let headPass = false;
    if (noses.every((v): v is number => v != null)) {
      const deltas = noses.map(v => v - addrNose);
      const consistent =
        sign(deltas[0]) !== 0 &&
        sign(deltas[0]) === sign(deltas[1]) &&
        sign(deltas[1]) === sign(deltas[2]);
      headPass = consistent;
    }

    const passes = (spinePass ? 1 : 0) + (kneePass ? 1 : 0) + (headPass ? 1 : 0);
    if (passes >= 2) return { idx: F, detected: true };
  }
  return { idx: -1, detected: false };
}

/**
 * Refine phase-detected address/start using a deterministic DTL rule.
 * `phases` carries the heuristic indices from phaseDetection — never modified here.
 * `cameraAngle` is supplied by the caller (`detectCameraAngle` is not invoked here).
 */
export function detectSwingStart(
  frames: PoseFrame[],
  phases: { address: number; top: number },
  // Accepted for API symmetry; canonical frames are already handedness-normalized.
  isLeftHanded: boolean,
  cameraAngle: "face_on" | "dtl" | "unknown",
  // Capture rate, threaded to detectAddressDTL/detectStartDTL. Optional: tests omit it (60fps fallback).
  msPerFrame?: number,
): SwingStartResult {
  if (cameraAngle === "face_on") {
    // EXTERNAL_ASSUMPTION: face-on address = phase-detected address
    // (N=0 validated swings per Phase Detection Rules doc —
    // validate at clinic before relying on face-on tempo accuracy)
    return {
      trueAddressFrame: phases.address,
      trueSwingStartFrame: phases.address + 1,
      reliability: "HIGH",
    };
  }

  const addr = detectAddressDTL(frames, phases.top, msPerFrame);
  if (!addr.detected) {
    return {
      trueAddressFrame: phases.address,
      trueSwingStartFrame: phases.address + 1,
      reliability: "LOW",
    };
  }

  const start = detectStartDTL(frames, addr.idx, phases.top, msPerFrame);
  if (!start.detected) {
    return {
      trueAddressFrame: addr.idx,
      trueSwingStartFrame: addr.idx + 1,
      reliability: "LOW",
    };
  }

  return {
    trueAddressFrame: addr.idx,
    trueSwingStartFrame: start.idx,
    reliability: "HIGH",
  };
}
