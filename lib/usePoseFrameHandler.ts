// usePoseFrameHandler.ts — STUBBED for RTMW migration.
// MARKED FOR DELETION in the post-RTMW MediaPipe-cleanup pass.
// CaptureFrameStats and helpers retained because lib/persistSwing.ts (PROTECTED) imports them.
// Byte-shape-identical exports are intentional.
export interface CaptureFrameStats {
  total_callbacks: number;
  nonzero_landmark_frames: number;
}

let totalCallbacks = 0;
let nonzeroLandmarkFrames = 0;

export function resetCaptureFrameStats(): void {
  totalCallbacks = 0;
  nonzeroLandmarkFrames = 0;
}

export function getCaptureFrameStats(): CaptureFrameStats {
  return {
    total_callbacks: totalCallbacks,
    nonzero_landmark_frames: nonzeroLandmarkFrames,
  };
}
