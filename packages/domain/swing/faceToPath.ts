/**
 * faceToPath.ts — Pure mapping from LeadWristHinge × SyntheticClubheadPath
 * into face/path categories and a 3×3 ball-flight label.
 *
 * Used for swing_debug only in this iteration. A result-screen card ships in a
 * follow-up after clinic calibration validates the underlying thresholds.
 */
import type { LeadWristHinge, WristHingeCategory } from "./wristHinge";
import type { SyntheticClubheadPath, ClubheadPathCategory } from "./syntheticClubheadPath";

export type FaceCategory = "open" | "square" | "closed";
export type FaceToPathDelta = "open" | "square" | "closed";

export type BallFlightLabel =
  | "straight"
  | "push"
  | "pull"
  | "fade"
  | "draw"
  | "slice"
  | "hook"
  | "push-draw"
  | "pull-fade";

export type FaceToPath = {
  faceCategory: FaceCategory;
  pathCategory: ClubheadPathCategory;
  faceToPathDelta: FaceToPathDelta;
  ballFlightLabel: BallFlightLabel;
};

function faceFromHinge(category: WristHingeCategory): FaceCategory {
  if (category === "cupped") return "open";
  if (category === "bowed") return "closed";
  return "square";
}

// Face row × path column → ballFlightLabel.
// Rows: open, square, closed. Columns: in-to-out, square, out-to-in.
//
//                 in-to-out   square      out-to-in
//   open          push        fade        slice
//   square        push-draw   straight    pull-fade
//   closed        hook        draw        pull
const BALL_FLIGHT_TABLE: Record<FaceCategory, Record<ClubheadPathCategory, BallFlightLabel>> = {
  open: {
    "in-to-out": "push",
    square: "fade",
    "out-to-in": "slice",
  },
  square: {
    "in-to-out": "push-draw",
    square: "straight",
    "out-to-in": "pull-fade",
  },
  closed: {
    "in-to-out": "hook",
    square: "draw",
    "out-to-in": "pull",
  },
};

// Ordinals for "face vs path" delta: face ordinal − path ordinal.
//   face: open = +1, square = 0, closed = −1
//   path: in-to-out = +1, square = 0, out-to-in = −1
// Positive sum ⇒ face open to path; negative ⇒ face closed to path; zero ⇒ square.
const FACE_ORDINAL: Record<FaceCategory, number> = { open: 1, square: 0, closed: -1 };
const PATH_ORDINAL: Record<ClubheadPathCategory, number> = { "in-to-out": 1, square: 0, "out-to-in": -1 };

function faceToPathDeltaFor(face: FaceCategory, path: ClubheadPathCategory): FaceToPathDelta {
  const delta = FACE_ORDINAL[face] - PATH_ORDINAL[path];
  if (delta > 0) return "open";
  if (delta < 0) return "closed";
  return "square";
}

export function computeFaceToPath(
  hinge: LeadWristHinge,
  path: SyntheticClubheadPath,
): FaceToPath {
  const faceCategory = faceFromHinge(hinge.category);
  const pathCategory = path.category;
  return {
    faceCategory,
    pathCategory,
    faceToPathDelta: faceToPathDeltaFor(faceCategory, pathCategory),
    ballFlightLabel: BALL_FLIGHT_TABLE[faceCategory][pathCategory],
  };
}
