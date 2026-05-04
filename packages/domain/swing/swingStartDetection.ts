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

export type SwingStartResult = {
  trueAddressFrame: number;
  trueSwingStartFrame: number;
  reliability: "HIGH" | "MED" | "LOW";
};

// DTL V3 thresholds
const ADDRESS_WINDOW = 8;             // frames in the stillness window
const ADDRESS_TOP_BUFFER = 20;         // earliest E starts at phases.top - 20
const ADDRESS_MIN_E = 7;               // smallest E allowed (window [0..7])
const SPINE_RANGE_MAX_DEG = 1.5;
const KNEE_RANGE_MAX_DEG = 2.0;
const HEAD_DELTA_MAX = 0.006;          // per-frame |Δ noseX|

const SPINE_DELTA_MIN_DEG = 1.0;       // motion threshold from address
const KNEE_DELTA_MIN_DEG = 1.5;        // motion threshold from address
const START_WINDOW = 3;                // frames evaluated per F

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
): { idx: number; detected: boolean } {
  const eStartRaw = topIdx - ADDRESS_TOP_BUFFER;
  const eStart = Math.min(eStartRaw, frames.length - 1);
  const eEnd = ADDRESS_MIN_E;
  if (eStart < eEnd) return { idx: -1, detected: false };

  for (let E = eStart; E >= eEnd; E--) {
    const start = Math.max(0, E - (ADDRESS_WINDOW - 1));
    const end = Math.min(frames.length - 1, E);
    if (end - start + 1 < ADDRESS_WINDOW) continue;

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
      if (Math.abs(noses[k + 1] - noses[k]) >= HEAD_DELTA_MAX) {
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
): { idx: number; detected: boolean } {
  const addrSpine = spineOf(frames[addressIdx]);
  const addrKnee = kneeOf(frames[addressIdx]);
  const addrNose = noseXOf(frames[addressIdx]);
  if (addrSpine == null || addrKnee == null || addrNose == null) {
    return { idx: -1, detected: false };
  }

  const fStart = Math.max(0, addressIdx + 1);
  const fEnd = Math.min(frames.length - 1 - (START_WINDOW - 1), topIdx - 2);
  if (fStart > fEnd) return { idx: -1, detected: false };

  for (let F = fStart; F <= fEnd; F++) {
    const spines: (number | null)[] = [];
    const knees: (number | null)[] = [];
    const noses: (number | null)[] = [];
    for (let i = 0; i < START_WINDOW; i++) {
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- accepted for API symmetry; canonical frames are already handedness-normalized
  isLeftHanded: boolean,
  cameraAngle: "front" | "side" | "unknown",
): SwingStartResult {
  if (cameraAngle === "front") {
    return {
      trueAddressFrame: phases.address,
      trueSwingStartFrame: phases.address + 1,
      reliability: "LOW",
    };
  }

  const addr = detectAddressDTL(frames, phases.top);
  if (!addr.detected) {
    return {
      trueAddressFrame: phases.address,
      trueSwingStartFrame: phases.address + 1,
      reliability: "LOW",
    };
  }

  const start = detectStartDTL(frames, addr.idx, phases.top);
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
