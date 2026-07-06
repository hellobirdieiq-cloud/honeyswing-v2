/**
 * faceOnGuideSizing.ts — per-age-tier sizing for the Record-screen setup guide.
 *
 * Pure module (no react-native import) so the fraction map is testable under
 * the node test runner, same reason skeletonProjection.ts lives beside
 * SwingSkeletonCanvas. FaceOnSetupOverlay.tsx is the only render consumer;
 * no other file may hardcode a guide fraction.
 */

import type { AgeTier } from '@/packages/domain/swing/tipFrequency';

// EXTERNAL ASSUMPTION — untuned, pending on-device calibration.
// Guide height as a fraction of the camera-preview height (containerH), per age
// tier of the active player. adult = 0.57 preserves the prior single-fraction
// behavior exactly (the only tuned value; ≈70% of the pre-0.57 full-height build).
export const GUIDE_HEIGHT_FRACTION_BY_TIER: Record<AgeTier, number> = {
  junior: 0.4, // EXTERNAL ASSUMPTION — untuned
  youth: 0.46, // EXTERNAL ASSUMPTION — untuned
  teen: 0.52, // EXTERNAL ASSUMPTION — untuned
  adult: 0.57, // prior GUIDE_HEIGHT_FRACTION (the only tuned value)
};
