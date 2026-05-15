-- Add raw gravity vector captured during swing. Stores averaged [x,y,z] accelerometer
-- reading across the capture window. NULL for historical rows. Inherits existing public.swings RLS.
ALTER TABLE public.swings
  ADD COLUMN gravity_vector jsonb;

COMMENT ON COLUMN public.swings.gravity_vector IS
  'Averaged accelerometer gravity vector {x, y, z} captured during swing recording. NULL for pre-migration rows.';
