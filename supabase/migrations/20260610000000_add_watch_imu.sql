-- Add raw wrist IMU stream captured from a paired Apple Watch during the swing.
-- Stores the full per-swing array [{t,ax,ay,az,gx,gy,gz}] (watch boot-relative ms;
-- NOT aligned to pose timestamps). NULL for historical rows and whenever no watch is
-- paired / the capture toggle is off. Summary lives in swing_debug.watch_imu.
-- Inherits existing public.swings RLS.
ALTER TABLE public.swings
  ADD COLUMN watch_imu jsonb;

COMMENT ON COLUMN public.swings.watch_imu IS
  'Raw per-swing wrist IMU stream [{t,ax,ay,az,gx,gy,gz}] from paired Apple Watch (watch boot-relative ms; NOT aligned to pose timestamps). NULL when no watch / toggle off. Summary in swing_debug.watch_imu.';
