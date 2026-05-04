-- CAM-ANGLE-VAL: per-swing camera-angle validity flag.
-- Nullable, no DEFAULT, no NOT NULL constraint, no backfill. Inherits public.swings RLS.
ALTER TABLE public.swings
  ADD COLUMN camera_angle_valid boolean;

COMMENT ON COLUMN public.swings.camera_angle_valid IS
  'CAM-ANGLE-VAL: true if camera angle classified as front or side at address; false if classifier returned "unknown" (or sequence had no usable frames). NULL = pre-deploy rows.';
