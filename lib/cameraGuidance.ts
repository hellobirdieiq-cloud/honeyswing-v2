/**
 * cameraGuidance.ts — camera-guidance color type.
 *
 * The live classification/smoothing logic that used to live here
 * (classifyCameraAngle / emaSmooth / extractShoulderSeparation) died with the
 * record-screen frame processor and was deleted in the 2026-07 dead-code
 * sweep (efficiency-audit Fix 9). What remains is the color vocabulary shared
 * by the (currently inert) guidance UI and the swing_debug persistence keys
 * (camera_angle_at_start / camera_guidance_color).
 */

export type CameraGuidanceColor = 'good' | 'borderline' | 'poor';
